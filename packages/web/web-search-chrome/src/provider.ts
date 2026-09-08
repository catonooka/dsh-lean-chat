/**
 * The user-Chrome search provider: drives the user's real Chrome over the
 * DevTools protocol so a search sees their logged-in sessions — personalized
 * Google results, and X/Twitter search through their own account. Zero
 * dependencies: the platform `fetch` and `WebSocket` talk CDP directly.
 * @module @deepseek-ai/dsh-web-search-chrome/provider
 */

import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult, type WebSearchSource } from '@deepseek-ai/dsh-web'

/** Stable provider id, registered with `ctx.web.registerSearchProvider`. */
export const CHROME_PROVIDER_ID = 'user-chrome'

/** Which general search engine runs inside the user's Chrome. */
export type WebEngine = 'google' | 'bing' | 'duckduckgo'

/** Where one search runs. */
export interface SearchRoute {
  kind: 'x' | 'web'
  /** The search question as typed for that engine (site:/x: markers stripped). */
  query: string
  /** The URL to navigate the tab to. */
  url: string
}

/** Search-URL builders for the general engines. */
const WEB_ENGINE_URL: Record<WebEngine, (query: string) => string> = {
  google: query => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  bing: query => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  duckduckgo: query => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
}

/**
 * Decide where a query searches. An `x:` prefix or a `site:x.com` /
 * `site:twitter.com` marker routes to the user's logged-in X search (X query
 * operators like `from:me` pass straight through); anything else searches the
 * configured general engine in the user's Chrome.
 * @param query - the model-supplied search query.
 * @param engine - which general engine non-X searches use.
 * @returns the route for this search.
 */
export function routeSearchTarget(query: string, engine: WebEngine = 'google'): SearchRoute {
  const xSearch = (q: string): SearchRoute => ({
    kind: 'x',
    query: q,
    url: `https://x.com/search?q=${encodeURIComponent(q)}&f=live`,
  })
  if (query.toLowerCase().startsWith('x:')) {
    const rest = query.slice(2).trim()
    if (rest !== '') return xSearch(rest)
  }
  const site = query.match(/\bsite:(?:x\.com|twitter\.com)\b/i)
  if (site !== null) {
    const rest = query.replace(/\s*\bsite:(?:x\.com|twitter\.com)\b/gi, '').replace(/\s{2,}/g, ' ').trim()
    if (rest !== '') return xSearch(rest)
  }
  return { kind: 'web', query, url: WEB_ENGINE_URL[engine](query) }
}

/** One raw page-side result, as the extraction snippets emit. */
export interface RawHit {
  title: string
  url: string
  snippet?: string
  publishedAt?: string
}

/**
 * Fold raw hits into sources: drop empties and duplicates by URL, cap at the
 * request budget.
 * @param hits - raw extraction hits.
 * @param maxResults - the request's result budget.
 * @returns the capped, deduplicated source list.
 */
export function toSources(hits: readonly RawHit[], maxResults: number): WebSearchSource[] {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const hit of hits) {
    if (sources.length >= maxResults) break
    if (hit.url.trim() === '' || hit.title.trim() === '') continue
    if (seen.has(hit.url)) continue
    seen.add(hit.url)
    sources.push({
      url: hit.url,
      title: hit.title,
      ...hit.snippet !== undefined && hit.snippet !== '' ? { snippet: hit.snippet } : {},
      ...hit.publishedAt !== undefined && hit.publishedAt !== '' ? { publishedAt: hit.publishedAt } : {},
    })
  }
  return sources
}

/** Page-side general-engine extraction: one outbound anchor per result with a
 * heading, snippet from the surrounding block; covers Google (`a h3`), Bing
 * (`li.b_algo h2 a`, with its base64 `u=` redirect unwrapping), and
 * DuckDuckGo (`a[data-testid=result-title-a]`, h2 a). */
