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
import App, { mergeSessionPage } from '../src/App.tsx'
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
  abilities?: { image: 'yes' | 'no' | 'unknown'; video: 'yes' | 'no' | 'unknown' }
} = {}): Promise<{
  posts: { url: string; body: Record<string, unknown> }[]
  historyFetches: string[]
  uploads: { url: string; body: unknown }[]
  attachmentFetches: string[]
}> {
  const sessions = options.sessions ?? []
  const posts: { url: string; body: Record<string, unknown> }[] = []
  const historyFetches: string[] = []
  const uploads: { url: string; body: unknown }[] = []
  const attachmentFetches: string[] = []
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
    if (url === '/api/capabilities') {
      return Promise.resolve(jsonResponse({
        model: 'm',
        image: options.abilities?.image ?? 'no',
        video: options.abilities?.video ?? 'no',
      }))
    }
    if (url === '/api/attachment') {
      attachmentFetches.push(String(init?.body ?? ''))
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', blob: async () => new Blob(['x']) } as unknown as Response)
    }
    if (url.startsWith('/api/uploads')) {
      uploads.push({ url, body: init?.body })
      const kind = new URLSearchParams(url.split('?')[1] ?? '').get('kind') ?? 'file'
      return Promise.resolve(jsonResponse({ kind, mediaType: kind === 'image' ? 'image/png' : 'video/mp4', ref: { attachmentId: 'up-1', bytes: 3 } }))
    }
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
  return { posts, historyFetches, uploads, attachmentFetches }
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

describe('attachment upload flow', () => {
  it('uploads pasted media once, sends the reference, and previews from the blob URL', async () => {
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:mock-1')
    URL.revokeObjectURL = vi.fn()
    try {
      localStorage.setItem('dsh-chat-active', 'sess-a')
      const { posts, uploads } = await renderApp({
        sessions: [{ id: 'sess-a', title: 'A', items: [] }],
        abilities: { image: 'yes', video: 'no' },
      })
      const composer = await screen.findByPlaceholderText('Message dsh chat…')
      const image = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
      fireEvent.paste(composer, { clipboardData: { files: [image] } })
      await screen.findByText('shot.png')
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
      await waitFor(() => { expect(posts.length).toBe(1) })
      // The bytes went up once as the raw file; the message rides the ref.
      expect(uploads).toEqual([{ url: '/api/uploads?kind=image&name=shot.png', body: image }])
      expect(posts[0]?.body).toEqual({
        text: '',
        attachment: { kind: 'image', mediaType: 'image/png', ref: { attachmentId: 'up-1', bytes: 3 } },
      })
      // The sent bubble previews from the local blob URL, not a data URL.
      expect(document.querySelector('img.bubble-attachment')?.getAttribute('src')).toBe('blob:mock-1')
    } finally {
      if (originalCreate !== undefined) URL.createObjectURL = originalCreate
      else delete (URL as { createObjectURL?: unknown }).createObjectURL
      if (originalRevoke !== undefined) URL.revokeObjectURL = originalRevoke
      else delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
    }
  })

  it('removing the pending attachment releases its preview URL', async () => {
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:mock-2')
    URL.revokeObjectURL = vi.fn()
    try {
      localStorage.setItem('dsh-chat-active', 'sess-a')
      await renderApp({
        sessions: [{ id: 'sess-a', title: 'A', items: [] }],
        abilities: { image: 'yes', video: 'no' },
      })
      const composer = await screen.findByPlaceholderText('Message dsh chat…')
      fireEvent.paste(composer, { clipboardData: { files: [new File([new Uint8Array([1])], 'x.png', { type: 'image/png' })] } })
      await screen.findByText('x.png')
      fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }))
      await waitFor(() => { expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-2') })
      expect(screen.queryByText('x.png')).toBeNull()
    } finally {
      if (originalCreate !== undefined) URL.createObjectURL = originalCreate
      else delete (URL as { createObjectURL?: unknown }).createObjectURL
      if (originalRevoke !== undefined) URL.revokeObjectURL = originalRevoke
      else delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
    }
  })
})

