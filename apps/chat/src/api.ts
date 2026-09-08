/** Browser API client for the dsh chat surface (/api + SSE). */

export interface ChatSource {
  url: string
  title?: string
  publishedAt?: string
}

export interface ChatItem {
  role: 'user' | 'assistant' | 'tool'
  text?: string
  name?: string
  query?: string
  searchQuestion?: string
  searchedAt?: string
  sources?: ChatSource[]
  running?: boolean
}

export interface SessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  live: boolean
}

export interface SearchHit {
  id: string
  title: string
  snippet: string
  updatedAt: number
}

/** One saved provider profile as the server serves it (never its key). */
export interface ProfileInfo {
  id: string
  name: string
  model: string
  baseUrl?: string
  apiKeySet?: boolean
}

export interface AppConfig {
  provider: string
  model: string
  reasoningEffort?: string
  temperature?: number
  persona: string
  baseUrl?: string
  apiKeySet?: boolean
  searchTool?: string
  activeProfileId?: string
  profiles?: ProfileInfo[]
}

/** One partial settings update; `null` clears an optional field. */
export interface SettingsPatch {
  provider?: string
  model?: string
  reasoningEffort?: string | null
  temperature?: number | null
  persona?: string
  baseUrl?: string | null
  apiKey?: string
  searchTool?: string
  /** Make this profile active; its fields become the flat projection. */
  switchProfile?: string
  renameProfile?: { id: string; name: string }
  newProfile?: { name?: string }
  deleteProfile?: { id: string }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
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

export function listSessions(params: { limit?: number; offset?: number } = {}): Promise<{ sessions: SessionSummary[]; total: number }> {
  const search = new URLSearchParams()
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  const suffix = search.size > 0 ? `?${search.toString()}` : ''
  return fetchJson<{ sessions: SessionSummary[]; total: number }>(`/api/sessions${suffix}`)
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

/** Model ids advertised by the currently configured endpoint. */
export function fetchModels(): Promise<string[]> {
  return fetchJson<{ models: string[] }>('/api/models').then(body => body.models)
}

/** Input modalities of one model, as probed server-side. */
export interface ModelAbilities {
  model: string
  image: 'yes' | 'no' | 'unknown'
  video: 'yes' | 'no' | 'unknown'
}

/** Probe whether a model accepts image and video input parts. */
export function checkModelAbilities(model?: string): Promise<ModelAbilities> {
  return fetchJson<ModelAbilities>('/api/capabilities', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(model === undefined ? {} : { model }),
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

export function stopSession(sessionId: string): Promise<void> {
  return fetchJson(`/api/sessions/${sessionId}/stop`, { method: 'POST' }).then(() => undefined)
}

/** One SSE `data:` payload, as emitted by the chat-app glue. */
export type StreamEvent =
  | { t: 'user'; text: string }
  | { t: 'delta'; text: string }
  | { t: 'assistant'; text: string }
  | { t: 'tool-start'; name: string; query?: string }
  | { t: 'tool-end'; name?: string; query?: string; searchQuestion?: string; searchedAt?: string; sources?: ChatSource[]; text?: string; isError?: boolean }
  | { t: 'status'; status: 'running' | 'idle' }
  | { t: 'turn-end'; reason: string }
  | { t: 'error'; message: string }

/** Send one message and dispatch its SSE stream until the server closes it. */
export async function sendMessage(sessionId: string, text: string, onEvent: (event: StreamEvent) => void): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
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
