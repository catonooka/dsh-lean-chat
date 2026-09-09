// @vitest-environment jsdom

/**
 * Component coverage for the chat surface's reply flow and rail: the reply
 * chip pins a target without touching the draft, sends carry the replyTo
 * context and render a quote, actions sit under the message, the collapsed
 * rail keeps new chat, and switching conversations drops a pending reply.
 * The network is stubbed per test — these exercise the wiring, not the API.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App.tsx'
import type { ChatItem } from '../src/api.ts'

/** One stubbed JSON Response for the mount-time GETs. */
const jsonResponse = (body: unknown): Response => {
  const response = {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
  return { ...response, clone: () => response } as unknown as Response
}

/** One stubbed 200 SSE Response yielding the given frames, then done. */
const sseResponse = (events: readonly unknown[]): Response => {
  const chunks = events.map(event => `data: ${JSON.stringify(event)}\n\n`)
  let index = 0
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length
            ? { done: false as const, value: new TextEncoder().encode(chunks[index++] as string) }
            : { done: true as const, value: undefined },
      }),
    },
  } as unknown as Response
}

interface SessionFixture {
  id: string
  title: string
  items: ChatItem[]
}

/**
 * Render the app against a fetch router: sessions + config on mount, message
 * history for known sessions, and a queue of SSE streams for sends.
 */
async function renderApp(options: {
  sessions?: SessionFixture[]
  activeId?: string
  streams?: Response[]
} = {}): Promise<{ posts: { url: string; body: Record<string, unknown> }[]; historyFetches: string[] }> {
  const sessions = options.sessions ?? []
  const posts: { url: string; body: Record<string, unknown> }[] = []
  const historyFetches: string[] = []
  const streams = [...options.streams ?? []]
  const summaries = sessions.map(session => ({
    id: session.id,
    title: session.title,
    createdAt: 1,
    updatedAt: 2,
    live: true,
  }))
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.startsWith('/api/sessions?')) return Promise.resolve(jsonResponse({ sessions: summaries, total: summaries.length }))
    if (url === '/api/config') return Promise.resolve(jsonResponse({ provider: 'p', model: 'm', persona: 'x' }))
    if (url === '/api/capabilities') return Promise.resolve(jsonResponse({ model: 'm', image: 'no', video: 'no' }))
    const history = sessions.find(session => url === `/api/sessions/${session.id}/messages`)
    if (history !== undefined && method === 'GET') {
      historyFetches.push(history.id)
      return Promise.resolve(jsonResponse({ sessionId: history.id, items: history.items }))
    }
    if (url.endsWith('/messages') && method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
      const stream = streams.shift()
      if (stream !== undefined) return Promise.resolve(stream)
      return Promise.resolve(sseResponse([{ t: 'turn-end', reason: 'completed' }]))
    }
    if (url.endsWith('/retry') && method === 'POST') {
      const stream = streams.shift()
      if (stream !== undefined) return Promise.resolve(stream)
      return Promise.resolve(sseResponse([{ t: 'turn-end', reason: 'completed' }]))
    }
    return Promise.resolve(jsonResponse({}))
  }))
  render(<App />)
  return { posts, historyFetches }
}

const userItem = (text: string): ChatItem => ({ role: 'user', text })
const assistantItem = (text: string): ChatItem => ({ role: 'assistant', text })

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('dsh-chat-avatar', '1')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('reply flow', () => {
  it('pins a chip without touching the draft, and Escape cancels it', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [userItem('hi'), assistantItem('hello there and more')] }],
    })
    await screen.findByText('hello there and more')

    fireEvent.click(screen.getAllByLabelText('Reply to this message')[1]!)
    const chip = document.querySelector('.reply-chip')
    expect(chip).not.toBeNull()
    expect(chip?.querySelector('.reply-chip-label')?.textContent).toBe('dsh chat')
    expect(chip?.querySelector('.reply-chip-text')?.textContent).toContain('hello there')
    const draft = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')
    expect(draft.value).toBe('')

    fireEvent.keyDown(draft, { key: 'Escape' })
    await waitFor(() => { expect(document.querySelector('.reply-chip')).toBeNull() })
  })

  it('sends the replyTo context and renders a quote on the sent bubble', async () => {
    const { posts } = await renderApp({
      streams: [
        sseResponse([
          { t: 'delta', text: 'hello there' },
          { t: 'assistant', text: 'hello there' },
          { t: 'turn-end', reason: 'completed' },
        ]),
        sseResponse([
          { t: 'delta', text: 'second answer' },
          { t: 'assistant', text: 'second answer' },
          { t: 'turn-end', reason: 'completed' },
        ]),
      ],
    })
    const draft = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')

    fireEvent.change(draft, { target: { value: 'first question' } })
    fireEvent.keyDown(draft, { key: 'Enter' })
    await screen.findByText('hello there')

    fireEvent.click(screen.getAllByLabelText('Reply to this message')[1]!)
    expect(document.querySelector('.reply-chip')).not.toBeNull()
    fireEvent.change(draft, { target: { value: 'noted' } })
    fireEvent.keyDown(draft, { key: 'Enter' })
    await screen.findByText('second answer')

    expect(posts).toHaveLength(2)
    expect(posts[0]?.body.replyTo).toBeUndefined()
    expect(posts[1]?.body.replyTo).toEqual({ role: 'assistant', text: 'hello there' })
    expect(posts[1]?.body.text).toBe('noted')
    expect(draft.value).toBe('')
    expect(document.querySelector('.reply-chip')).toBeNull()
    const quote = document.querySelector('.row.user .reply-quote')
    expect(quote?.querySelector('.reply-quote-label')?.textContent).toBe('dsh chat')
    expect(quote?.querySelector('.reply-quote-text')?.textContent).toBe('hello there')
  })

  it('drops a pending reply when the conversation changes', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [
        { id: 'sess-a', title: 'Conversation A', items: [userItem('hi'), assistantItem('answer a')] },
        { id: 'sess-b', title: 'Conversation B', items: [userItem('yo'), assistantItem('answer b')] },
      ],
    })
    await screen.findByText('answer a')

    fireEvent.click(screen.getAllByLabelText('Reply to this message')[1]!)
    expect(document.querySelector('.reply-chip')).not.toBeNull()

    fireEvent.click(screen.getByTitle('Conversation B'))
    await screen.findByText('answer b')
    await waitFor(() => { expect(document.querySelector('.reply-chip')).toBeNull() })
  })
})

