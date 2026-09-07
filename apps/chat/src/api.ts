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

export interface AppConfig {
  provider: string
  model: string
  reasoningEffort?: string
  temperature?: number
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

export function listSessions(): Promise<SessionSummary[]> {
  return fetchJson<{ sessions: SessionSummary[] }>('/api/sessions').then(body => body.sessions)
}

export function fetchMessages(sessionId: string): Promise<ChatItem[]> {
  return fetchJson<{ items: ChatItem[] }>(`/api/sessions/${sessionId}/messages`).then(body => body.items)
}

export function fetchConfig(): Promise<AppConfig> {
  return fetchJson<AppConfig>('/api/config')
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
        try {
          onEvent(JSON.parse(line.slice(6)) as StreamEvent)
        } catch {
          // Ignore malformed frames; the stream continues.
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}
