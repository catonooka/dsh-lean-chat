/**
 * @deepseek-ai/dsh-chat-app — the chat bundle's runtime glue plugin. It serves
 * the built chat frontend dist on the webserver fallback seat, exposes a small
 * local JSON API over `/api` (session list, history, message send with SSE
 * streaming, stop), and drives agents directly through `ctx.agents` and
 * `ctx.sessionQuery` — no client module system, no settings surface.
 *
 * Wire protocol (SSE `data:` payloads, one JSON object per line):
 * - `{t:'user', text}` — the durable user message entering the surface
 * - `{t:'delta', text}` — one live assistant text delta
 * - `{t:'assistant', text}` — the committed assistant message (final text)
 * - `{t:'tool-start', name, query}` — a tool call started
 * - `{t:'tool-end', meta, isError}` — a tool call settled; `meta` carries the
 *   tiny search tool's structured result (query, searchQuestion, sources,
 *   searchedAt) when the call was a `web_search`
 * - `{t:'status', status}` — agent `running`/`idle`
 * - `{t:'turn-end', reason}` — the turn closed; the stream ends after this
 * - `{t:'error', message}` — a turn error was reported
 *
 * @module @deepseek-ai/dsh-chat-app
 */

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, ReasoningEffortId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'chat-app'

/** Services required before the chat surface can mount. */
export const inject = ['webServer', 'agents', 'sessionQuery']

/** Plugin config: browser handoff, URL line, and the conversation model route. */
export interface Config {
  /** Open the default browser after startup. */
  openBrowser: boolean
  /** Print the URL line on activation. */
  printUrl: boolean
  /** Provider route for conversation agents. */
  provider: string
  /** Model id for conversation agents. */
  model: string
  /** Adapter reasoning effort for conversation agents (thinking level). */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Sampling temperature applied to every conversation request. */
  temperature?: number
}

export const Config: z<Config> = z.object({
  openBrowser: z.boolean().default(true),
  printUrl: z.boolean().default(true),
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-chat'),
  reasoningEffort: z.union([z.const('off'), z.const('low'), z.const('high'), z.const('max')]),
  temperature: z.number().min(0).max(2),
})

/** Display-only loopback host for the URL line; the webserver schema is the source of truth. */
const LOOPBACK_HOST = '127.0.0.1'

/** Largest accepted JSON request body. */
const MAX_BODY_BYTES = 1_000_000

/** Largest single source list retained in a projected history item. */
const MAX_TOOL_SOURCES = 8

const HTML_MIME = 'text/html; charset=utf-8'

const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/** One projected chat item served to the browser. */
export interface ChatItem {
  role: 'user' | 'assistant' | 'tool'
  text?: string
  name?: string
  query?: string
  searchQuestion?: string
  searchedAt?: string
  sources?: { url: string; title?: string; publishedAt?: string }[]
}

/** Read and parse one JSON request body, size-capped. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** Send one JSON response. */
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** Whether one request is local: a loopback Host and, when present, a loopback Origin. */
function isLocalRequest(req: IncomingMessage): boolean {
  const hostname = (req.headers.host ?? '').toLowerCase().split(':')[0] ?? ''
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const originHost = new URL(origin).hostname.toLowerCase()
    return originHost === '127.0.0.1' || originHost === 'localhost' || originHost === '::1'
  } catch {
    return false
  }
}

