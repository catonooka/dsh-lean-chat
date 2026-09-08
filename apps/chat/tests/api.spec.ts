/**
 * Unit coverage for the browser API client: error extraction, request URL
 * and body shapes, and the SSE stream parser (chunk boundaries, malformed
 * frames, failure responses) — everything except the network itself, which
 * is stubbed per test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_PAGE_SIZE,
  fetchMessages,
  fetchModels,
  fetchProviders,
  listSessions,
  searchSessions,
  sendMessage,
  stopSession,
  updateConfig,
} from '../src/api.ts'

/** One JSON Response stub with the given status. */
function jsonResponse(status: number, body: unknown): Response {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Status Text',
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
  return { ...response, clone: () => response } as unknown as Response
}

/** A fetch stub that records calls and answers with canned responses. */
function stubFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  const mock = vi.fn((url: string, init?: RequestInit) => Promise.resolve(responder(url, init)))
  vi.stubGlobal('fetch', mock)
  return mock as unknown as typeof fetch
}

/** Build a reader-backed body that yields the given strings chunk by chunk. */
function sseBody(chunks: readonly string[]): unknown {
  let index = 0
  return {
    getReader: () => ({
      read: async () => index < chunks.length
        ? { done: false as const, value: new TextEncoder().encode(chunks[index++]) }
        : { done: true as const, value: undefined },
    }),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchJson error extraction', () => {
  it('prefers the error field from the body over the status line', async () => {
    stubFetch(() => jsonResponse(400, { error: 'unknown provider "x"' }))
    await expect(updateConfig({ provider: 'x' })).rejects.toThrow('unknown provider "x"')
  })

  it('falls back to the status line when the body has no error or is not JSON', async () => {
    stubFetch(() => jsonResponse(500, { note: 'no error field' }))
    await expect(fetchMessages('s')).rejects.toThrow('500 Status Text')
    const notJson = { ok: false, status: 502, statusText: 'Bad Gateway' } as unknown as Response
    stubFetch(() => notJson)
    await expect(fetchMessages('s')).rejects.toThrow('502 Bad Gateway')
  })
})

describe('request builders', () => {
  it('lists sessions with limit and offset only when given', async () => {
    const mock = stubFetch(() => jsonResponse(200, { sessions: [], total: 0 }))
    await listSessions()
    await listSessions({ limit: 20, offset: 40 })
    expect(mock.mock.calls.map(call => String(call[0]))).toEqual([
      '/api/sessions',
      '/api/sessions?limit=20&offset=40',
    ])
    expect(SESSION_PAGE_SIZE).toBe(20)
  })

  it('encodes the search query and appends the cursor when present', async () => {
    const mock = stubFetch(() => jsonResponse(200, { hits: [] }))
    await searchSessions('giá vàng hôm nay')
    await searchSessions('x', 'cursor-1')
    expect(mock.mock.calls.map(call => String(call[0]))).toEqual([
      '/api/sessions/search?q=gi%C3%A1+v%C3%A0ng+h%C3%B4m+nay',
      '/api/sessions/search?q=x&cursor=cursor-1',
    ])
  })

  it('sends updateConfig as a JSON PUT and unwraps model and provider lists', async () => {
    const mock = stubFetch(() => jsonResponse(200, { models: ['b', 'a', 'b'] }))
    await fetchModels()
    expect(mock).toHaveBeenCalledWith('/api/models', undefined)
    stubFetch(() => jsonResponse(200, { providers: [{ id: 'deepseek-official', name: 'DeepSeek' }] }))
    await expect(fetchProviders()).resolves.toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
    stubFetch((_url, init) => {
      expect(init?.method).toBe('PUT')
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'm' })
      return jsonResponse(200, {})
    })
    await updateConfig({ model: 'm' })
  })

  it('stops a session with a bare POST', async () => {
    const mock = stubFetch(() => jsonResponse(200, { stopped: true }))
    await expect(stopSession('abc')).resolves.toBeUndefined()
    expect(mock).toHaveBeenCalledWith('/api/sessions/abc/stop', { method: 'POST' })
  })
})

/** A 200 Response stub carrying the given stream body. */
const okResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', body } as unknown as Response)

describe('sendMessage SSE parsing', () => {

  it('dispatches every frame once, across chunk boundaries mid-line', async () => {
    stubFetch(() => okResponse(sseBody([
      ':connected\n\n',
      'data: {"t":"user","tex',
      't":"hi"}\n\ndata: {"t":"delta","text":"there"}',
      '\n\ndata: {"t":"turn-end","reason":"completed"}\n\n',
    ])))
    const events: unknown[] = []
    await sendMessage('s', 'hi', undefined, (event) => { events.push(event) })
    expect(events).toEqual([
      { t: 'user', text: 'hi' },
      { t: 'delta', text: 'there' },
      { t: 'turn-end', reason: 'completed' },
    ])
  })

  it('ignores non-data lines and malformed data frames without stopping', async () => {
    stubFetch(() => okResponse(sseBody([': comment\nx-ignored: 1\ndata: not json\ndata: {"t":"status","status":"running"}\n\n'])))
    const events: unknown[] = []
    await sendMessage('s', 'hi', undefined, (event) => { events.push(event) })
    expect(events).toEqual([{ t: 'status', status: 'running' }])
  })

  it('surfaces the error body of a rejected send', async () => {
    stubFetch(() => jsonResponse(400, { error: 'text must be a non-empty string' }))
    await expect(sendMessage('s', '', undefined, () => undefined)).rejects.toThrow('text must be a non-empty string')
  })

  it('throws on a missing stream body', async () => {
    stubFetch(() => ({ ok: true, status: 200, statusText: 'OK', body: null } as unknown as Response))
    await expect(sendMessage('s', 'hi', undefined, () => undefined)).rejects.toThrow('200 OK')
  })
})

