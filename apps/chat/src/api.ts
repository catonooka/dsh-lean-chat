/** Browser API client for the dsh chat surface (/api + SSE). */

import type { ReplyContext } from './reply.ts'

export interface ChatSource {
  url: string
  title?: string
  publishedAt?: string
}

/** One attachment as history serves it, or as the composer holds it locally. */
export interface ChatAttachment {
  kind: 'image' | 'video' | 'file'
  name?: string
  attachmentId?: string
  mediaType: string
  /** History entries carry the durable reference to fetch bytes with. */
  ref?: unknown
  /** Live messages preview from the local data URL instead. */
  localUrl?: string
}

export interface ChatItem {
  role: 'user' | 'assistant' | 'tool' | 'compaction'
  text?: string
  attachments?: ChatAttachment[]
  /** Which message this user message answers, as a short quote. */
  replyTo?: ReplyContext
  name?: string
  query?: string
  searchQuestion?: string
  searchedAt?: string
  sources?: ChatSource[]
  action?: string
  url?: string
  title?: string
  excerpt?: string
  /** The tool call settled as a failure; chips say so instead of looking done. */
  error?: boolean
  running?: boolean
}

export interface SessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  live: boolean
  /** The chat sits on the archived shelf. */
  archived?: boolean
  /** The acting user's group the chat belongs to, or null when ungrouped. */
  groupId?: string | null
}

export interface SearchHit {
  id: string
  title: string
  snippet: string
  updatedAt: number
}

/** One saved provider profile (a "model character") as the server serves it
 * (never its key). Persona, greeting, and avatar are the character's own. */
export interface ProfileInfo {
  id: string
  name: string
  model: string
  persona?: string
  greeting?: string
  avatar?: number
  baseUrl?: string
  apiKeySet?: boolean
}

export interface AppConfig {
  provider: string
  model: string
  reasoningEffort?: string
  temperature?: number
  persona: string
  /** The active character's welcome question on an empty chat. */
  greeting?: string
  /** The active character's avatar tile; absent = the classic bot avatar. */
  avatar?: number
  baseUrl?: string
  apiKeySet?: boolean
  searchTool?: string
  autoCompact?: boolean
  activeProfileId?: string
  profiles?: ProfileInfo[]
}

/** One partial settings update; `null` clears an optional field. */
export interface SettingsPatch {
  provider?: string
  model?: string
  reasoningEffort?: string | null
  temperature?: number | null
  /** The active character's system prompt; empty clears to the default. */
  persona?: string
  /** The active character's welcome question; empty clears to the default. */
  greeting?: string
  /** The active character's avatar tile; `null` restores the classic bot avatar. */
  avatar?: number | null
  baseUrl?: string | null
  apiKey?: string
  searchTool?: string
  /** Toggle conversation auto-compaction; `null` restores the default (on). */
  autoCompact?: boolean | null
  /** Make this profile active; its fields become the flat projection. */
  switchProfile?: string
  renameProfile?: { id: string; name: string }
  newProfile?: { name?: string; avatar?: number; persona?: string }
  deleteProfile?: { id: string }
}

/** One chat group a user organizes their chats into. */
export interface ChatGroupInfo {
  id: string
  name: string
}

/** One lightweight user profile, as the server serves it. */
export interface UserInfo {
  id: string
  name: string
  avatar?: number
  chromeProfile?: string
  groups: ChatGroupInfo[]
}

/** The roster plus which id requests act for when no header names one. */
export interface UsersBody {
  users: UserInfo[]
  defaultUserId: string
  createdId?: string
  updatedId?: string
}

/** The user roster; switching is client state (the x-dsh-user header). */
export function listUsers(): Promise<UsersBody> {
  return fetchJson<UsersBody>('/api/users')
}