/** Extract the joined text of one message's content blocks. */
function textOf(content: readonly ContentBlock[] | undefined): string {
  if (content === undefined) return ''
  let text = ''
  for (const block of content) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/**
 * Project one session event into a browser chat item, or `undefined` for
 * events the chat UI does not render.
 * @param event - one session event (a surface event from `readSurface`, or a
 *   live dispatch of a message-producing type).
 * @returns the projected item.
 */
export function projectSurfaceEvent(event: SessionEvent): ChatItem | undefined {
  switch (event.type) {
    case 'user/message': {
      const text = textOf(event.data.content)
      // Queue bookkeeping can produce empty user payloads; nothing to render.
      if (text === '') return undefined
      return { role: 'user', text }
    }
    case 'assistant/message': {
      const text = textOf(event.data.message.content)
      // A tool-call-only assistant message renders nothing in a chat surface.
      if (text === '') return undefined
      return { role: 'assistant', text }
    }
    case 'tool/result': {
      const item: ChatItem = { role: 'tool', name: 'web_search' }
      const meta = event.data.meta
      if (typeof meta === 'object' && meta !== null && !Array.isArray(meta)) {
        const record = meta as Record<string, unknown>
        if (typeof record.query === 'string') item.query = record.query
        if (typeof record.searchQuestion === 'string') item.searchQuestion = record.searchQuestion
        if (typeof record.searchedAt === 'string') item.searchedAt = record.searchedAt
        if (Array.isArray(record.sources)) {
          item.sources = record.sources
            .filter((source): source is { url: string; title?: string; publishedAt?: string } => {
              if (typeof source !== 'object' || source === null || Array.isArray(source)) return false
              const candidate = source as Record<string, unknown>
              return typeof candidate.url === 'string'
                && (candidate.title === undefined || typeof candidate.title === 'string')
                && (candidate.publishedAt === undefined || typeof candidate.publishedAt === 'string')
            })
            .slice(0, MAX_TOOL_SOURCES)
        }
      }
      if (item.searchQuestion === undefined && item.query === undefined) {
        item.text = textOf(event.data.message.content).slice(0, 200)
      }
      return item
    }
    default:
      return undefined
  }
}

/**
 * Dist location is workspace knowledge of this bundle: anchored on the
 * frontend package manifest, never user config. A readable index is a
 * request-time concern, but a checkout without `pnpm run build` has no page:
 * fail activation with the build hint instead of a confusing runtime 404.
 */
function resolveDistRoot(): string {
  const require = createRequire(import.meta.url)
  try {
    return join(dirname(require.resolve('@deepseek-ai/dsh-chat-frontend/package.json')), 'dist')
  } catch {
    throw new Error(
      'chat-app: @deepseek-ai/dsh-chat-frontend is not resolvable from this composition; '
      + 'run `pnpm run build` in the repository checkout first',
    )
  }
}

/** Whether the served path escapes the dist root. */
function escapesRoot(distRoot: string, target: string): boolean {
  const root = resolve(distRoot)
  return target !== root && !target.startsWith(root + sep)
}

/** Serve the built dist over the fallback seat: assets by MIME, `/` as index. */
async function serveStatic(req: IncomingMessage, res: ServerResponse, distRoot: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  if (pathname === '/') pathname = '/index.html'
  const target = resolve(distRoot, `.${pathname}`)
  if (escapesRoot(distRoot, target)) {
    res.writeHead(403)
    res.end()
    return
  }
  try {
    const info = await stat(target)
    if (!info.isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    const body = req.method === 'HEAD' ? undefined : await readFile(target)
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'content-length': String(info.size),
    })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end()
  }
}

