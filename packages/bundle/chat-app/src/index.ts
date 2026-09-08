/**
 * @deepseek-ai/dsh-chat-app — the chat bundle's runtime glue plugin. It serves
 * the built chat frontend dist on the webserver fallback seat, exposes a small
 * local JSON API over `/api` (session list, history, message send with SSE
 * streaming, stop, runtime settings), and drives agents directly through
 * `ctx.agents` and `ctx.sessionQuery` — no client module system.
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
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { TinyMetasearchProvider } from '@deepseek-ai/dsh-web-search-tiny/src/provider.ts'
import { ExtensionBridge } from '@deepseek-ai/dsh-web-search-chrome/src/bridge.ts'
import { probeModelAbilities, type ModelAbilities } from './capabilities.ts'
import { routeSearchTarget, toSources, UserChromeSearchProvider } from '@deepseek-ai/dsh-web-search-chrome/src/provider.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, ReasoningEffortId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionQueryError, SessionSearchCursor, type SessionSearchHit, type SessionSearchPage } from '@deepseek-ai/dsh-session-query'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'chat-app'

/** Services required before the chat surface can mount. */
export const inject = ['webServer', 'agents', 'sessionQuery', 'llm']

/** Persona used when no explicit one is set; empty panel input means this too. */
export const DEFAULT_PERSONA = 'You are a helpful assistant.'

/** Longest accepted API key; endpoints never need more. */
const MAX_API_KEY_LENGTH = 500

/** Public DeepSeek API, mirroring llm-deepseek's fallback when nothing overrides it. */
const PUBLIC_BASE_URL = 'https://api.deepseek.com'

/**
 * Whether one model's probed abilities should claim image input for the
 * uncatalogued route. Video rides the same multimodal machinery, so either
 * accepted modality claims it.
 * @param abilities - one model's probe verdicts.
 * @returns the adapter's uncataloguedImageInput claim.
 */
export function modalityClaim(abilities: ModelAbilities): boolean {
  return abilities.image === 'yes' || abilities.video === 'yes'
}

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
  /** Persona seeding the runtime system-prompt setting. */
  persona: string
  /** Chrome DevTools port the user-chrome engine talks to. */
  chromeCdpPort: number
  /** General engine the user-chrome engine searches inside Chrome. */
  chromeWebEngine: 'google' | 'bing' | 'duckduckgo'
}

export const Config: z<Config> = z.object({
  openBrowser: z.boolean().default(true),
  printUrl: z.boolean().default(true),
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-chat'),
  reasoningEffort: z.union([z.const('off'), z.const('low'), z.const('high'), z.const('max')]),
  temperature: z.number().min(0).max(2),
  persona: z.string().default(DEFAULT_PERSONA),
  chromeCdpPort: z.number().default(9222),
  chromeWebEngine: z.union([z.const('google'), z.const('bing'), z.const('duckduckgo')]).default('google'),
})

/** One saved provider profile: a named model route the panel can switch to.
 * The adapter route (`provider`) is global and registry-fixed; everything
 * endpoint-specific — model, base URL, key — is per-profile. */
export interface ProviderProfile {
  /** Stable id; renaming never changes it. */
  id: string
  /** User-chosen display name. */
  name: string
  model: string
  /** OpenAI-compatible endpoint base overriding `$DEEPSEEK_BASE_URL`. */
  baseUrl?: string
  /** API key overriding `$DEEPSEEK_API_KEY`; persisted owner-only, never served. */
  apiKey?: string
}

/** Everything the settings panel can change while the app runs. */
export interface ChatSettings {
  provider: string
  /** Saved provider profiles; the active one is what requests use. */
  profiles: ProviderProfile[]
  /** Which profile the panel last switched to. */
  activeProfileId: string
  /** Adapter reasoning effort for conversation agents (thinking level). */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Sampling temperature applied to every conversation request. */
  temperature?: number
  persona: string
  /** Which engine the pinned chat-selector provider dispatches to. */
  searchTool: 'tiny-metasearch' | 'user-chrome'
}

/** Longest accepted profile display name. */
const MAX_PROFILE_NAME_LENGTH = 60

/** Most profiles worth keeping in one panel. */
const MAX_PROFILES = 20

/**
 * The profile settings edits apply to: the active one, else the first — the
 * settings file always holds at least one, so this never misses.
 * @param settings - the settings in force.
 * @returns the profile model calls and panel edits target.
 */
export function activeProfile(settings: ChatSettings): ProviderProfile {
  return settings.profiles.find(profile => profile.id === settings.activeProfileId)
    ?? settings.profiles[0]
    ?? { id: 'default', name: 'Default', model: '' }
}

/** A migrated profile's display name: the endpoint's host, else plain. */
function deriveProfileName(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return 'Default'
  try {
    const host = new URL(baseUrl).hostname
    return host === '' ? 'Default' : host
  } catch {
    return 'Default'
  }
}

/** Longest accepted persona text; the persona is the whole system prompt. */
const MAX_PERSONA_LENGTH = 4000

/**
 * Resolve a usable provider route: keep the current one when an adapter
 * serves it, else prefer the composition fallback, else the first
 * registered route (empty registry keeps the fallback as-is).
 * @param current - the persisted provider route.
 * @param registered - provider ids with a registered adapter.
 * @param fallback - the composition's default route.
 * @returns a provider id that an adapter serves, when any exist.
 */
export function resolveProviderFallback(
  current: string,
  registered: readonly string[],
  fallback: string,
): string {
  if (registered.includes(current)) return current
  if (registered.includes(fallback)) return fallback
  return registered[0] ?? fallback
}

/**
 * Pick the agent handles safe to evict: idle past the budget and with no
 * open stream. Eviction is transparent — the durable history lets the next
 * message resume the conversation.
 * @param handles - session id → handle bookkeeping with a `lastUsed` stamp.
 * @param busy - session ids with an open SSE stream (turn possibly running).
 * @param now - the sweep's clock.
 * @param idleMs - how long unused handles survive.
 * @returns the session ids whose handles may be disposed.
 */
export function evictableSessionIds(
  handles: ReadonlyMap<string, { lastUsed: number }>,
  busy: ReadonlySet<string>,
  now: number,
  idleMs: number,
): string[] {
  const ids: string[] = []
  for (const [id, entry] of handles) {
    if (!busy.has(id) && now - entry.lastUsed > idleMs) ids.push(id)
  }
  return ids
}

/**
 * Order sidebar sessions by last activity — the title snapshot's refresh
 * time, falling back to creation — newest first, so continuing an old
 * conversation bumps it to the top the way a chat surface expects. Ties
 * break by id ascending for a deterministic page order.
 * @param records - session records in any order.
 * @param activity - id → last-activity time, when known.
 * @returns the records sorted newest-activity first.
 */
export function sortSessionsByActivity<T extends { header: { id: SessionId; createdAt: number } }>(
  records: readonly T[],
  activity: ReadonlyMap<string, number>,
): T[] {
  return [...records].sort((a, b) => {
    const at = activity.get(String(a.header.id)) ?? a.header.createdAt
    const bt = activity.get(String(b.header.id)) ?? b.header.createdAt
    return bt - at || String(a.header.id).localeCompare(String(b.header.id))
  })
}