describe('sendMessage attachments', () => {
  it('rides the attachment in the POST body and omits it when absent', async () => {
    const calls: unknown[] = []
    stubFetch((_url, init) => {
      calls.push(JSON.parse(String(init?.body)))
      return okResponse(sseBody(['data: {"t":"turn-end","reason":"completed"}\n\n']))
    })
    await sendMessage('s', 'what is this', { kind: 'image', name: 'red.png', dataUrl: 'data:image/png;base64,AAAA' }, () => undefined)
    await sendMessage('s', 'plain', undefined, () => undefined)
    expect(calls).toEqual([
      { text: 'what is this', attachment: { kind: 'image', name: 'red.png', dataUrl: 'data:image/png;base64,AAAA' } },
      { text: 'plain' },
    ])
  })

  it('fetches attachment bytes by echoing the durable reference', async () => {
    const mock = stubFetch(() => okResponse(sseBody([])) as unknown as Response)
    void mock
    const blob = new Blob(['x'])
    stubFetch(() => ({ ok: true, status: 200, blob: async () => blob } as unknown as Response))
    const { fetchAttachmentBlob } = await import('../src/api.ts')
    await expect(fetchAttachmentBlob({ kind: 'video', mediaType: 'video/mp4', ref: { attachmentId: 'v1' } }))
      .resolves.toBe(blob)
  })
})

describe('sendMessage callback failures', () => {
  it('propagates a throwing callback instead of swallowing it as a malformed frame', async () => {
    stubFetch(() => okResponse(sseBody(['data: {"t":"user","text":"hi"}\n\n'])))
    await expect(sendMessage('s', 'hi', undefined, () => { throw new Error('render exploded') }))
      .rejects.toThrow('render exploded')
  })
})

describe('isCleartextEndpoint', () => {
  it('flags plain http endpoints and passes https or empty values', async () => {
    const { isCleartextEndpoint } = await import('../src/Settings.tsx')
    expect(isCleartextEndpoint('http://localhost:11434/v1')).toBe(true)
    expect(isCleartextEndpoint('  http://192.168.1.5/v1 ')).toBe(true)
    expect(isCleartextEndpoint('https://mllm.example/v1')).toBe(false)
    expect(isCleartextEndpoint('HTTPS://x')).toBe(false)
    expect(isCleartextEndpoint('')).toBe(false)
    expect(isCleartextEndpoint('http:// ')).toBe(false)
  })
})

describe('classifyPastedFile', () => {
  it('routes media by mime and text shapes by extension', async () => {
    const { classifyPastedFile } = await import('../src/App.tsx')
    expect(classifyPastedFile({ type: 'image/png', name: 'shot.png' })).toBe('image')
    expect(classifyPastedFile({ type: 'video/mp4', name: 'clip.mp4' })).toBe('video')
    expect(classifyPastedFile({ type: 'text/plain', name: 'notes.txt' })).toBe('text')
    expect(classifyPastedFile({ type: '', name: 'script.ts' })).toBe('text')
    expect(classifyPastedFile({ type: '', name: 'notes.markdown' })).toBe('text')
    expect(classifyPastedFile({ type: 'application/pdf', name: 'report.pdf' })).toBe('file')
    expect(classifyPastedFile({ type: '', name: 'archive' })).toBe('file')
    expect(classifyPastedFile({ type: '', name: 'archive.ZIP' })).toBe('file')
  })
})

describe('session-cookie self-heal', () => {
  it('retries once through a page refetch after a session-cookie 403', async () => {
    const calls: string[] = []
    stubFetch((url) => {
      calls.push(String(url))
      if (calls.filter(c => c.includes('/api/config')).length === 1) {
        return jsonResponse(403, { error: 'session cookie required' })
      }
      if (String(url) === '/' || String(url) === 'http://x/') return { ok: true, status: 200 } as unknown as Response
      return jsonResponse(200, { provider: 'p' })
    })
    const { fetchConfig } = await import('../src/api.ts')
    await expect(fetchConfig()).resolves.toEqual({ provider: 'p' })
    expect(calls.filter(c => c.includes('/api/config'))).toHaveLength(2)
    expect(calls.some(c => c === '/' || c.includes('//127.0.0.1:3095/')) || calls.includes('/')).toBe(true)
  })

  it('does not retry other 403s or transient failures', async () => {
    let count = 0
    stubFetch(() => {
      count += 1
      return jsonResponse(403, { error: 'local requests only' })
    })
    const { fetchConfig } = await import('../src/api.ts')
    await expect(fetchConfig()).rejects.toThrow('local requests only')
    expect(count).toBe(1)
  })
})