describe('history attachment lifecycle', () => {
  it('fetches one attachment once and keeps its URL across a compaction refetch', async () => {
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    let minted = 0
    URL.createObjectURL = vi.fn(() => `blob:hist-${String(++minted)}`)
    URL.revokeObjectURL = vi.fn()
    try {
      localStorage.setItem('dsh-chat-active', 'sess-a')
      const attachment = { kind: 'image' as const, attachmentId: 'a1', mediaType: 'image/png', ref: { attachmentId: 'a1' } }
      const { attachmentFetches, historyFetches } = await renderApp({
        sessions: [{
          id: 'sess-a',
          title: 'A',
          items: [
            { role: 'user', text: 'look at this', attachments: [attachment] },
            assistantItem('nice'),
          ],
        }],
        streams: [sseResponse([{ t: 'compaction', text: 'summary' }, { t: 'turn-end', reason: 'completed' }])],
      })
      await screen.findByText('look at this')
      await waitFor(() => { expect(attachmentFetches.length).toBe(1) })
      expect(document.querySelector('img.bubble-attachment')?.getAttribute('src')).toBe('blob:hist-1')
      // A turn whose compaction event refetches history replaces the item
      // objects wholesale; the same attachment id must not refetch or swap.
      const composer = screen.getByPlaceholderText('Message dsh chat…')
      fireEvent.change(composer, { target: { value: 'again' } })
      fireEvent.submit(composer.closest('form') as HTMLFormElement)
      await waitFor(() => { expect(historyFetches.length).toBe(2) })
      expect(attachmentFetches.length).toBe(1)
      expect(document.querySelector('img.bubble-attachment')?.getAttribute('src')).toBe('blob:hist-1')
    } finally {
      if (originalCreate !== undefined) URL.createObjectURL = originalCreate
      else delete (URL as { createObjectURL?: unknown }).createObjectURL
      if (originalRevoke !== undefined) URL.revokeObjectURL = originalRevoke
      else delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
    }
  })
})

describe('mergeSessionPage', () => {
  const session = (id: string): { id: string } => ({ id })

  it('adopts the page outright when it already covers the loaded rows', () => {
    expect(mergeSessionPage([session('a'), session('b')], [session('b'), session('c')]))
      .toEqual([session('b'), session('c')])
  })

  it('keeps deep pages, drops tail rows the fresh page covers', () => {
    const loaded = ['a', 'b', 'c', 'd', 'e'].map(session)
    const page = [session('e'), session('f')]
    expect(mergeSessionPage(loaded, page)).toEqual([session('e'), session('f'), session('a'), session('b'), session('c'), session('d')])
  })
})

/** One stubbed 200 SSE Response that delivers its frames with real delays,
 * so mid-stream states (the streaming row, its caret, running tool chips)
 * are observable before the turn commits. */
const delayedSseResponse = (events: readonly unknown[], delayMs: number): Response => {
  const chunks = events.map(event => `data: ${JSON.stringify(event)}\n\n`)
  let index = 0
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true as const, value: undefined }
          await new Promise((resolve) => { setTimeout(resolve, delayMs) })
          return { done: false as const, value: new TextEncoder().encode(chunks[index++] as string) }
        },
      }),
    },
  } as unknown as Response
}

describe('streaming turn', () => {
  it('shows the thinking and streamed states, then commits the final row', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [] }],
      streams: [delayedSseResponse([
        { t: 'delta', text: 'The answer is ' },
        { t: 'delta', text: '42 and change.' },
        { t: 'tool-start', name: 'web_search', query: 'node 25' },
        { t: 'tool-end', name: 'web_search', query: 'node 25', searchedAt: '2026-09-08T00:00:00.000Z', sources: [{ url: 'https://nodejs.org', title: 'Node.js' }] },
        { t: 'assistant', text: 'the full committed answer' },
        { t: 'turn-end', reason: 'completed' },
      ], 30)],
    })
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')
    fireEvent.change(composer, { target: { value: 'what is the answer?' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    // Before the first delta lands, the streaming row thinks.
    await waitFor(() => { expect(screen.getByText('Thinking…')).toBeTruthy() })
    // Deltas batch into the streaming row with its caret.
    await screen.findByText('The answer is 42 and change.', {}, { timeout: 3000 })
    expect(document.querySelector('.caret')).not.toBeNull()
    // A search tool chip runs and settles while the turn is still open.
    await screen.findByText('Searching · node 25', {}, { timeout: 3000 })
    await screen.findByText('Searched · node 25', {}, { timeout: 3000 })
    // The committed frame replaces the streamed text; the caret goes away
    // and the trailing row gains its actions.
    await screen.findByText('the full committed answer', {}, { timeout: 3000 })
    await waitFor(() => { expect(document.querySelector('.caret')).toBeNull() })
    expect(screen.getByLabelText('Try again')).toBeTruthy()
  })

  it('lands the streamed text as the committed row when no frame supersedes it', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [] }],
      streams: [delayedSseResponse([
        { t: 'delta', text: 'streamed only, never framed' },
        { t: 'turn-end', reason: 'completed' },
      ], 30)],
    })
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')
    fireEvent.change(composer, { target: { value: 'go' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    // No `assistant` frame arrives: the turn's finally block commits the
    // feed's accumulated text by itself.
    await screen.findByText('streamed only, never framed', {}, { timeout: 3000 })
    await waitFor(() => { expect(document.querySelector('.caret')).toBeNull() })
  })
})