/**
 * Validate one partial settings update. `null` clears an optional field.
 * Unknown keys are rejected so a drifted frontend fails loudly, not silently.
 * The flat `model`/`baseUrl`/`apiKey` keys edit the active profile (a switch
 * in the same patch is applied first, whatever the key order).
 * @param current - the settings in force before the patch.
 * @param patch - the request body.
 * @param makeId - id mint for `newProfile`; injectable for deterministic tests.
 * @returns the next settings; throws on any invalid value.
 */
export function applySettingsPatch(
  current: ChatSettings,
  patch: Record<string, unknown>,
  makeId: () => string = () => randomUUID().slice(0, 8),
): ChatSettings {
  const next: ChatSettings = { ...current, profiles: current.profiles.map(profile => ({ ...profile })) }
  // A switch must land before any field edits so the edits target the profile
  // the request switches to, whatever order the body's keys arrived in.
  // Unshifting in reverse priority leaves them front-first in list order.
  const entries = Object.entries(patch)
  for (const key of ['activeProfileId', 'switchProfile', 'profiles']) {
    const at = entries.findIndex(([entryKey]) => entryKey === key)
    if (at !== -1) {
      const moved = entries.splice(at, 1)[0]
      if (moved !== undefined) entries.unshift(moved)
    }
  }
  const mintId = (): string => {
    for (;;) {
      const id = makeId()
      if (!next.profiles.some(profile => profile.id === id)) return id
    }
  }
  for (const [key, value] of entries) {
    switch (key) {
      case 'provider': {
        if (typeof value !== 'string' || value.trim() === '') throw new Error('provider must be a non-empty string')
        next.provider = value.trim()
        break
      }
      case 'profiles': {
        next.profiles = coerceProfiles(value)
        const first = next.profiles[0]
        if (first !== undefined && !next.profiles.some(profile => profile.id === next.activeProfileId)) {
          next.activeProfileId = first.id
        }
        break
      }
      case 'switchProfile':
      case 'activeProfileId': {
        if (typeof value !== 'string' || value === '') throw new Error(`${key} must be a profile id`)
        if (next.profiles.some(profile => profile.id === value)) {
          next.activeProfileId = value
          break
        }
        // `switchProfile` is a live client operation and fails loudly;
        // `activeProfileId` is the file-format key and heals to the first
        // profile, so one stale id never discards a whole settings file.
        if (key === 'switchProfile') throw new Error(`unknown profile "${value}"`)
        const first = next.profiles[0]
        if (first !== undefined) next.activeProfileId = first.id
        break
      }
      case 'renameProfile': {
        const op = profileOpId(value, 'renameProfile')
        if (typeof (value as { name?: unknown }).name !== 'string') throw new Error('renameProfile needs a name')
        const profile = next.profiles.find(entry => entry.id === op)
        if (profile === undefined) throw new Error(`unknown profile "${op}"`)
        const name = ((value as { name: string }).name).trim()
        if (name === '') throw new Error('profile name must be a non-empty string')
        if (name.length > MAX_PROFILE_NAME_LENGTH) {
          throw new Error(`profile name must be at most ${String(MAX_PROFILE_NAME_LENGTH)} characters`)
        }
        profile.name = name
        break
      }
      case 'newProfile': {
        if (next.profiles.length >= MAX_PROFILES) {
          throw new Error(`at most ${String(MAX_PROFILES)} profiles can be saved`)
        }
        const requested = profileOpName(value, 'newProfile')
        const base = activeProfile(next)
        const created: ProviderProfile = {
          id: mintId(),
          name: requested ?? `Profile ${String(next.profiles.length + 1)}`,
          model: base.model,
          ...base.baseUrl !== undefined ? { baseUrl: base.baseUrl } : {},
          ...base.apiKey !== undefined ? { apiKey: base.apiKey } : {},
        }
        next.profiles.push(created)
        next.activeProfileId = created.id
        break
      }
      case 'deleteProfile': {
        const id = profileOpId(value, 'deleteProfile')
        if (next.profiles.length <= 1) throw new Error('the last profile cannot be deleted')
        const index = next.profiles.findIndex(entry => entry.id === id)
        if (index === -1) throw new Error(`unknown profile "${id}"`)
        next.profiles.splice(index, 1)
        const remaining = next.profiles[0]
        if (next.activeProfileId === id && remaining !== undefined) next.activeProfileId = remaining.id
        break
      }
      case 'model': {
        if (typeof value !== 'string' || value.trim() === '') throw new Error('model must be a non-empty string')
        activeProfile(next).model = value.trim()
        break
      }
      case 'reasoningEffort': {
        if (value === null) {
          delete next.reasoningEffort
          break
        }
        if (value !== 'off' && value !== 'low' && value !== 'high' && value !== 'max') {
          throw new Error('reasoningEffort must be one of off, low, high, max, or null')
        }
        next.reasoningEffort = value
        break
      }
      case 'temperature': {
        if (value === null) {
          delete next.temperature
          break
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) {
          throw new Error('temperature must be a number between 0 and 2, or null')
        }
        next.temperature = value
        break
      }
      case 'persona': {
        if (typeof value !== 'string') throw new Error('persona must be a string')
        if (value.length > MAX_PERSONA_LENGTH) throw new Error(`persona must be at most ${String(MAX_PERSONA_LENGTH)} characters`)
        const trimmed = value.trim()
        next.persona = trimmed === '' ? DEFAULT_PERSONA : trimmed
        break
      }
      case 'baseUrl': {
        const target = activeProfile(next)
        if (value === null) {
          delete target.baseUrl
          break
        }
        if (typeof value !== 'string') throw new Error('baseUrl must be a string')
        const trimmed = value.trim().replace(/\/+$/, '')
        if (trimmed === '') {
          delete target.baseUrl
          break
        }
        try {
          const parsed = new URL(trimmed)
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
        } catch {
          throw new Error('baseUrl must be a valid http(s) URL')
        }
        target.baseUrl = trimmed
        break
      }
      case 'apiKey': {
        const target = activeProfile(next)
        if (value === null) {
          delete target.apiKey
          break
        }
        if (typeof value !== 'string' || value.trim() === '') throw new Error('apiKey must be a non-empty string')
        if (value.length > MAX_API_KEY_LENGTH) {
          throw new Error(`apiKey must be at most ${String(MAX_API_KEY_LENGTH)} characters`)
        }
        target.apiKey = value.trim()
        break
      }
      case 'searchTool': {
        if (value !== 'tiny-metasearch' && value !== 'user-chrome') {
          throw new Error('searchTool must be one of tiny-metasearch, user-chrome')
        }
        next.searchTool = value
        break
      }
      default:
        throw new Error(`unknown setting "${key}"`)
    }
  }
  return next
}

/** Validate an unknown payload as profile entries; throws when none survive. */
function coerceProfiles(value: unknown): ProviderProfile[] {
  if (!Array.isArray(value)) throw new Error('profiles must be an array')
  const profiles = value.map((entry): ProviderProfile | undefined => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.id !== 'string' || candidate.id === '') return undefined
    if (typeof candidate.name !== 'string' || candidate.name.trim() === '') return undefined
    if (typeof candidate.model !== 'string' || candidate.model.trim() === '') return undefined
    return {
      id: candidate.id,
      name: candidate.name.trim(),
      model: candidate.model.trim(),
      ...typeof candidate.baseUrl === 'string' && candidate.baseUrl.trim() !== '' ? { baseUrl: candidate.baseUrl } : {},
      ...typeof candidate.apiKey === 'string' && candidate.apiKey.trim() !== '' ? { apiKey: candidate.apiKey } : {},
    }
  }).filter((entry): entry is ProviderProfile => entry !== undefined)
  if (profiles.length === 0) throw new Error('profiles must hold at least one valid profile')
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) {
    throw new Error('profile ids must be unique')
  }
  return profiles.slice(0, MAX_PROFILES)
}