describe('message actions layout', () => {
  it('renders actions under the bubble, with try-again on the trailing row only', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [{
        id: 'sess-a',
        title: 'A',
        items: [userItem('first'), assistantItem('an answer'), userItem('second, unanswered')],
      }],
    })
    await screen.findByText('second, unanswered')

    // The trailing user row stacks bubble-then-actions in one column.
    const trailing = document.querySelectorAll('.row.user')[1]
    expect(trailing).toBeDefined()
    const col = trailing?.querySelector('.user-col')
    const children = [...col?.children ?? []]
    expect(children[0]?.classList.contains('user-bubble')).toBe(true)
    expect(children[1]?.classList.contains('msg-actions')).toBe(true)
    expect(col?.querySelector('button[aria-label="Try again"]')).not.toBeNull()
    expect(col?.querySelector('button[aria-label="Copy message"]')).not.toBeNull()
    expect(col?.querySelector('button[aria-label="Reply to this message"]')).not.toBeNull()

    // A non-trailing assistant row shows no actions at all.
    const assistantRow = document.querySelector('.row.assistant')
    expect(assistantRow?.querySelector('.msg-actions')).toBeNull()
    // The failure affordance chip is present while the thread ends on a user row.
    expect(document.querySelector('.retry-hint')).not.toBeNull()
  })

  it('stacks the trailing assistant row as text-then-actions', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [userItem('q'), assistantItem('the answer')] }],
    })
    await screen.findByText('the answer')

    const col = document.querySelector('.row.assistant .assistant-col')
    const children = [...col?.children ?? []]
    expect(children[0]?.classList.contains('assistant-text')).toBe(true)
    expect(children[1]?.classList.contains('msg-actions')).toBe(true)
    expect(col?.querySelector('button[aria-label="Try again"]')).not.toBeNull()
    expect(document.querySelector('.retry-hint')).toBeNull()
  })
})

describe('compaction rendering', () => {
  it('renders the compaction checkpoint as a summary card in history', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [{
        id: 'sess-a',
        title: 'A',
        items: [
          { role: 'compaction', text: 'Summary of earlier turns: the user asked about the weather.' },
          userItem('recent question'),
          assistantItem('recent answer'),
        ],
      }],
    })
    await screen.findByText('recent answer')
    expect(screen.getByText('Earlier conversation compacted')).toBeDefined()
    const text = document.querySelector('.row.compaction .compaction-text')
    expect(text?.textContent).toContain('the weather')
  })

  it('refetches history after a turn that reported a compaction', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    const { historyFetches } = await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [userItem('old question'), assistantItem('old answer')] }],
      streams: [
        sseResponse([
          { t: 'compaction', text: 'checkpoint summary' },
          { t: 'delta', text: 'new answer' },
          { t: 'assistant', text: 'new answer' },
          { t: 'turn-end', reason: 'completed' },
        ]),
      ],
    })
    await screen.findByText('old answer')
    expect(historyFetches).toHaveLength(1)

    const draft = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')
    fireEvent.change(draft, { target: { value: 'next question' } })
    fireEvent.keyDown(draft, { key: 'Enter' })
    await screen.findByText('new answer')
    await waitFor(() => { expect(historyFetches.length).toBeGreaterThanOrEqual(2) })
  })
})

describe('collapsed rail', () => {
  it('keeps new chat one click away while the sidebar is hidden', async () => {
    localStorage.setItem('dsh-chat-collapsed', '1')
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [userItem('hi'), assistantItem('answer')] }],
    })
    await screen.findByText('answer')

    const rail = document.querySelector('.collapsed-bar')
    expect(rail).not.toBeNull()
    expect(rail?.querySelector('button[aria-label="Open sidebar"]')).not.toBeNull()
    expect(document.querySelector('.retry-hint')).toBeNull()

    fireEvent.click(screen.getByLabelText('New chat'))
    await waitFor(() => { expect(screen.getByText('What can I help with?')).toBeDefined() })
  })
})