const WEB_EXTRACT = (limit: number): string => `(() => {
  const unwrap = (href) => {
    try {
      const u = new URL(href)
      if (u.hostname.replace(/^www\\./, '').endsWith('bing.com') && u.pathname === '/ck/a') {
        const wrapped = u.searchParams.get('u') ?? ''
        if (wrapped.startsWith('a1')) {
          const b64 = wrapped.slice(2).replace(/-/g, '+').replace(/_/g, '/')
          const decoded = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
          if (/^https?:/.test(decoded)) return decoded
        }
      }
    } catch {}
    return href
  }
  const out = []
  const anchors = document.querySelectorAll(
    '#search a h3, #rso a h3, main a h3, li.b_algo h2 a, a[data-testid="result-title-a"], article h2 a')
  for (const heading of anchors) {
    const a = heading.closest('a')
    if (a === null) continue
    const href = unwrap(a.href)
    let host = ''
    try { host = new URL(href).hostname.replace(/^www\\./, '') } catch { continue }
    if (!/^https?:/.test(href) || host === '' || host.includes('google.') || host.includes('bing.com') || host.includes('duckduckgo.com')) continue
    let snippet = ''
    for (let node = a.parentElement; node !== null && node !== document.body; node = node.parentElement) {
      const text = (node.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean)
      if (text.length >= 2) { snippet = text.slice(1).join(' '); break }
    }
    out.push({ title: heading.textContent.trim(), url: href, snippet: snippet.slice(0, 240) })
    if (out.length >= ${String(limit)}) break
  }
  return JSON.stringify(out)
})()`

/** Page-side X extraction: tweets as articles, links to the status, text,
 * and the timestamp element's datetime. */
const X_EXTRACT = (limit: number): string => `(() => {
  const out = []
  for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
    const link = art.querySelector('a[href*="/status/"]')
    const time = art.querySelector('time[datetime]')
    const text = (art.innerText || '').replace(/[\\n\\r]+/g, ' ').replace(/\\s{2,}/g, ' ').trim()
    if (link === null || text === '') continue
    let url = ''
    try { url = new URL(link.getAttribute('href'), 'https://x.com').href } catch { continue }
    out.push({
      title: text.slice(0, 80),
      url,
      snippet: text.slice(0, 280),
      ...(time !== null ? { publishedAt: (time.getAttribute('datetime') || '').slice(0, 10) } : {}),
    })
    if (out.length >= ${String(limit)}) break
  }
  return JSON.stringify(out)
})()`

/** Minimal CDP command client over the platform WebSocket. */
class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
    this.socket.addEventListener('message', (event) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        message = JSON.parse(String(event.data)) as typeof message
      } catch {
        return
      }
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(message.error.message ?? 'cdp error'))
      else entry.resolve(message.result)
    })
  }

  static open(url: string, timeoutMs: number): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error('chrome devtools websocket timed out'))
      }, timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(new CdpConnection(socket))
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('chrome devtools websocket failed'))
      })
    })
  }

  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, ...params !== undefined ? { params } : {} })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.socket.send(payload)
    }) as Promise<Record<string, unknown>>
  }

  close(): void {
    try {
      this.socket.close()
    } catch {
      // Already closed; nothing to drain.
    }
  }
}

/** One Chrome debug target as `/json/new` returns it. */
interface ChromeTarget {
  id: string
  webSocketDebuggerUrl?: string
}

/** Resolved provider configuration. */
export interface UserChromeOptions {
  /** Chrome's remote-debugging port; Chrome must run with `--remote-debugging-port=`. */
  cdpPort: number
  /** Budget for one whole search, navigation included. */
  timeoutMs: number
  /** Which general search engine non-X queries use inside Chrome. */
  webEngine: WebEngine
}

/** The user-Chrome search provider behind the `ctx.web` seam. */
export class UserChromeSearchProvider implements WebSearchProvider {
  readonly id = CHROME_PROVIDER_ID

  private readonly options: UserChromeOptions

  constructor(options: UserChromeOptions) {
    this.options = options
  }

  /**
   * The seam contract wants a synchronous, network-free answer, so this is
   * always usable from the seam's perspective; `search` itself fails with a
   * clear, actionable error when Chrome's DevTools endpoint is missing.
   */
  available(): boolean {
    return true
  }