/** Pull the id out of a profile-operation body, or explain what is missing. */
function profileOpId(value: unknown, op: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${op} must be an object`)
  const id = (value as { id?: unknown }).id
  if (typeof id !== 'string' || id === '') throw new Error(`${op} needs a profile id`)
  return id
}

/** Pull an optional trimmed name out of a profile-operation body. */
function profileOpName(value: unknown, op: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${op} must be an object`)
  const name = (value as { name?: unknown }).name
  if (name === undefined) return undefined
  if (typeof name !== 'string') throw new Error(`${op} name must be a string`)
  const trimmed = name.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > MAX_PROFILE_NAME_LENGTH) {
    throw new Error(`profile name must be at most ${String(MAX_PROFILE_NAME_LENGTH)} characters`)
  }
  return trimmed
}

/**
 * Load settings over the config defaults from the persisted JSON file's
 * contents. A missing or corrupt file falls back to the defaults — settings
 * are convenience, never a boot gate. A legacy flat file (model/baseUrl/
 * apiKey without profiles) migrates onto a single default profile named
 * after its endpoint's host.
 * @param raw - the file contents, or `undefined` when no file exists yet.
 * @param defaults - boot-time defaults (config, which folds the env seeds).
 * @returns the settings in force.
 */
export function parseSettingsFile(raw: string | undefined, defaults: Config): ChatSettings {
  const base: ChatSettings = {
    provider: defaults.provider,
    profiles: [{ id: 'default', name: 'Default', model: defaults.model }],
    activeProfileId: 'default',
    ...defaults.reasoningEffort !== undefined ? { reasoningEffort: defaults.reasoningEffort } : {},
    ...defaults.temperature !== undefined ? { temperature: defaults.temperature } : {},
    persona: defaults.persona === '' ? DEFAULT_PERSONA : defaults.persona,
    searchTool: 'tiny-metasearch',
  }
  if (raw === undefined) return base
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return base
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return base
  const record = parsed as Record<string, unknown>
  try {
    const applied = applySettingsPatch(base, record)
    // A legacy flat file names its migrated profile after the gateway host —
    // derived only once the whole overlay proved valid.
    const migrating = applied.profiles[0]
    if (migrating !== undefined && record.profiles === undefined && typeof record.baseUrl === 'string') {
      migrating.name = deriveProfileName(record.baseUrl)
    }
    return applied
  } catch {
    return base
  }
}

/** Project settings into the JSON body served by `GET /api/config`. The
 * active profile supplies the flat fields; per-profile API keys never cross
 * to the browser, only their presence does. */
function settingsJson(settings: ChatSettings): Record<string, unknown> {
  const active = activeProfile(settings)
  return {
    provider: settings.provider,
    model: active.model,
    ...settings.reasoningEffort !== undefined ? { reasoningEffort: settings.reasoningEffort } : {},
    ...settings.temperature !== undefined ? { temperature: settings.temperature } : {},
    persona: settings.persona,
    ...active.baseUrl !== undefined ? { baseUrl: active.baseUrl } : {},
    apiKeySet: active.apiKey !== undefined,
    searchTool: settings.searchTool,
    activeProfileId: settings.activeProfileId,
    profiles: settings.profiles.map(profile => ({
      id: profile.id,
      name: profile.name,
      model: profile.model,
      ...profile.baseUrl !== undefined ? { baseUrl: profile.baseUrl } : {},
      apiKeySet: profile.apiKey !== undefined,
    })),
  }
}

/** Persist settings to disk; failures log but never break the request. The
 * file can hold API keys, so it is owner-only. */
async function persistSettings(path: string, settings: ChatSettings): Promise<void> {
  const body = `${JSON.stringify({
    provider: settings.provider,
    profiles: settings.profiles.map(profile => ({
      id: profile.id,
      name: profile.name,
      model: profile.model,
      ...profile.baseUrl !== undefined ? { baseUrl: profile.baseUrl } : {},
      ...profile.apiKey !== undefined ? { apiKey: profile.apiKey } : {},
    })),
    activeProfileId: settings.activeProfileId,
    ...settings.reasoningEffort !== undefined ? { reasoningEffort: settings.reasoningEffort } : {},
    ...settings.temperature !== undefined ? { temperature: settings.temperature } : {},
    persona: settings.persona,
    searchTool: settings.searchTool,
  }, null, 2)}\n`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, body, { mode: 0o600, flag: 'w' })
  // `mode` only applies at creation; re-assert it for pre-existing files.
  await chmod(path, 0o600)
}

/** One page of the sidebar list plus the full filtered count. */
export interface SessionPage<T> {
  page: readonly T[]
  total: number
}

/**
 * Select one sidebar-list page from records that are already in
 * deterministic newest-first order. `limit` defaults to 20 (clamped 1–100)
 * and `offset` to 0 (floored), so malformed query strings fall back to the
 * first page instead of failing the request.
 * @param records - newest-first session records.
 * @param limitRaw - the raw `limit` query value.
 * @param offsetRaw - the raw `offset` query value.
 * @returns the page slice and the total record count.
 */
export function paginateSessions<T>(
  records: readonly T[],
  limitRaw: string | null,
  offsetRaw: string | null,
): SessionPage<T> {
  const parsedLimit = Number.parseInt(limitRaw ?? '', 10)
  const parsedOffset = Number.parseInt(offsetRaw ?? '', 10)
  const limit = Math.min(
    Math.max(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_SESSION_PAGE, 1),
    MAX_SESSION_PAGE,
  )
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0
  return { page: records.slice(offset, offset + limit), total: records.length }
}

/**
 * Normalize one sidebar search query: trimmed, non-empty, capped, NUL-free —
 * mirroring the main surface's contract.
 * @param query - the raw `q` value.
 * @returns the normalized query; throws on any invalid input.
 */
export function normalizeSearchQuery(query: string): string {
  const normalized = query.trim()
  if (normalized.length === 0) throw new Error('search query must not be empty')
  if (normalized.length > MAX_SEARCH_QUERY_CHARS) {
    throw new Error(`search query must contain at most ${String(MAX_SEARCH_QUERY_CHARS)} characters`)
  }
  if (normalized.includes('\0')) throw new Error('search query must not contain NUL')
  return normalized
}

/** Clip one snippet to the code-point budget with an ellipsis. */
export function truncateSnippet(text: string): string {
  const points = Array.from(text)
  return points.length <= SNIPPET_MAX_CODE_POINTS ? text : `${points.slice(0, SNIPPET_MAX_CODE_POINTS).join('')}…`
}

/** Message bodies may carry one inline attachment; the cap leaves base64 headroom. */
const MESSAGE_BODY_CAP = 40_000_000

/** Largest accepted decoded image bytes. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Largest accepted decoded video bytes. */
const MAX_VIDEO_BYTES = 25 * 1024 * 1024