/** Add one user profile. The caller switches to it by setting the header. */
export function createUser(input: { name: string; avatar?: number; chromeProfile?: string }): Promise<UsersBody> {
  return fetchJson<UsersBody>('/api/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

/** Edit one user profile; a blank chromeProfile unsets it. */
export function updateUser(
  id: string,
  patch: { name?: string; avatar?: number; chromeProfile?: string },
): Promise<UsersBody> {
  return fetchJson<UsersBody>(`/api/users/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/**
 * Fetch with one self-healing retry: a 403 session-cookie rejection (a
 * server restart rotated expectations) refetches the page to receive a fresh
 * HttpOnly cookie, then replays the request once.
 */
async function fetchWithSessionHeal(url: string, init?: RequestInit): Promise<Response> {
  const first = await fetch(url, withUserHeader(init))
  if (first.status !== 403) return first
  const reason = await first.clone().text().catch(() => '')
  if (!reason.includes('session cookie required')) return first
  await fetch('/', { cache: 'no-store' }).catch(() => undefined)
  return await fetch(url, withUserHeader(init))
}

/** localStorage key holding the acting user profile's id across reloads. */
const USER_STORAGE_KEY = 'dsh-chat-user'

/** The acting user profile's id, stamped on every API call via x-dsh-user. */
let actingUserId = readStoredUserId()

/** The stored acting user id; undefined when this browser never picked one. */
export function readStoredUserId(): string | undefined {
  try {
    const raw = localStorage.getItem(USER_STORAGE_KEY)
    return raw === null || raw === '' ? undefined : raw
  } catch {
    // No localStorage in this environment; requests ride without the header.
    return undefined
  }
}

/** Switch the acting profile: header state and storage update together. */
export function setActingUser(id: string | undefined): void {
  actingUserId = id
  try {
    if (id === undefined) localStorage.removeItem(USER_STORAGE_KEY)
    else localStorage.setItem(USER_STORAGE_KEY, id)
  } catch {
    // Storage-less environments keep the in-memory switch only.
  }
}

/** Copy one request init with the acting user header attached. */
function withUserHeader(init: RequestInit | undefined): RequestInit | undefined {
  if (actingUserId === undefined) return init
  const headers = new Headers(init?.headers)
  headers.set('x-dsh-user', actingUserId)
  return { ...init, headers }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithSessionHeal(url, init)
  if (!response.ok) {
    let message = `${String(response.status)} ${response.statusText}`
    try {
      const body = await response.json() as { error?: unknown }
      if (typeof body.error === 'string') message = body.error
    } catch {
      // Keep the status-line message.
    }
    throw new Error(message)
  }
  return await response.json() as T
}

/** Sidebar list page size; load-more requests the next offset. */
export const SESSION_PAGE_SIZE = 20

export function listSessions(
  params: { limit?: number; offset?: number; archived?: boolean } = {},
): Promise<{ sessions: SessionSummary[]; total: number }> {
  const search = new URLSearchParams()
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  if (params.archived === true) search.set('archived', '1')
  const suffix = search.size > 0 ? `?${search.toString()}` : ''
  return fetchJson<{ sessions: SessionSummary[]; total: number }>(`/api/sessions${suffix}`)
}

/** Rename, archive/unarchive, or regroup one chat. */
export function patchSession(
  sessionId: string,
  patch: { title?: string; archived?: boolean; groupId?: string | null },
): Promise<{ sessionId: string; title?: string; archived: boolean; groupId: string | null }> {
  return fetchJson(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** Delete one chat for good (its log directory goes with it). */
export function deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
  return fetchJson<{ deleted: boolean }>(`/api/sessions/${sessionId}`, { method: 'DELETE' })
}

export function searchSessions(query: string, cursor?: string): Promise<{ hits: SearchHit[]; nextCursor?: string }> {
  const search = new URLSearchParams({ q: query })
  if (cursor !== undefined) search.set('cursor', cursor)
  return fetchJson<{ hits: SearchHit[]; nextCursor?: string }>(`/api/sessions/search?${search.toString()}`)
}

export function fetchMessages(sessionId: string): Promise<ChatItem[]> {
  return fetchJson<{ items: ChatItem[] }>(`/api/sessions/${sessionId}/messages`).then(body => body.items)
}

export function fetchConfig(): Promise<AppConfig> {
  return fetchJson<AppConfig>('/api/config')
}

/** The panel's unsaved endpoint edits, so a probe interrogates what is on
 * screen instead of the last saved profile. Absent fields mean "not typed" —
 * the server falls back to the saved profile, then the launch environment. */
export interface EndpointProbe {
  baseUrl?: string
  apiKey?: string
}

/** Model ids advertised by an endpoint — the panel's edits when given,
 * otherwise the saved profile. */
export function fetchModels(probe?: EndpointProbe): Promise<string[]> {
  return fetchJson<{ models: string[] }>('/api/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(probe ?? {}),
  }).then(body => body.models)
}

/** Input modalities of one model, as probed server-side. */
export interface ModelAbilities {
  model: string
  image: 'yes' | 'no' | 'unknown'
  video: 'yes' | 'no' | 'unknown'
}

/** Probe whether a model accepts image and video input parts — against the
 * panel's edits when given, otherwise the saved endpoint. */
export function checkModelAbilities(model?: string, probe?: EndpointProbe): Promise<ModelAbilities> {
  return fetchJson<ModelAbilities>('/api/capabilities', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(model === undefined ? {} : { model }),
      ...(probe ?? {}),
    }),
  })
}

export interface ProviderInfo {
  id: string
  name: string
}

/** Adapter routes this composition registers; `provider` must be one. */
export function fetchProviders(): Promise<ProviderInfo[]> {
  return fetchJson<{ providers: ProviderInfo[] }>('/api/providers').then(body => body.providers)
}

export function updateConfig(patch: SettingsPatch): Promise<AppConfig> {
  return fetchJson<AppConfig>('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** Whether each chrome engine answers right now. */
export interface ChromeStatus {
  extension: boolean
  /** Connected Chrome profile labels, freshest first, with action opt-ins. */
  clients?: { client: string; lastSeenAt: number; actuation?: boolean }[]
  cdp: boolean
  extensionPath?: string
}

/** Connection state of the chrome engines (extension heartbeat, debug port). */
export function fetchChromeStatus(): Promise<ChromeStatus> {
  return fetchJson<ChromeStatus>('/api/chrome/status')
}

/** One real search run through whichever chrome engine is connected. */
export interface ChromeTestOutcome {
  ok: boolean
  engine?: 'extension' | 'cdp'
  count?: number
  sample?: string[]
  ms?: number
  error?: string
}

/** Run a probe search through the user-chrome engine and report how it went. */
export function testChromeSearch(query?: string): Promise<ChromeTestOutcome> {
  return fetchJson<ChromeTestOutcome>('/api/chrome/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(query === undefined ? {} : { query }),
  })
}

/** Fetch one attachment's bytes for rendering (history entries). */
export async function fetchAttachmentBlob(attachment: ChatAttachment): Promise<Blob> {
  const response = await fetchWithSessionHeal('/api/attachment', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: attachment.kind, mediaType: attachment.mediaType, ref: attachment.ref }),
  })
  if (!response.ok) throw new Error(`attachment fetch failed: ${String(response.status)}`)
  return await response.blob()
}

export function stopSession(sessionId: string): Promise<void> {
  return fetchJson(`/api/sessions/${sessionId}/stop`, { method: 'POST' }).then(() => undefined)
}

/** One SSE `data:` payload, as emitted by the chat-app glue. */
export type StreamEvent =
  | { t: 'user'; text: string }
  | { t: 'delta'; text: string }
  | { t: 'assistant'; text: string }
  | { t: 'tool-start'; name: string; query?: string; action?: string; url?: string }
  | { t: 'tool-end'; name?: string; query?: string; searchQuestion?: string; searchedAt?: string; sources?: ChatSource[]; action?: string; url?: string; title?: string; excerpt?: string; text?: string; isError?: boolean }
  | { t: 'status'; status: 'running' | 'idle' }
  | { t: 'turn-end'; reason: string }
  | { t: 'compaction'; text: string }
  | { t: 'error'; message: string }

/** One attachment the composer holds: the raw file plus a local blob preview.
 * The bytes upload once (raw body, never base64-serialized); only the durable
 * reference rides the message. */
export interface OutgoingAttachment {
  kind: 'image' | 'video' | 'file'
  name: string
  mediaType: string
  file: File
  /** Blob URL previewing the bytes in the chip and the sent bubble. */
  localUrl: string
}

/** One stored upload: the message send echoes this durable reference. */
export interface UploadedAttachment {
  kind: 'image' | 'video' | 'file'
  name: string
  mediaType: string
  ref: unknown
}

/** Upload one attachment's exact bytes ahead of the message that cites them. */
export function uploadAttachment(attachment: OutgoingAttachment): Promise<UploadedAttachment> {
  const search = new URLSearchParams({ kind: attachment.kind, name: attachment.name })
  return fetchJson<{ kind: 'image' | 'video' | 'file'; mediaType: string; ref: unknown }>(`/api/uploads?${search.toString()}`, {
    method: 'POST',
    headers: { 'content-type': attachment.mediaType },
    body: attachment.file,
  }).then(body => ({ kind: body.kind, name: attachment.name, mediaType: body.mediaType, ref: body.ref }))
}

/** Send one message (with its optional uploaded attachment and reply target)
 * and dispatch its SSE stream. */
export async function sendMessage(
  sessionId: string,
  text: string,
  attachment: UploadedAttachment | undefined,
  replyTo: ReplyContext | undefined,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const response = await fetchWithSessionHeal(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      ...attachment !== undefined
        ? { attachment: { kind: attachment.kind, mediaType: attachment.mediaType, ref: attachment.ref } }
        : {},
      ...replyTo !== undefined ? { replyTo } : {},
    }),
  })
  await readEventStream(response, onEvent)
}

/** Re-run the last user turn (after a failure or to regenerate) and dispatch its stream. */
export async function retrySession(sessionId: string, onEvent: (event: StreamEvent) => void): Promise<void> {
  const response = await fetchWithSessionHeal(`/api/sessions/${sessionId}/retry`, { method: 'POST' })
  await readEventStream(response, onEvent)
}

/** Compact one conversation now and report whether a reduction ran. */
export function compactSession(sessionId: string): Promise<{ compacted: boolean }> {
  return fetchJson<{ compacted: boolean }>(`/api/sessions/${sessionId}/compact`, { method: 'POST' })
}

/** Verify one SSE response and pump its `data:` frames to the callback. */
async function readEventStream(response: Response, onEvent: (event: StreamEvent) => void): Promise<void> {
  if (!response.ok || response.body === null) {
    let message = `${String(response.status)} ${response.statusText}`
    try {
      const body = await response.json() as { error?: unknown }
      if (typeof body.error === 'string') message = body.error
    } catch {
      // Keep the status-line message.
    }
    throw new Error(message)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue
        let parsed: StreamEvent
        try {
          parsed = JSON.parse(line.slice(6)) as StreamEvent
        } catch {
          // Ignore malformed frames; the stream continues.
          continue
        }
        onEvent(parsed)
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}