/**
 * Mount the chat surface: the `/api` routes, the SSE hub, the static fallback,
 * the URL line, and the default-browser handoff.
 * @param ctx - plugin context carrying the webServer, agents, and sessionQuery services.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const distRoot = resolveDistRoot()
  const handles = new Map<string, AgentHandle>()
  const streams = new Map<string, Set<ServerResponse>>()

  /** Send one SSE payload to every open stream of one session. */
  function broadcast(sessionId: string, payload: Record<string, unknown>): void {
    const open = streams.get(sessionId)
    if (open === undefined || open.size === 0) return
    const line = `data: ${JSON.stringify(payload)}\n\n`
    for (const res of [...open]) {
      try {
        res.write(line)
      } catch {
        open.delete(res)
      }
    }
    if (open.size === 0) streams.delete(sessionId)
  }

  /** Resolve one agent by session id, creating (or resuming) it on demand. */
  async function getOrCreateAgent(sessionId: string): Promise<AgentHandle> {
    const existing = handles.get(sessionId)
    if (existing !== undefined && ctx.agents.get(existing.agent.id) === existing.agent) return existing
    const handle = await ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: process.cwd() },
      agentOptions: {
        provider: config.provider,
        model: config.model,
        ...config.reasoningEffort !== undefined ? { reasoningEffort: ReasoningEffortId(config.reasoningEffort) } : {},
      },
    })
    handles.set(sessionId, handle)
    ctx.effect(() => () => {
      void handle.dispose()
      handles.delete(sessionId)
    }, `chat-app.agent.${sessionId}`)
    return handle
  }

  // Sampling is request-level, not agent identity: patch the frozen call
  // config on its way out so every conversation request carries the
  // configured temperature (the generator's hand-built call is untouched).
  const temperature = config.temperature
  if (temperature !== undefined) {
    ctx.on('agent/request', async (_payload, next) => ({ ...(await next()), temperature }))
  }

  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)
    switch (event.type) {
      case 'user/message':
        broadcast(sessionId, { t: 'user', text: textOf(event.data.content) })
        break
      case 'assistant/message':
        broadcast(sessionId, { t: 'assistant', text: textOf(event.data.message.content) })
        break
      case 'tool/call': {
        let query: string | undefined
        try {
          const parsed: unknown = JSON.parse(event.data.arguments)
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            const value = (parsed as Record<string, unknown>).query
            if (typeof value === 'string') query = value
          }
        } catch {
          // Leave the query unset; tool-end carries the structured meta anyway.
        }
        broadcast(sessionId, { t: 'tool-start', name: event.data.name, ...query !== undefined ? { query } : {} })
        break
      }
      case 'tool/result': {
        const projected = projectSurfaceEvent(event)
        broadcast(sessionId, {
          t: 'tool-end',
          ...projected !== undefined
            ? {
              name: projected.name,
              ...projected.query !== undefined ? { query: projected.query } : {},
              ...projected.searchQuestion !== undefined ? { searchQuestion: projected.searchQuestion } : {},
              ...projected.searchedAt !== undefined ? { searchedAt: projected.searchedAt } : {},
              ...projected.sources !== undefined ? { sources: projected.sources } : {},
              ...projected.text !== undefined ? { text: projected.text } : {},
            }
            : {},
          isError: event.data.error !== undefined,
        })
        break
      }
      case 'turn/end': {
        broadcast(sessionId, { t: 'turn-end', reason: event.data.reason.kind })
        const open = streams.get(sessionId)
        if (open !== undefined) {
          for (const res of [...open]) {
            try {
              res.end()
            } catch {
              // The socket is already gone; nothing to flush.
            }
          }
          streams.delete(sessionId)
        }
        break
      }
      default:
        break
    }
  })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type !== 'chunk' || frame.chunk.type !== 'text-delta') return
    broadcast(String(agent.session.id), { t: 'delta', text: frame.chunk.text })
  })

  ctx.on('agent/status', ({ agent, status }) => {
    broadcast(String(agent.session.id), { t: 'status', status })
  })

  ctx.on('agent/error', ({ agent, error }) => {
    broadcast(String(agent.session.id), {
      t: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  })

  ctx.webServer.register({
    kind: 'prefix',
    path: '/api',
    handler: (req, res) => void handleApi(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) sendJson(res, 400, { error: message })
      else res.destroy()
    }),
  })

  async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLocalRequest(req)) {
      sendJson(res, 403, { error: 'local requests only' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const parts = url.pathname.split('/').filter(segment => segment !== '')
    // parts[0] is 'api' (the registered prefix).
    if (parts.length >= 1 && parts[0] === 'api') parts.shift()

    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'config') {
      sendJson(res, 200, {
        provider: config.provider,
        model: config.model,
        ...config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {},
        ...config.temperature !== undefined ? { temperature: config.temperature } : {},
      })
      return
    }

    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'sessions') {
      const records = await ctx.sessionQuery.listSessions()
      const roots = records.filter(record => record.header.origin !== 'subagent')
      const titles = await ctx.sessionQuery.readTitleSnapshots(roots.map(record => record.header.id))
      const titleOf = new Map<string, { text: string; updatedAt: number } | undefined>()
      for (const entry of titles) {
        if (entry.status !== 'fulfilled') continue
        const snapshot = entry.value.title
        titleOf.set(String(entry.sessionId), snapshot === undefined
          ? undefined
          : { text: snapshot.title, updatedAt: snapshot.updatedAt })
      }
      sendJson(res, 200, {
        sessions: roots.map((record) => {
          const id = String(record.header.id)
          const title = titleOf.get(id)
          return {
            id,
            title: title?.text ?? 'New chat',
            createdAt: record.header.createdAt,
            updatedAt: title?.updatedAt ?? record.header.createdAt,
            live: record.live,
          }
        }),
      })
      return
    }

    if (parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'messages') {
      const sessionId = parts[1] as string
      if (!/^[a-zA-Z0-9-]{1,64}$/.test(sessionId)) {
        sendJson(res, 400, { error: 'invalid session id' })
        return
      }
      if (req.method === 'GET') {
        const surface = await ctx.sessionQuery.readSurface(SessionId(sessionId))
        const items: ChatItem[] = []
        for (const event of surface.events) {
          const projected = projectSurfaceEvent(event)
          if (projected !== undefined) items.push(projected)
        }
        sendJson(res, 200, { sessionId, items })
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const text = body.text
        if (typeof text !== 'string' || text.trim().length === 0) {
          sendJson(res, 400, { error: 'text must be a non-empty string' })
          return
        }
        const handle = await getOrCreateAgent(sessionId)
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(':connected\n\n')
        let open = streams.get(sessionId)
        if (open === undefined) {
          open = new Set()
          streams.set(sessionId, open)
        }
        open.add(res)
        res.on('close', () => {
          const current = streams.get(sessionId)
          if (current === undefined) return
          current.delete(res)
          if (current.size === 0) streams.delete(sessionId)
        })
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
        return
      }
      sendJson(res, 405, { allow: 'GET, POST' })
      return
    }

    if (req.method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'stop') {
      const sessionId = parts[1] as string
      const handle = handles.get(sessionId)
      if (handle !== undefined) handle.agent.cancel({ kind: 'user' })
      sendJson(res, 200, { stopped: handle !== undefined })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  ctx.webServer.registerFallback((req, res) => {
    if (!isLocalRequest(req)) {
      res.writeHead(403)
      res.end()
      return
    }
    void serveStatic(req, res, distRoot).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500)
        res.end()
      } else {
        res.destroy()
      }
    })
  })

  const url = `http://${LOOPBACK_HOST}:${String(ctx.webServer.port)}`
  if (config.printUrl) console.log(`dsh chat: ${url}`)
  if (config.openBrowser) {
    console.log('dsh chat: opening the default browser; pass --no-open to disable')
    void import('open')
      .then(async ({ default: open }) => open(url))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        console.error(`chat-app: could not open the default browser because ${reason}; use the dsh chat URL printed at startup`)
      })
  }
}

export { randomUUID as newChatSessionId }