/** Media types the durable image store admits (it sniffs bytes anyway). */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** One validated upload, ready for the attachment store. */
export interface ParsedAttachment {
  kind: 'image' | 'video' | 'file'
  name: string
  mediaType: string
  data: Uint8Array
}

/** Pull the declared kind out of an attachment payload, unvalidated. */
function attachmentKind(body: unknown): 'image' | 'video' | 'file' | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const kind = (body as { kind?: unknown }).kind
  return kind === 'image' || kind === 'video' || kind === 'file' ? kind : undefined
}

/**
 * Validate one inline attachment payload: a `data:<media>;base64,…` URL with
 * a kind-appropriate media type and size, plus an optional display name.
 * @param body - the request's `attachment` field.
 * @returns the decoded upload; throws with a user-readable reason.
 */
export function parseAttachment(body: unknown): ParsedAttachment {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('attachment must be an object')
  const record = body as { kind?: unknown; name?: unknown; dataUrl?: unknown }
  if (record.kind !== 'image' && record.kind !== 'video' && record.kind !== 'file') {
    throw new Error('attachment kind must be image, video, or file')
  }
  if (typeof record.dataUrl !== 'string') throw new Error('attachment dataUrl must be a string')
  const url = record.dataUrl
  const semicolon = url.indexOf(';')
  const comma = url.indexOf(',')
  if (!url.startsWith('data:') || semicolon === -1 || comma < semicolon || url.slice(semicolon + 1, comma) !== 'base64') {
    throw new Error('attachment dataUrl must be a base64 data URL')
  }
  const mediaType = url.slice(5, semicolon).toLowerCase()
  const payload = url.slice(comma + 1)
  if (payload === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error('attachment dataUrl is not valid base64')
  if (record.kind === 'image' && !IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw new Error(`image attachments must be png, jpeg, webp, or gif (got ${mediaType})`)
  }
  if (record.kind === 'video' && !mediaType.startsWith('video/')) {
    throw new Error('video attachments must carry a video/* media type')
  }
  // Files carry any media type; pasted unknowns fall back to octet-stream.
  const data = Uint8Array.from(Buffer.from(payload, 'base64'))
  const cap = record.kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES
  if (data.byteLength === 0) throw new Error('attachment is empty')
  if (data.byteLength > cap) {
    throw new Error(`${record.kind} attachments must be at most ${String(Math.round(cap / 1024 / 1024))}MB`)
  }
  const name = typeof record.name === 'string' ? record.name.trim().slice(0, 200) : ''
  return { kind: record.kind, name: name === '' ? `upload.${mediaType.split('/')[1] ?? 'bin'}` : name, mediaType, data }
}

/** One attachment as the browser renders it: what it is and how to fetch it. */
export interface ChatAttachment {
  kind: 'image' | 'video' | 'file'
  attachmentId: string
  mediaType: string
  /** Display name for file attachments. */
  name?: string
  /** The durable reference, echoed back to fetch the bytes. */
  ref: unknown
}

/**
 * Project a message's non-text blocks into renderable attachment entries;
 * text extraction stays with {@link textOf}.
 * @param content - one message's content blocks.
 * @returns the attachment descriptors, in order.
 */
export function attachmentDescriptors(content: readonly ContentBlock[] | undefined): ChatAttachment[] {
  if (content === undefined) return []
  const out: ChatAttachment[] = []
  for (const block of content) {
    if (block.type === 'image') {
      const ref: ImageAttachmentRef = block.attachment
      out.push({ kind: 'image', attachmentId: String(ref.attachmentId), mediaType: ref.mediaType, ref })
    } else if (block.type === 'video') {
      out.push({ kind: 'video', attachmentId: String(block.attachment.attachmentId), mediaType: block.mediaType, ref: block.attachment })
    } else if (block.type === 'file') {
      out.push({
        kind: 'file',
        attachmentId: String(block.attachment.attachmentId),
        mediaType: 'application/octet-stream',
        ref: block.attachment,
        name: block.attachment.name,
      })
    }
  }
  return out
}

/** The agent-creation options derived from settings. */
interface ConversationOptions {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
}

/** Whether two agent-creation option sets select the same model route. */
function sameConversationOptions(a: ConversationOptions, b: ConversationOptions): boolean {
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

/** Display-only loopback host for the URL line; the webserver schema is the source of truth. */
const LOOPBACK_HOST = '127.0.0.1'

/** Largest accepted JSON request body. */
const MAX_BODY_BYTES = 1_000_000

/** Largest single source list retained in a projected history item. */
const MAX_TOOL_SOURCES = 8

/** Default sidebar-list page size. */
const DEFAULT_SESSION_PAGE = 20

/** Largest accepted sidebar-list page. */
const MAX_SESSION_PAGE = 100

/** Search page size, mirroring the main surface's cap. */
const SEARCH_PAGE_LIMIT = 20

/** Longest accepted search query. */
const MAX_SEARCH_QUERY_CHARS = 500

/** Longest snippet served per search hit, in code points. */
const SNIPPET_MAX_CODE_POINTS = 240

/** Heartbeat window for calling the extension connected; its long-poll cycle
 * stays well under this, and a running search marks seen on its result post. */
const EXTENSION_TTL_MS = 15_000

/** How long a bridged search may wait for the extension before failing. */
const EXTENSION_JOB_TIMEOUT_MS = 9_000

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
  attachments?: { kind: 'image' | 'video' | 'file'; attachmentId: string; mediaType: string; name?: string; ref?: unknown }[]
  name?: string
  query?: string
  searchQuestion?: string
  searchedAt?: string
  sources?: { url: string; title?: string; publishedAt?: string }[]
}

/** Read and parse one JSON request body, size-capped. */
async function readJsonBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new Error('request body too large')
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
function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(body)
}

/** Reflect the bridge extension's origin so its service worker can read the
 * response; anything else gets the wildcard (still loopback-gated). */
function chromeCors(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin
  return { 'access-control-allow-origin': typeof origin === 'string' && origin.startsWith('chrome-extension://') ? origin : '*' }
}

/** Whether one request is local: a loopback Host and, when present, a
 * loopback Origin. Cross-origin `chrome-extension://` requests are NOT local —
 * the companion extension passes only through {@link isLocalOrBridgeRequest},
 * which admits exactly the two bridge routes.
 * @param req - the incoming request; only `headers` is read.
 * @returns whether the request counts as loopback-local.
 */
/** Whether the request's Host header names this machine's loopback. */
function hasLoopbackHost(req: Pick<IncomingMessage, 'headers'>): boolean {
  const raw = (req.headers.host ?? '').toLowerCase()
  // A bracketed IPv6 host keeps its colons; anything else splits at the port.
  const hostname = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0] ?? ''
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

export function isLocalRequest(req: Pick<IncomingMessage, 'headers'>): boolean {
  if (!hasLoopbackHost(req)) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const originHost = new URL(origin).hostname.toLowerCase()
    return originHost === '127.0.0.1' || originHost === 'localhost' || originHost === '::1'
  } catch {
    return false
  }
}

/** The only routes the companion extension may reach cross-origin: the
 * long-poll and its result post (plus the preflight the post needs). */
export function isExtensionBridgePath(method: string, parts: readonly string[]): boolean {
  if (parts.length !== 2 || parts[0] !== 'chrome') return false
  if (parts[1] === 'next') return method === 'GET' || method === 'OPTIONS'
  if (parts[1] === 'result') return method === 'POST' || method === 'OPTIONS'
  return false
}