  /** Whether Chrome's DevTools endpoint answers right now. */
  async probe(): Promise<boolean> {
    try {
      const response = await fetch(this.endpoint('/json/version'), { signal: AbortSignal.timeout(500) })
      return response.ok
    } catch {
      return false
    }
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const route = routeSearchTarget(request.query, this.options.webEngine)
    const limit = request.maxResults ?? 5
    const timeout = AbortSignal.any([
      ...(signal !== undefined ? [signal] : []),
      AbortSignal.timeout(this.options.timeoutMs),
    ])
    const target = await this.newTab()
    let connection: CdpConnection | undefined
    try {
      timeout.throwIfAborted()
      if (target.webSocketDebuggerUrl === undefined) throw new Error('chrome target has no debug websocket')
      connection = await CdpConnection.open(target.webSocketDebuggerUrl, 5_000)
      await connection.send('Page.enable')
      await connection.send('Page.navigate', { url: route.url })
      await this.settle(connection, route, timeout)
      timeout.throwIfAborted()
      const expression = route.kind === 'x' ? X_EXTRACT(limit * 2) : WEB_EXTRACT(limit * 2)
      const evaluated = await connection.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
      })
      const value = (evaluated as { result?: { value?: unknown } }).result?.value
      const hits: RawHit[] = typeof value === 'string' ? parseHits(value) : []
      return { sources: toSources(hits, limit), truncated: false }
    } finally {
      connection?.close()
      void this.closeTab(target.id).catch(() => undefined)
    }
  }

  /** Wait until the navigated page looks settled: complete load state, or the
   * route's result markers, or the budget runs out. */
  private async settle(connection: CdpConnection, route: SearchRoute, timeout: AbortSignal): Promise<void> {
    const marker = route.kind === 'x'
      ? 'document.querySelector(\'article[data-testid="tweet"]\') !== null'
      : 'document.querySelector(\'#search a h3, #rso a h3, main a h3, li.b_algo h2 a, a[data-testid="result-title-a"], article h2 a\') !== null'
    const deadline = Date.now() + this.options.timeoutMs
    while (Date.now() < deadline) {
      timeout.throwIfAborted()
      const state = await connection.send('Runtime.evaluate', {
        expression: `document.readyState === 'complete' || ${marker}`,
        returnByValue: true,
      }) as { result?: { value?: unknown } }
      if (state.result?.value === true) {
        if ((await this.readyState(connection)) === 'complete') return
        // Markers can appear mid-load; give one settle beat for content.
        await delay(400)
        return
      }
      await delay(250)
    }
  }

  private async readyState(connection: CdpConnection): Promise<string> {
    const state = await connection.send('Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true,
    }) as { result?: { value?: unknown } }
    return typeof state.result?.value === 'string' ? state.result.value : 'unknown'
  }

  private endpoint(path: string): string {
    return `http://127.0.0.1:${String(this.options.cdpPort)}${path}`
  }

  /** Open a fresh tab; Chrome ≥111 requires PUT for `/json/new`. */
  private async newTab(): Promise<ChromeTarget> {
    const url = this.endpoint('/json/new?about:blank')
    let response = await fetch(url, { method: 'PUT', signal: AbortSignal.timeout(4_000) })
    if (response.status === 405) response = await fetch(url, { signal: AbortSignal.timeout(4_000) })
    if (!response.ok) {
      throw new WebError(
        'user-chrome: could not open a Chrome tab (is Chrome running with '
        + `--remote-debugging-port=${String(this.options.cdpPort)}? ${String(response.status)} ${response.statusText})`,
        'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
      )
    }
    return await response.json() as ChromeTarget
  }

  private async closeTab(targetId: string): Promise<void> {
    const response = await fetch(this.endpoint(`/json/close/${targetId}`), {
      method: 'PUT',
      signal: AbortSignal.timeout(2_000),
    })
    if (response.status === 405) {
      await fetch(this.endpoint(`/json/close/${targetId}`), { signal: AbortSignal.timeout(2_000) })
    }
  }
}

/** Parse the extraction snippet's JSON, tolerating a bad page. */
function parseHits(raw: string): RawHit[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((hit): hit is RawHit => {
      if (typeof hit !== 'object' || hit === null) return false
      const candidate = hit as Record<string, unknown>
      return typeof candidate.title === 'string'
        && typeof candidate.url === 'string'
        && (candidate.snippet === undefined || typeof candidate.snippet === 'string')
        && (candidate.publishedAt === undefined || typeof candidate.publishedAt === 'string')
    })
  } catch {
    return []
  }
}

/** Promise-based sleep. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