/**
 * The API's locality gate: loopback-local requests pass everywhere; a
 * `chrome-extension://` origin passes only on the two bridge routes, so a
 * rogue extension can serve search jobs but read and change nothing else.
 * @param req - the incoming request (headers and method are read).
 * @param parts - the routed path segments after the `/api` prefix.
 * @returns whether the request may proceed.
 */
export function isLocalOrBridgeRequest(
  req: Pick<IncomingMessage, 'headers' | 'method'>,
  parts: readonly string[],
): boolean {
  if (isLocalRequest(req)) return true
  if (!hasLoopbackHost(req)) return false
  const origin = req.headers.origin
  return typeof origin === 'string'
    && origin.startsWith('chrome-extension://')
    && isExtensionBridgePath(req.method ?? '', parts)
}

/** A fixed-window counter for abuse-prone local endpoints. */
export class RateLimiter {
  private windowStart = 0
  private count = 0

  /**
   * @param limit - calls allowed per window.
   * @param windowMs - window length in milliseconds.
   * @param now - clock, injectable for deterministic tests.
   */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Spend one call; false once the window's budget is exhausted. */
  allow(): boolean {
    const current = this.now()
    if (current - this.windowStart >= this.windowMs) {
      this.windowStart = current
      this.count = 0
    }
    if (this.count >= this.limit) return false
    this.count += 1
    return true
  }
}

/** The cookie name carrying the boot-minted session token. */
export const SESSION_COOKIE = 'dsh-chat-session'

/**
 * Whether a request carries this boot's session cookie. The token ships with
 * index.html as an HttpOnly Strict cookie, so the served page authenticates
 * every call while other pages, other origins, and casual no-Origin local
 * callers do not have it.
 * @param cookieHeader - the raw `cookie` header, when present.
 * @param token - this boot's minted token.
 * @returns whether the request is the app's own page.
 */
export function hasSessionCookie(cookieHeader: string | undefined, token: string): boolean {
  if (typeof cookieHeader !== 'string') return false
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator).trim() === SESSION_COOKIE && part.slice(separator + 1).trim() === token) return true
  }
  return false
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
      const attachments = attachmentDescriptors(event.data.content)
      // Queue bookkeeping can produce empty user payloads; nothing to render.
      if (text === '' && attachments.length === 0) return undefined
      return { role: 'user', ...text !== '' ? { text } : {}, ...attachments.length > 0 ? { attachments } : {} }
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

/**
 * Where the companion extension's load-unpacked folder sits in this checkout,
 * when it does — the settings panel prints this so connecting is copy-paste.
 */
function resolveExtensionPath(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    const candidate = join(dirname(require.resolve('@deepseek-ai/dsh-web-search-chrome/package.json')), 'extension')
    return existsSync(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

/**
 * Cache policy per served path: vite content-hashes everything under
 * /assets/, so those are immutable forever; the page itself (and anything
 * else) revalidates.
 * @param pathname - the decoded request path.
 * @returns the cache-control header pair.
 */
export function cachePolicyFor(pathname: string): Record<string, string> {
  return pathname.startsWith('/assets/')
    ? { 'cache-control': 'public, max-age=31536000, immutable' }
    : { 'cache-control': 'no-cache' }
}

/** Serve the built dist over the fallback seat: assets by MIME, `/` as index. */
async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  distRoot: string,
  sessionToken: string,
): Promise<void> {
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
      ...cachePolicyFor(pathname),
      ...pathname === '/index.html'
        ? { 'set-cookie': `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/` }
        : {},
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
  const extensionPath = resolveExtensionPath()
  // One token per server start; index.html hands it to the page as an
  // HttpOnly cookie and every non-bridge API call must carry it.
  const sessionToken = randomUUID()
  // Runtime settings: boot-time config (which folds the env seeds) overlaid
  // with the persisted panel edits, mutable through PUT /api/config.
  const settingsPath = dshHomePath('chat-settings.json')
  let settingsRaw: string | undefined
  try {
    settingsRaw = readFileSync(settingsPath, 'utf8')
  } catch {
    // First run: no file yet, the config defaults stand.
  }
  const settings = parseSettingsFile(settingsRaw, config)
  // The launching environment is the fallback the panel edits override.
  const bootApiKeyEnv = process.env.DEEPSEEK_API_KEY
  const bootBaseUrlEnv = process.env.DEEPSEEK_BASE_URL

  // Last-activity ledger for the sidebar's recency order. The harness
  // exposes no per-session lastPromptAt, and title snapshots only move when
  // a title changes, so the surface keeps its own stamp per conversation —
  // marked on every user message, persisted at turn end, capped to the most
  // recent 500 entries.
  const activityPath = dshHomePath('chat-activity.json')
  const activity = new Map<string, number>()
  try {
    const rawActivity: unknown = JSON.parse(readFileSync(activityPath, 'utf8'))
    if (typeof rawActivity === 'object' && rawActivity !== null && !Array.isArray(rawActivity)) {
      for (const [id, stamp] of Object.entries(rawActivity as Record<string, unknown>)) {
        if (typeof stamp === 'number' && Number.isFinite(stamp)) activity.set(id, stamp)
      }
    }
  } catch {
    // First run or a corrupt ledger; ordering falls back to title/creation.
  }
  let activityDirty = false
  async function persistActivity(): Promise<void> {
    if (!activityDirty) return
    activityDirty = false
    const entries = [...activity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 500)
    await mkdir(dirname(activityPath), { recursive: true })
    await writeFile(activityPath, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`, { mode: 0o600, flag: 'w' })
  }

  /**
   * Push the active profile's key and endpoint into the live adapter seams.
   * The key re-enters `process.env`, which llm-deepseek re-reads on every
   * request; the endpoint goes through the settings service's `llm-deepseek`
   * section, which the adapter re-resolves live (and `$DSH_HOME/settings.yaml`
   * persists).
   */
  async function applyLiveModelSettings(): Promise<void> {
    const active = activeProfile(settings)
    const apiKey = active.apiKey ?? bootApiKeyEnv
    if (apiKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = apiKey
    const baseURL = active.baseUrl ?? bootBaseUrlEnv
    if (baseURL === undefined) return
    const settingsService = ctx.get('settings')
    if (settingsService === undefined) return
    try {
      await settingsService.update('llm-deepseek', { baseURL })
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`chat-app: could not apply the base URL live because ${reason}; it still applies on restart`)
    }
    // Warm the modality claim for whatever model is now active; a message
    // with an attachment awaits the probe regardless.
    void ensureModelAbilities(activeProfile(settings).model).catch(() => { /* the attach route probes on demand */ })
  }

  void applyLiveModelSettings()

  /**
   * A persisted provider that no adapter serves — a hand-edited settings
   * file, or a typo from a free-text picker — would fail every model call
   * with NO_ADAPTER; heal it before the first request.
   */
  {
    const registered = ctx.llm.listProviders().map(provider => provider.id)
    const healed = resolveProviderFallback(settings.provider, registered, config.provider)
    if (healed !== settings.provider) {
      console.warn(`chat-app: provider "${settings.provider}" has no registered adapter; using "${healed}"`)
      settings.provider = healed
      void persistSettings(settingsPath, settings).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        console.error(`chat-app: could not persist the healed provider because ${reason}`)
      })
    }
  }
  const handles = new Map<string, { handle: AgentHandle; options: ConversationOptions; lastUsed: number }>()
  const streams = new Map<string, Set<ServerResponse>>()

  // The web seam pins one provider id at boot, so the pinned id is a
  // chat-owned selector: every search dispatches to the engine the settings
  // panel last chose — the keyless built-in, or the user's own Chrome. The
  // Chrome side prefers the companion extension (invisible, no debug port)
  // and falls back to the CDP engine when the extension is not connected.
  const tinyEngine = new TinyMetasearchProvider({ timeoutMs: 10_000, wikipedia: true })
  const chromeEngine = new UserChromeSearchProvider({
    cdpPort: config.chromeCdpPort,
    timeoutMs: 12_000,
    webEngine: config.chromeWebEngine,
  })
  // Idle agents accumulate for the process's life otherwise; a slow sweep
  // retires quiet ones (never one with an open stream) and conversations
  // resume transparently on demand.
  const evictTimer = setInterval(() => {
    const busy = new Set(streams.keys())
    for (const id of evictableSessionIds(handles, busy, Date.now(), 10 * 60_000)) {
      const entry = handles.get(id)
      handles.delete(id)
      if (entry !== undefined) void entry.handle.dispose()
    }
  }, 60_000)
  ctx.effect(() => () => { clearInterval(evictTimer) }, 'chat-app.evict-sweep')
  const extensionBridge = new ExtensionBridge()
  // Probe answers per model id; abilities do not change within a run, so
  // one probe per model is enough and the panel re-checks on demand.
  const abilityCache = new Map<string, ModelAbilities>()
  const probeLimiter = new RateLimiter(20, 5 * 60_000)

  /**
   * One model's input modalities, probed once and cached — and pushed into the
   * adapter's live settings so its modality gates follow the endpoint's own
   * truth instead of per-model code: a probe that accepts images (or videos,
   * which ride the same machinery) claims image input for the uncatalogued
   * model; anything else restores upstream's conservative text-only default.
   */
  async function ensureModelAbilities(model: string): Promise<ModelAbilities> {
    const cached = abilityCache.get(model)
    if (cached !== undefined) return cached
    const active = activeProfile(settings)
    const outcome = await probeModelAbilities({
      base: (active.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? PUBLIC_BASE_URL).replace(/\/+$/, ''),
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
      model,
      timeoutMs: 15_000,
    })
    abilityCache.set(model, outcome)
    const settingsService = ctx.get('settings')
    if (settingsService !== undefined) {
      try {
        await settingsService.update('llm-deepseek', { uncataloguedImageInput: modalityClaim(outcome) })
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error)
        console.error(`chat-app: could not sync the model's modality claim because ${reason}`)
      }
    }
    return outcome
  }
  type ChromeSearchOutcome = {
    engine: 'extension' | 'cdp'
    result: Awaited<ReturnType<UserChromeSearchProvider['search']>>
  }
  async function userChromeSearch(
    request: Parameters<UserChromeSearchProvider['search']>[0],
    signal?: AbortSignal,
  ): Promise<ChromeSearchOutcome> {
    if (extensionBridge.seenWithin(EXTENSION_TTL_MS)) {
      const route = routeSearchTarget(request.query, config.chromeWebEngine)
      const settlement = await extensionBridge.enqueue({
        kind: route.kind,
        query: route.query,
        url: route.url,
        engine: route.kind === 'x' ? 'x' : config.chromeWebEngine,
        maxResults: request.maxResults ?? 5,
      }, EXTENSION_JOB_TIMEOUT_MS)
      if (!settlement.ok) throw new Error(`user-chrome: the extension search failed: ${settlement.error}`)
      return {
        engine: 'extension',
        result: { sources: toSources(settlement.sources, request.maxResults ?? 5), truncated: false },
      }
    }
    return { engine: 'cdp', result: await chromeEngine.search(request, signal) }
  }
  ctx.inject(['web'], (webCtx) => {
    webCtx.web.registerSearchProvider({
      id: 'chat-selector',
      available: () => true,
      search: (request, signal) =>
        settings.searchTool === 'user-chrome'
          ? userChromeSearch(request, signal).then(outcome => outcome.result)
          : tinyEngine.search(request, signal),
    })
  })

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

  /** Fold title snapshots for the given records into id → title info. */
  async function titleMapOf(
    records: readonly { header: { id: SessionId } }[],
  ): Promise<Map<string, { text: string; updatedAt: number } | undefined>> {
    const titles = await ctx.sessionQuery.readTitleSnapshots(records.map(record => record.header.id))
    const titleOf = new Map<string, { text: string; updatedAt: number } | undefined>()
    for (const entry of titles) {
      if (entry.status !== 'fulfilled') continue
      const snapshot = entry.value.title
      titleOf.set(String(entry.sessionId), snapshot === undefined
        ? undefined
        : { text: snapshot.title, updatedAt: snapshot.updatedAt })
    }
    return titleOf
  }

  /**
   * Mint an agent for one session id: `create` for a conversation that does
   * not exist yet, `resume` when it is already known (persisted on disk, or
   * adopted into memory by a history read) — `create` refuses those ids with
   * "session already exists".
   */
  async function createOrResumeAgent(sessionId: string, options: ConversationOptions): Promise<AgentHandle> {
    try {
      return await ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: process.cwd() },
        agentOptions: options,
      })
    } catch (error: unknown) {
      if (!(error instanceof Error) || !error.message.includes('already exists')) throw error
      return await ctx.agents.resume({
        resumeSessionId: SessionId(sessionId),
        agentOptions: options,
      })
    }
  }

  /** Resolve one agent by session id, creating (or resuming) it on demand. */
  async function getOrCreateAgent(sessionId: string): Promise<AgentHandle> {
    const options: ConversationOptions = {
      provider: settings.provider,
      model: activeProfile(settings).model,
      ...settings.reasoningEffort !== undefined ? { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) } : {},
    }
    const existing = handles.get(sessionId)
    if (existing !== undefined && ctx.agents.get(existing.handle.agent.id) === existing.handle.agent) {
      existing.lastUsed = Date.now()
      if (sameConversationOptions(existing.options, options)) return existing.handle
      // The model route changed in settings: retire the stale agent. Session
      // history is durable, so the replacement resumes this conversation on
      // the new route; a running turn finishes on the old one.
      handles.delete(sessionId)
      await existing.handle.dispose()
    }
    const handle = await createOrResumeAgent(sessionId, options)
    handles.set(sessionId, { handle, options, lastUsed: Date.now() })
    ctx.effect(() => () => {
      // A settings swap may have disposed this handle already; only the
      // map's current entry owns cleanup.
      if (handles.get(sessionId)?.handle === handle) {
        void handle.dispose()
        handles.delete(sessionId)
      }
    }, `chat-app.agent.${sessionId}`)
    return handle
  }

  // Sampling is request-level, not agent identity: patch the frozen call
  // config on its way out so every conversation request carries the
  // current settings temperature (the generator's hand-built call is
  // untouched). Reading the store per request keeps panel edits live.
  ctx.on('agent/request', async (_payload, next) => {
    const base = await next()
    const temperature = settings.temperature
    return temperature === undefined ? base : { ...base, temperature }
  })

  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)
    switch (event.type) {
      case 'user/message': {
        activity.set(sessionId, Date.now())
        activityDirty = true
        const used = handles.get(sessionId)
        if (used !== undefined) used.lastUsed = Date.now()
        broadcast(sessionId, { t: 'user', text: textOf(event.data.content) })
        break
      }
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
        void persistActivity().catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error)
          console.error(`chat-app: could not persist the activity ledger because ${reason}`)
        })
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

  // The persona is the whole system prompt, and the settings panel owns it:
  // one dynamic section evaluated per request keeps panel edits live. Two
  // app-owned lines follow it. The reply-language anchor exists because
  // Chinese-base models occasionally drift on Sino-Vietnamese input
  // ("mâu thuẫn" → a Chinese 矛盾 essay); pinning the reply to the user's
  // last message costs ~10 tokens and survives persona edits. The current
  // date stops the model baking its stale training-cutoff year into
  // time-relative tool calls ("giá vàng hôm nay 2025").
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'app:persona',
      order: promptCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: () => settings.persona,
    })
    promptCtx.systemPrompt.section({
      name: 'app:reply-language',
      order: promptCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: 'Always reply in the language of the user\'s most recent message.',
    })
    promptCtx.systemPrompt.section({
      name: 'app:current-date',
      order: promptCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: () => `Current date: ${new Date().toISOString().slice(0, 10)} (UTC).`,
    })
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
    const url = new URL(req.url ?? '/', 'http://x')
    const parts = url.pathname.split('/').filter(segment => segment !== '')
    // parts[0] is 'api' (the registered prefix).
    if (parts.length >= 1 && parts[0] === 'api') parts.shift()
    // Route first, gate second: the extension carve-out needs the path.
    if (!isLocalOrBridgeRequest(req, parts)) {
      sendJson(res, 403, { error: 'local requests only' })
      return
    }
    if (!isExtensionBridgePath(req.method ?? '', parts) && !hasSessionCookie(req.headers.cookie, sessionToken)) {
      sendJson(res, 403, { error: 'session cookie required' })
      return
    }

    if (parts.length === 1 && parts[0] === 'config') {
      if (req.method === 'GET') {
        sendJson(res, 200, settingsJson(settings))
        return
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req)
        // Provider is a registry route, not a free-form name: reject one no
        // adapter serves, listing the valid ids, before anything applies.
        if (typeof body.provider === 'string' && body.provider.trim() !== settings.provider) {
          const registered = ctx.llm.listProviders().map(provider => provider.id)
          if (!registered.includes(body.provider.trim())) {
            sendJson(res, 400, {
              error: `unknown provider "${body.provider.trim()}"; registered adapters: ${registered.join(', ')}`,
            })
            return
          }
        }
        const next = applySettingsPatch(settings, body)
        Object.assign(settings, next)
        await applyLiveModelSettings().catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error)
          console.error(`chat-app: could not apply settings live because ${reason}`)
        })
        void persistSettings(settingsPath, settings).catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error)
          console.error(`chat-app: could not persist chat settings because ${reason}`)
        })
        sendJson(res, 200, settingsJson(settings))
        return
      }
      sendJson(res, 405, { allow: 'GET, PUT' })
      return
    }

    // Model picker data: proxy the OpenAI-compatible /models list from the
    // currently configured endpoint, server-side, so the key never reaches
    // the browser and CORS never applies.
    // Provider picker data: the adapter routes this composition registers.
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'providers') {
      sendJson(res, 200, {
        providers: ctx.llm.listProviders().map(provider => ({ id: provider.id, name: provider.name })),
      })
      return
    }

    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'models') {
      const active = activeProfile(settings)
      const base = (active.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? PUBLIC_BASE_URL).replace(/\/+$/, '')
      const apiKey = process.env.DEEPSEEK_API_KEY ?? ''
      const response = await fetch(`${base}/models`, {
        ...apiKey !== '' ? { headers: { authorization: `Bearer ${apiKey}` } } : {},
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) {
        throw new Error(`model list request failed: ${String(response.status)} ${response.statusText}`)
      }
      const body = await response.json() as { data?: unknown }
      const models = Array.isArray(body.data)
        ? body.data
          .map((entry): unknown => (typeof entry === 'object' && entry !== null
            ? (entry as Record<string, unknown>).id
            : undefined))
          .filter((id): id is string => typeof id === 'string')
        : []
      sendJson(res, 200, { models: [...new Set(models)].sort() })
      return
    }

    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'sessions') {
      // The list is ordered by last activity — a continued old conversation
      // rises to the top — then paginated. Ordering reads only the surface's
      // own ledger (every user message) over creation, so it costs no
      // per-session file reads; title snapshots load for the returned page
      // alone (their refresh time refines the display stamp, not the order).
      const records = (await ctx.sessionQuery.listSessions())
        .filter(record => record.header.origin !== 'subagent')
      const activityOf = new Map<string, number>()
      for (const record of records) {
        const id = String(record.header.id)
        activityOf.set(id, Math.max(activity.get(id) ?? 0, record.header.createdAt))
      }
      const { page, total } = paginateSessions(
        sortSessionsByActivity(records, activityOf),
        url.searchParams.get('limit'),
        url.searchParams.get('offset'),
      )
      const titleOf = await titleMapOf(page)
      sendJson(res, 200, {
        sessions: page.map((record) => {
          const id = String(record.header.id)
          return {
            id,
            title: titleOf.get(id)?.text ?? 'New chat',
            createdAt: record.header.createdAt,
            updatedAt: Math.max(activityOf.get(id) ?? 0, titleOf.get(id)?.updatedAt ?? 0),
            live: record.live,
          }
        }),
        total,
      })
      return
    }

    // Full-text search over message content: FTS pages by opaque cursor and
    // hits render as title + snippet rows. A stale cursor (rebuilt index)
    // restarts from the first page once.
    if (req.method === 'GET' && parts.length === 2 && parts[0] === 'sessions' && parts[1] === 'search') {
      const query = normalizeSearchQuery(url.searchParams.get('q') ?? '')
      const cursorRaw = url.searchParams.get('cursor')
      const cursor = cursorRaw === null || cursorRaw === '' ? undefined : SessionSearchCursor(cursorRaw)
      const requestPage = (pageCursor: SessionSearchCursor | undefined) =>
        ctx.sessionQuery.searchSessions({
          query,
          eventFilters: [
            { kind: 'type', values: ['user/message', 'assistant/message'] },
            { kind: 'surface', values: ['current'] },
          ],
          limit: SEARCH_PAGE_LIMIT,
          ...pageCursor !== undefined ? { cursor: pageCursor } : {},
        })
      let page: SessionSearchPage<SessionSearchHit>
      try {
        page = await requestPage(cursor)
      } catch (error: unknown) {
        if (cursor !== undefined
          && error instanceof SessionQueryError
          && error.code === 'SESSION_QUERY_STALE_CURSOR') {
          page = await requestPage(undefined)
        } else {
          throw error
        }
      }
      const hits = page.items.filter(hit => hit.header.origin !== 'subagent')
      const titleOf = await titleMapOf(hits)
      sendJson(res, 200, {
        hits: hits.map((hit) => {
          const id = String(hit.header.id)
          const title = titleOf.get(id)
          return {
            id,
            title: title?.text ?? 'New chat',
            snippet: truncateSnippet(hit.bestMatch.snippet),
            updatedAt: title?.updatedAt ?? hit.header.createdAt,
          }
        }),
        ...page.nextCursor !== undefined ? { nextCursor: String(page.nextCursor) } : {},
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
        // Attachments ride the same JSON body as base64 data URLs; the cap
        // above leaves headroom for one video.
        const body = await readJsonBody(req, MESSAGE_BODY_CAP)
        const text = body.text
        if (typeof text !== 'string' || (text.trim().length === 0 && body.attachment === undefined)) {
          sendJson(res, 400, { error: 'a message needs text or an attachment' })
          return
        }
        let content: ContentBlock[] = []
        if (body.attachment !== undefined) {
          const store = ctx.get('attachments')
          if (store === undefined) {
            sendJson(res, 400, { error: 'attachment storage is not available in this composition' })
            return
          }
          const kind = attachmentKind(body.attachment)
          if (kind === undefined) {
            sendJson(res, 400, { error: 'attachment kind must be image or video' })
            return
          }
          const abilities = await ensureModelAbilities(activeProfile(settings).model)
          if (kind !== 'file' && abilities[kind] !== 'yes') {
            sendJson(res, 400, { error: `this model does not accept ${kind} input (probe says ${abilities[kind]})` })
            return
          }
          const parsed = parseAttachment(body.attachment)
          if (parsed.kind === 'image') {
            const [ref] = await store.saveImages([{
              data: parsed.data,
              mediaType: parsed.mediaType as import('@deepseek-ai/dsh-attachment').ImageMediaType,
              ...parsed.name !== '' ? { name: parsed.name } : {},
            }])
            if (ref === undefined) throw new Error('the image was not stored')
            content.push({ type: 'image', attachment: ref })
          } else if (parsed.kind === 'video') {
            const ref = await store.saveFile({
              data: parsed.data,
              ...parsed.name !== '' ? { name: parsed.name } : {},
            })
            content.push({ type: 'video', attachment: ref, mediaType: parsed.mediaType })
          } else {
            const ref = await store.saveFile({
              data: parsed.data,
              ...parsed.name !== '' ? { name: parsed.name } : {},
            })
            content.push({ type: 'file', attachment: ref })
          }
        }
        const trimmed = text.trim()
        if (trimmed !== '') content = [...content, { type: 'text', text: trimmed }]
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
          content,
          source: { kind: 'user' },
        }))
        return
      }
      sendJson(res, 405, { allow: 'GET, POST' })
      return
    }

    if (req.method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'stop') {
      const sessionId = parts[1] as string
      const entry = handles.get(sessionId)
      if (entry !== undefined) entry.handle.agent.cancel({ kind: 'user' })
      sendJson(res, 200, { stopped: entry !== undefined })
      return
    }

    // Attachment bytes for rendered history: the caller echoes the durable
    // reference the projection handed it; digest verification inside the
    // store makes a tampered reference fail closed. Content-addressed ids
    // make the responses permanently cacheable.
    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'attachment') {
      const body = await readJsonBody(req)
      const store = ctx.get('attachments')
      if (store === undefined
        || (body.kind !== 'image' && body.kind !== 'video')
        || typeof body.ref !== 'object' || body.ref === null
        || typeof body.mediaType !== 'string' || !/^(image|video)\//.test(body.mediaType)) {
        sendJson(res, 400, { error: 'attachment request must carry kind, mediaType, and ref' })
        return
      }
      if (body.kind === 'image' && body.ref !== null && typeof body.ref === 'object') {
        const stored = await store.readImage(body.ref as unknown as ImageAttachmentRef)
        res.writeHead(200, {
          'content-type': stored.ref.mediaType,
          'cache-control': 'public, max-age=31536000, immutable',
        })
        res.end(Buffer.from(stored.data))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of store.readFileStream(body.ref as unknown as import('@deepseek-ai/dsh-attachment').FileAttachmentRef)) {
        chunks.push(Buffer.from(chunk))
      }
      res.writeHead(200, {
        'content-type': body.mediaType,
        'cache-control': 'public, max-age=31536000, immutable',
      })
      res.end(Buffer.concat(chunks))
      return
    }

    // Model input-modalities: the endpoint's /models list says nothing about
    // them, so the answer comes from probing the model itself with a minimal
    // image and video part. Cached per model id for the process's life.
    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'capabilities') {
      const body = await readJsonBody(req)
      const active = activeProfile(settings)
      const model = typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : active.model
      sendJson(res, 200, await ensureModelAbilities(model))
      return
    }

    // Chrome-bridge endpoints. The extension long-polls `next` and runs the
    // job with the user's cookies; every request refreshes its heartbeat.
    // `status` and `test` feed the settings panel's connection row. Responses
    // carry a reflecting CORS allow-origin so the extension's service worker
    // can read what it asked for, and OPTIONS answers its JSON preflights.
    if (req.method === 'OPTIONS' && parts.length >= 2 && parts[0] === 'chrome') {
      const origin = typeof req.headers.origin === 'string' && req.headers.origin.startsWith('chrome-extension://')
        ? req.headers.origin
        : '*'
      res.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      })
      res.end()
      return
    }

    if (req.method === 'GET' && parts.length === 2 && parts[0] === 'chrome' && parts[1] === 'next') {
      extensionBridge.markSeen()
      const waitRaw = Number.parseInt(url.searchParams.get('wait') ?? '', 10)
      const waitSeconds = Math.min(Math.max(Number.isFinite(waitRaw) ? waitRaw : 25, 1), 55)
      const job = await extensionBridge.nextJob(waitSeconds * 1000)
      sendJson(res, 200, { job }, chromeCors(req))
      return
    }

    if (req.method === 'POST' && parts.length === 2 && parts[0] === 'chrome' && parts[1] === 'result') {
      extensionBridge.markSeen()
      const body = await readJsonBody(req)
      sendJson(res, 200, { accepted: extensionBridge.settle(body) }, chromeCors(req))
      return
    }

    if (req.method === 'GET' && parts.length === 2 && parts[0] === 'chrome' && parts[1] === 'status') {
      sendJson(res, 200, {
        extension: extensionBridge.seenWithin(EXTENSION_TTL_MS),
        cdp: await chromeEngine.probe(),
        ...extensionPath !== undefined ? { extensionPath } : {},
      }, chromeCors(req))
      return
    }

    if (req.method === 'POST' && parts.length === 2 && parts[0] === 'chrome' && parts[1] === 'test') {
      // A quota-burn vector no real path uses: model searches ride the
      // selector, never this endpoint.
      if (!probeLimiter.allow()) {
        sendJson(res, 429, { error: 'too many test searches — wait a few minutes' }, chromeCors(req))
        return
      }
      const body = await readJsonBody(req)
      const query = typeof body.query === 'string' && body.query.trim() !== '' ? body.query.trim() : 'hello world'
      const startedAt = Date.now()
      try {
        const outcome = await userChromeSearch({ query, maxResults: 5 })
        sendJson(res, 200, {
          ok: true,
          engine: outcome.engine,
          count: outcome.result.sources.length,
          sample: outcome.result.sources.slice(0, 3).map(source => source.title),
          ms: Date.now() - startedAt,
        }, chromeCors(req))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        sendJson(res, 200, {
          ok: false,
          engine: extensionBridge.seenWithin(EXTENSION_TTL_MS) ? 'extension' : 'cdp',
          error: message,
        }, chromeCors(req))
      }
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
    void serveStatic(req, res, distRoot, sessionToken).catch(() => {
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
