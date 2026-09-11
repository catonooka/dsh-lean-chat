// @vitest-environment jsdom

/**
 * Component coverage for the chat surface's reply flow and rail: the reply
 * chip pins a target without touching the draft, sends carry the replyTo
 * context and render a quote, actions sit under the message, the collapsed
 * rail keeps new chat, and switching conversations drops a pending reply.
 * The network is stubbed per test — these exercise the wiring, not the API.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SESSION_PAGE_SIZE, setActingUser } from '../src/api.ts'
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
  /** Served from this session's second history GET onward, when set. */
  refetchItems?: ChatItem[]
}

/**
 * Render the app against a fetch router: sessions + config on mount, message
 * history for known sessions, and a queue of SSE streams for sends.
 */
/** A profile row as the miniature config server below reshapes it. */
interface ConfigProfile {
  id: string
  name: string
  model: string
  persona?: string
  greeting?: string
  avatar?: number
}

async function renderApp(options: {
  sessions?: SessionFixture[]
  activeId?: string
  streams?: Response[]
  abilities?: { image: 'yes' | 'no' | 'unknown'; video: 'yes' | 'no' | 'unknown' }
  users?: { id: string; name: string; avatar?: number; groups?: { id: string; name: string }[] }[]
  listSessionsFor?: (userId: string | undefined, archived: boolean) => { sessions: unknown[]; total: number }
  config?: Record<string, unknown>
} = {}): Promise<{
  posts: { url: string; body: Record<string, unknown> }[]
  historyFetches: string[]
  uploads: { url: string; body: unknown }[]
  attachmentFetches: string[]
  sessionListFetches: string[]
  userPatches: { id: string; body: Record<string, unknown> }[]
  userCreates: Record<string, unknown>[]
  listHeaders: (string | undefined)[]
  sessionPatches: { id: string; body: Record<string, unknown> }[]
  sessionDeletes: string[]
  configPatches: Record<string, unknown>[]
}> {
  const sessions = options.sessions ?? []
  const users = options.users ?? [{ id: 'u_main', name: 'catonooka', avatar: 1 }]
  const posts: { url: string; body: Record<string, unknown> }[] = []
  const historyFetches: string[] = []
  const uploads: { url: string; body: unknown }[] = []
  const attachmentFetches: string[] = []
  const sessionListFetches: string[] = []
  const userPatches: { id: string; body: Record<string, unknown> }[] = []
  const userCreates: Record<string, unknown>[] = []
  const listHeaders: (string | undefined)[] = []
  const sessionPatches: { id: string; body: Record<string, unknown> }[] = []
  const sessionDeletes: string[] = []
  const configPatches: Record<string, unknown>[] = []
  const historyFetchCount = new Map<string, number>()
  const streams = [...options.streams ?? []]
  // A miniature settings server, seeded like the real projection: the active
  // profile supplies the flat model/persona/avatar. PUT applies
  // switch/avatar/persona to the active profile so the client state moves
  // exactly like the real one.
  const seedProfiles = options.config?.profiles as ConfigProfile[] | undefined
  const seedActive = seedProfiles?.find(profile => profile.id === options.config?.activeProfileId) ?? seedProfiles?.[0]
  let configState: Record<string, unknown> = {
    provider: 'p',
    model: seedActive?.model ?? 'm',
    persona: seedActive?.persona ?? 'x',
    greeting: seedActive?.greeting ?? 'What can I help with?',
    ...seedActive?.avatar !== undefined ? { avatar: seedActive.avatar } : {},
    ...(options.config ?? {}),
  }
  const summaries = sessions.map(session => ({
    id: session.id,
    title: session.title,
    createdAt: 1,
    updatedAt: 2,
    live: true,
  }))
  const archivedSummaries = [
    { id: 'sess-z', title: 'Zed', createdAt: 1, updatedAt: 2, live: false, archived: true, groupId: null },
  ]
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/users') {
      if (method === 'POST') {
        userCreates.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return Promise.resolve(jsonResponse({ users, defaultUserId: users[0]?.id ?? '', createdId: 'u_new' }))
      }
      return Promise.resolve(jsonResponse({ users, defaultUserId: users[0]?.id ?? '' }))
    }
    const userPatch = url.match(/^\/api\/users\/([^/]+)$/)
    if (userPatch !== null && method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      userPatches.push({ id: decodeURIComponent(userPatch[1] ?? ''), body })
      // Echo the requested roster so group edits land in the client state.
      const patched = users.map(user => user.id === userPatch[1] ? { ...user, ...body } : user)
      return Promise.resolve(jsonResponse({ users: patched, defaultUserId: users[0]?.id ?? '', updatedId: userPatch[1] }))
    }
    if (url.startsWith('/api/sessions?')) {
      sessionListFetches.push(url)
      const header = init?.headers !== undefined ? new Headers(init.headers).get('x-dsh-user') : undefined
      listHeaders.push(header)
      const archived = url.includes('archived=1')
      const listed = options.listSessionsFor !== undefined
        ? options.listSessionsFor(header ?? undefined, archived)
        : archived
          ? { sessions: archivedSummaries, total: archivedSummaries.length }
          : { sessions: summaries, total: summaries.length }
      return Promise.resolve(jsonResponse(listed))
    }
    const sessionPatch = url.match(/^\/api\/sessions\/([^/]+)$/)
    if (sessionPatch !== null && method === 'PATCH') {
      sessionPatches.push({ id: sessionPatch[1] ?? '', body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
      return Promise.resolve(jsonResponse({ sessionId: sessionPatch[1], archived: false, groupId: null }))
    }
    if (sessionPatch !== null && method === 'DELETE') {
      sessionDeletes.push(sessionPatch[1] ?? '')
      return Promise.resolve(jsonResponse({ deleted: true }))
    }
    if (url === '/api/config') {
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        configPatches.push(body)
        const profiles = ((configState.profiles as ConfigProfile[] | undefined) ?? [])
          .map(profile => ({ ...profile }))
        const activeId = typeof body.switchProfile === 'string' ? body.switchProfile : String(configState.activeProfileId ?? '')
        const rename = body.renameProfile as { id?: unknown; name?: unknown } | undefined
        if (rename !== undefined && typeof rename === 'object') {
          const target = profiles.find(profile => profile.id === rename.id)
          if (target !== undefined && typeof rename.name === 'string') target.name = rename.name
        }
        const active = profiles.find(profile => profile.id === activeId)
        if (active !== undefined) {
          if (body.avatar === null) delete active.avatar
          else if (body.avatar !== undefined) active.avatar = body.avatar as number
          if (typeof body.persona === 'string') {
            if (body.persona.trim() === '') delete active.persona
            else active.persona = body.persona
          }
          if (typeof body.greeting === 'string') {
            if (body.greeting.trim() === '') delete active.greeting
            else active.greeting = body.greeting
          }
        }
        configState = {
          ...configState,
          ...(active !== undefined
            ? {
              model: active.model,
              persona: active.persona ?? 'You are a helpful assistant.',
              greeting: active.greeting ?? 'What can I help with?',
              ...active.avatar !== undefined ? { avatar: active.avatar } : { avatar: undefined },
            }
            : {}),
          activeProfileId: activeId,
          profiles,
        }
        return Promise.resolve(jsonResponse(configState))
      }
      return Promise.resolve(jsonResponse(configState))
    }
    if (url === '/api/chrome/status') {
      return Promise.resolve(jsonResponse({ extension: true, clients: [{ client: 'work' }], cdp: false }))
    }
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
      const count = (historyFetchCount.get(history.id) ?? 0) + 1
      historyFetchCount.set(history.id, count)
      const items = count > 1 && history.refetchItems !== undefined ? history.refetchItems : history.items
      return Promise.resolve(jsonResponse({ sessionId: history.id, items }))
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
  // Let the mount-time loads (users, sessions, config, history) settle before the
  // test drives the composer — real users cannot type faster than that.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  return {
    posts, historyFetches, uploads, attachmentFetches, sessionListFetches,
    userPatches, userCreates, listHeaders, sessionPatches, sessionDeletes, configPatches,
  }
}

const userItem = (text: string): ChatItem => ({ role: 'user', text })
const assistantItem = (text: string): ChatItem => ({ role: 'assistant', text })

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('dsh-chat-avatar', '1')
  // The acting-user header is module state; reset it so tests stay isolated.
  setActingUser(undefined)
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

/** Like delayedSseResponse, but each frame carries its own delay — the
 * parallel-conversation tests need precise control over when a stream is
 * still mid-flight. */
const timedSseResponse = (frames: ReadonlyArray<readonly [unknown, number]>): Response => {
  const chunks = frames.map(([event]) => `data: ${JSON.stringify(event)}\n\n`)
  const delays = frames.map(([, delay]) => delay)
  let index = 0
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true as const, value: undefined }
          await new Promise((resolve) => { setTimeout(resolve, delays[index] ?? 0) })
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

  it('runs browser steps as browsing chips that settle with the page', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [] }],
      streams: [delayedSseResponse([
        { t: 'delta', text: 'Looking at your posts.' },
        { t: 'tool-start', name: 'browser', action: 'open', url: 'https://x.com/me' },
        { t: 'tool-end', name: 'browser', action: 'extract', url: 'https://x.com/me', title: 'me (@me)', excerpt: 'Shipped the browser tool.' },
        { t: 'assistant', text: 'here are your five posts' },
        { t: 'turn-end', reason: 'completed' },
      ], 30)],
    })
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')
    fireEvent.change(composer, { target: { value: 'my recent 5 posts on X' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await screen.findByText('Browsing · open https://x.com/me', {}, { timeout: 3000 })
    await screen.findByText('Browsed · extract https://x.com/me', {}, { timeout: 3000 })
    // The settled chip opens to the page excerpt.
    fireEvent.click(screen.getByText('Browsed · extract https://x.com/me'))
    await screen.findByText('Shipped the browser tool.')
    await screen.findByText('here are your five posts', {}, { timeout: 3000 })
  })

  it('renders a browser card from history with the browsed label', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [{
        id: 'sess-a',
        title: 'A',
        items: [
          { role: 'user', text: 'my recent 5 posts on X' },
          { role: 'tool', name: 'browser', action: 'extract', url: 'https://x.com/me', title: 'me (@me)', excerpt: 'Post one.' },
          { role: 'assistant', text: 'here they are' },
        ],
      }],
    })
    await screen.findByText('Browsed · extract https://x.com/me', {}, { timeout: 3000 })
    fireEvent.click(screen.getByText('Browsed · extract https://x.com/me'))
    await screen.findByText('Post one.')
  })

  it('marks a failed browser step as failed instead of a blank search chip', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [] }],
      streams: [delayedSseResponse([
        { t: 'delta', text: 'The extension needs a reload.' },
        { t: 'tool-start', name: 'browser', action: 'extract', url: 'https://x.com' },
        { t: 'tool-end', name: 'browser', action: 'extract', url: 'https://x.com', text: 'Error: the browser step failed: the extension did not answer within 45000ms', isError: true },
        { t: 'assistant', text: 'please reload the extension' },
        { t: 'turn-end', reason: 'completed' },
      ], 30)],
    })
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')
    fireEvent.change(composer, { target: { value: 'read my posts' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await screen.findByText('Browsed · extract https://x.com · failed', {}, { timeout: 3000 })
    // The failed chip carries the error styling.
    await waitFor(() => { expect(document.querySelector('.tool-chip.failed')).not.toBeNull() })
    await screen.findByText('please reload the extension', {}, { timeout: 3000 })
  })

  it('labels actuation steps as acting, in stream and history', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [{ role: 'tool', name: 'browser', action: 'click', url: 'https://form.example', excerpt: 'Submit' }] }],
      streams: [delayedSseResponse([
        { t: 'delta', text: 'Filling it in.' },
        { t: 'tool-start', name: 'browser', action: 'type', url: 'https://form.example' },
        { t: 'tool-end', name: 'browser', action: 'type', url: 'https://form.example', excerpt: 'Typed hello' },
        { t: 'assistant', text: 'done' },
        { t: 'turn-end', reason: 'completed' },
      ], 30)],
    })
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')
    fireEvent.change(composer, { target: { value: 'fill the form' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await screen.findByText('Acting · type https://form.example', {}, { timeout: 3000 })
    await screen.findByText('Acted · type https://form.example', {}, { timeout: 3000 })
    // The history chip (preloaded items) reads the same way.
    expect(await screen.findByText('Acted · click https://form.example', {}, { timeout: 3000 })).toBeTruthy()
  })
})

describe('parallel conversations', () => {
  it('keeps a turn streaming when the user switches away and back', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [
        { id: 'sess-a', title: 'Alpha', items: [] },
        { id: 'sess-b', title: 'Beta', items: [{ role: 'assistant', text: 'beta stands ready' }] },
      ],
      streams: [timedSseResponse([
        [{ t: 'delta', text: 'The old chat keeps ' }, 40],
        [{ t: 'delta', text: 'generating in the background.' }, 900],
        [{ t: 'assistant', text: 'The old chat keeps generating in the background.' }, 40],
        [{ t: 'turn-end', reason: 'completed' }, 20],
      ])],
    })
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')
    fireEvent.change(composer, { target: { value: 'from alpha' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await screen.findByText(/The old chat keeps/, {}, { timeout: 3000 })
    // Switching away mid-stream is allowed and takes the view to Beta.
    fireEvent.click(screen.getByTitle('Beta'))
    await screen.findByText('beta stands ready')
    expect(screen.queryByText(/The old chat keeps/)).toBeNull()
    // Switching back restores the SAME live turn with its text intact.
    fireEvent.click(screen.getByTitle('Alpha'))
    await screen.findByText(/The old chat keeps/, {}, { timeout: 3000 })
    expect(document.querySelector('.caret')).not.toBeNull()
    // The turn finishes where the user is watching.
    await screen.findByText('The old chat keeps generating in the background.', {}, { timeout: 3000 })
    await waitFor(() => { expect(document.querySelector('.caret')).toBeNull() })
  })

  it('starts a new chat while a turn streams; the old one still completes', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [
        { id: 'sess-a', title: 'Alpha', items: [] },
      ],
      streams: [timedSseResponse([
        [{ t: 'delta', text: 'alpha is still working' }, 40],
        [{ t: 'assistant', text: 'alpha is still working' }, 700],
        [{ t: 'turn-end', reason: 'completed' }, 20],
      ])],
    })
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')
    fireEvent.change(composer, { target: { value: 'hello alpha' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await screen.findByText(/alpha is still working/, {}, { timeout: 3000 })
    // New chat mid-stream: never blocked, fresh empty thread takes over.
    fireEvent.click(screen.getByText('New chat'))
    expect((screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…') as HTMLTextAreaElement).value).toBe('')
    expect(document.querySelector('.caret')).toBeNull()
    expect(screen.queryByText(/alpha is still working/)).toBeNull()
    // The old conversation keeps its stream and finishes in the background.
    fireEvent.click(screen.getByTitle('Alpha'))
    await screen.findByText(/alpha is still working/, {}, { timeout: 3000 })
    await waitFor(() => {
      expect(document.querySelectorAll('.session-live').length).toBe(0)
    }, { timeout: 3000 })
  })

  it('runs two sessions at once, each with a live dot, and both complete', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [
        { id: 'sess-a', title: 'Alpha', items: [] },
        { id: 'sess-b', title: 'Beta', items: [] },
      ],
      streams: [
        timedSseResponse([
          [{ t: 'delta', text: 'alpha answer' }, 40],
          [{ t: 'assistant', text: 'alpha answer' }, 800],
          [{ t: 'turn-end', reason: 'completed' }, 20],
        ]),
        timedSseResponse([
          [{ t: 'delta', text: 'beta answer' }, 40],
          [{ t: 'assistant', text: 'beta answer' }, 500],
          [{ t: 'turn-end', reason: 'completed' }, 20],
        ]),
      ],
    })
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')
    fireEvent.change(composer, { target: { value: 'to alpha' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await screen.findByText(/alpha answer/, {}, { timeout: 3000 })
    // Switch to Beta and send there while Alpha is still generating.
    fireEvent.click(screen.getByTitle('Beta'))
    const betaComposer = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')
    fireEvent.change(betaComposer, { target: { value: 'to beta' } })
    fireEvent.keyDown(betaComposer, { key: 'Enter' })
    await screen.findByText(/beta answer/, {}, { timeout: 3000 })
    await waitFor(() => {
      expect(document.querySelectorAll('.session-live').length).toBe(2)
    }, { timeout: 3000 })
    // Beta finishes while watched; Alpha is still live in the background.
    await screen.findByText('beta answer', {}, { timeout: 3000 })
    await waitFor(() => {
      expect(document.querySelectorAll('.session-live').length).toBe(1)
    }, { timeout: 3000 })
    fireEvent.click(screen.getByTitle('Alpha'))
    await screen.findByText('alpha answer', {}, { timeout: 3000 })
    await waitFor(() => {
      expect(document.querySelectorAll('.session-live').length).toBe(0)
    }, { timeout: 3000 })
  })

  it('still refuses a second send in the same session while it streams', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    const harness = await renderApp({
      sessions: [{ id: 'sess-a', title: 'Alpha', items: [] }],
      streams: [timedSseResponse([
        [{ t: 'delta', text: 'working' }, 40],
        [{ t: 'assistant', text: 'working' }, 400],
        [{ t: 'turn-end', reason: 'completed' }, 20],
      ])],
    })
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')
    fireEvent.change(composer, { target: { value: 'first' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await screen.findByText(/working/, {}, { timeout: 3000 })
    fireEvent.change(composer, { target: { value: 'second while streaming' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(harness.posts).toHaveLength(1)
    await waitFor(() => { expect(document.querySelector('.caret')).toBeNull() })
  })
})

describe('post-turn sidebar refresh', () => {
  it('refetches only the first page even with deep pages loaded', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    const deep = Array.from({ length: 25 }, (_, index) => ({
      id: index === 0 ? 'sess-a' : `sess-${String(index)}`,
      title: index === 0 ? 'A' : `Chat ${String(index)}`,
      items: [] as ChatItem[],
    }))
    const { sessionListFetches } = await renderApp({
      sessions: deep,
      streams: [sseResponse([{ t: 'turn-end', reason: 'completed' }])],
    })
    await screen.findByText('A')
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')
    fireEvent.change(composer, { target: { value: 'hello' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => { expect(sessionListFetches.length).toBe(2) })
    // The refresh asks for one page — never for every row the user scrolled
    // past (the old behavior refetched all 25 with limit=25).
    expect(sessionListFetches[1]).toBe(`/api/sessions?limit=${String(SESSION_PAGE_SIZE)}`)
    expect(sessionListFetches.some(url => url.includes('limit=25'))).toBe(false)
  })
})

describe('history attachment swap', () => {
  it('refetches and swaps the URL when a refetch carries a different attachment', async () => {
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    let minted = 0
    URL.createObjectURL = vi.fn(() => `blob:swap-${String(++minted)}`)
    URL.revokeObjectURL = vi.fn()
    try {
      localStorage.setItem('dsh-chat-active', 'sess-a')
      const first = { kind: 'image' as const, attachmentId: 'a1', mediaType: 'image/png', ref: { attachmentId: 'a1' } }
      const second = { kind: 'image' as const, attachmentId: 'a2', mediaType: 'image/png', ref: { attachmentId: 'a2' } }
      const { attachmentFetches } = await renderApp({
        sessions: [{
          id: 'sess-a',
          title: 'A',
          items: [{ role: 'user', text: 'first', attachments: [first] }, assistantItem('ok')],
          refetchItems: [{ role: 'user', text: 'first', attachments: [second] }, assistantItem('ok')],
        }],
        streams: [sseResponse([{ t: 'compaction', text: 'summary' }, { t: 'turn-end', reason: 'completed' }])],
      })
      await screen.findByText('first')
      await waitFor(() => { expect(attachmentFetches.length).toBe(1) })
      expect(document.querySelector('img.bubble-attachment')?.getAttribute('src')).toBe('blob:swap-1')
      // The refetched history carries a different attachment id: the row
      // fetches the new bytes and swaps its URL, revoking the stale one.
      const composer = screen.getByPlaceholderText('Message dsh chat…')
      fireEvent.change(composer, { target: { value: 'again' } })
      fireEvent.submit(composer.closest('form') as HTMLFormElement)
      await waitFor(() => { expect(attachmentFetches.length).toBe(2) })
      await waitFor(() => {
        expect(document.querySelector('img.bubble-attachment')?.getAttribute('src')).toBe('blob:swap-2')
      })
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:swap-1')
    } finally {
      if (originalCreate !== undefined) URL.createObjectURL = originalCreate
      else delete (URL as { createObjectURL?: unknown }).createObjectURL
      if (originalRevoke !== undefined) URL.revokeObjectURL = originalRevoke
      else delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
    }
  })
})

describe('user profiles', () => {
  it('switches profiles without disturbing the previous profile\'s running turn', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    const { posts } = await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [] }],
      users: [
        { id: 'u_main', name: 'catonooka', avatar: 1 },
        { id: 'u_work', name: 'Work', avatar: 2 },
      ],
      streams: [timedSseResponse([
        [{ t: 'delta', text: 'old profile keeps streaming' }, 20],
        [{ t: 'assistant', text: 'the finished answer' }, 500],
        [{ t: 'turn-end', reason: 'completed' }, 20],
      ])],
    })
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')
    fireEvent.change(composer, { target: { value: 'go' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await screen.findByText('old profile keeps streaming', {}, { timeout: 3000 })

    // Switch away: the header moves, the new profile gets a fresh draft, and
    // the old profile's stream leaves the view without being cancelled.
    fireEvent.click(screen.getByLabelText('Switch user'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Work' }))
    await screen.findByText('What can I help with?')
    expect(localStorage.getItem('dsh-chat-user')).toBe('u_work')
    expect(screen.queryByText('old profile keeps streaming')).toBeNull()

    // Switch back: the remembered chat restores the still-running turn.
    fireEvent.click(screen.getByLabelText('Switch user'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'catonooka' }))
    await screen.findByText('old profile keeps streaming', {}, { timeout: 3000 })
    expect(localStorage.getItem('dsh-chat-user')).toBe('u_main')
    // The turn then finishes on its own and commits its row.
    await screen.findByText('the finished answer', {}, { timeout: 3000 })
    await waitFor(() => { expect(document.querySelector('.caret')).toBeNull() })
    expect(posts.length).toBe(1)
  })

  it('scopes the sidebar list and sends to the acting profile\'s header', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    const { listHeaders } = await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [] }],
      users: [
        { id: 'u_main', name: 'catonooka', avatar: 1 },
        { id: 'u_work', name: 'Work', avatar: 2 },
      ],
    })
    await waitFor(() => { expect(listHeaders[0]).toBe('u_main') })
    fireEvent.click(screen.getByLabelText('Switch user'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Work' }))
    await waitFor(() => { expect(listHeaders[listHeaders.length - 1]).toBe('u_work') })
  })

  it('adds a user through the dialog and switches to them', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    const { userCreates, listHeaders } = await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [] }],
    })
    fireEvent.click(screen.getByLabelText('Switch user'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add user…' }))
    fireEvent.change(screen.getByLabelText('User name'), { target: { value: 'Work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))
    await waitFor(() => { expect(userCreates).toEqual([{ name: 'Work', avatar: 1 }]) })
    await waitFor(() => { expect(localStorage.getItem('dsh-chat-user')).toBe('u_new') })
    await waitFor(() => { expect(listHeaders[listHeaders.length - 1]).toBe('u_new') })
  })

  it('seeds the default profile\'s avatar from the legacy local pick', async () => {
    localStorage.setItem('dsh-chat-avatar', '3')
    const { userPatches } = await renderApp({
      users: [{ id: 'u_main', name: 'catonooka' }],
    })
    await waitFor(() => { expect(userPatches).toEqual([{ id: 'u_main', body: { avatar: 3 } }] ) })
  })
})

describe('chat context menu', () => {
  const openMenuOn = async (title: string): Promise<void> => {
    fireEvent.contextMenu(screen.getByText(title), { clientX: 40, clientY: 40 })
    await screen.findByRole('menu')
  }

  it('archives a chat from the right-click menu and drops it from the list', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-b')
    const { sessionPatches } = await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [] }, { id: 'sess-b', title: 'B', items: [] }],
    })
    await screen.findByText('A')
    await openMenuOn('A')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }))
    await waitFor(() => {
      expect(sessionPatches).toEqual([{ id: 'sess-a', body: { archived: true } }])
    })
    await waitFor(() => { expect(screen.queryByText('A')).toBeNull() })
    expect(screen.getByText('B')).toBeTruthy()
  })

  it('renames inline: Enter saves through the PATCH, Escape cancels', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    const { sessionPatches } = await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [] }],
    })
    await screen.findByText('A')
    await openMenuOn('A')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText<HTMLInputElement>('Rename chat')
    expect(input.value).toBe('A')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(sessionPatches).toEqual([{ id: 'sess-a', body: { title: 'Renamed' } }])
    })
    await screen.findByText('Renamed')
  })

  it('deletes after a confirm, and a deleted active chat falls back to a fresh draft', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    const { sessionDeletes } = await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [] }],
    })
    await screen.findByText('A')
    await openMenuOn('A')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    await screen.findByText('Delete chat?')
    fireEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }))
    await waitFor(() => { expect(sessionDeletes).toEqual(['sess-a']) })
    await waitFor(() => { expect(screen.queryByText('A')).toBeNull() })
    await screen.findByText('What can I help with?')
  })

  it('creates a group from a chat and shows the section in the sidebar', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    const { userPatches, sessionPatches } = await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [] }],
    })
    await screen.findByText('A')
    await openMenuOn('A')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New group…' }))
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'X research' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() => {
      expect(userPatches).toEqual([{
        id: 'u_main',
        body: { groups: [{ id: expect.stringMatching(/^g_/) , name: 'X research' }] },
      }])
    })
    await waitFor(() => {
      expect(sessionPatches).toEqual([{ id: 'sess-a', body: { groupId: expect.stringMatching(/^g_/) } }])
    })
    await screen.findByText('X research')
    expect(screen.getByText('A')).toBeTruthy()
  })

  it('opens the archived shelf, unarchives from its menu, and goes back', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    const { sessionListFetches, sessionPatches } = await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [] }],
    })
    await screen.findByText('A')
    fireEvent.click(screen.getByRole('button', { name: 'Archived', exact: true }))
    await screen.findByText('Zed')
    expect(sessionListFetches.some(url => url.includes('archived=1'))).toBe(true)
    expect(screen.queryByLabelText('Search chats')).toBeNull()
    await openMenuOn('Zed')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unarchive' }))
    await waitFor(() => {
      expect(sessionPatches).toEqual([{ id: 'sess-z', body: { archived: false } }])
    })
    await waitFor(() => { expect(screen.queryByText('Zed')).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: 'All chats' }))
    await screen.findByText('A')
  })
})

describe('settings users section', () => {
  it('picks the acting user\'s Chrome profile and it lands in the users store', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    const { userPatches } = await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [] }],
    })
    await screen.findByText('A')
    // The name side of the user row opens settings.
    fireEvent.click(screen.getByRole('button', { name: /catonooka/ }))
    const select = await screen.findByLabelText<HTMLSelectElement>('Chrome profile for this user')
    expect(screen.getByText('Any connected profile')).toBeTruthy()
    fireEvent.change(select, { target: { value: 'work' } })
    await waitFor(() => {
      expect(userPatches).toContainEqual({ id: 'u_main', body: { chromeProfile: 'work' } })
    })
  })

  it('renames the acting user from the settings row', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    const { userPatches } = await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [] }],
    })
    await screen.findByText('A')
    fireEvent.click(screen.getByRole('button', { name: /catonooka/ }))
    // The provider-profile row has its own Rename; the Users row renders after it.
    const renameButtons = await screen.findAllByRole('button', { name: 'Rename' })
    fireEvent.click(renameButtons[renameButtons.length - 1]!)
    const input = screen.getByLabelText<HTMLInputElement>('User name')
    fireEvent.change(input, { target: { value: 'Renamed User' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(userPatches).toContainEqual({ id: 'u_main', body: { name: 'Renamed User' } })
    })
  })
})

describe('model characters', () => {
  const profiles = [
    { id: 'pa', name: 'Helper', model: 'model-a', persona: 'helper persona', greeting: 'What shall we build?' },
    { id: 'pb', name: 'Robo', model: 'model-b', persona: 'robo persona', avatar: 22 },
  ]

  it('asks the character\'s own welcome question and shows only its name', async () => {
    await renderApp({
      config: { activeProfileId: 'pa', profiles },
    })
    expect(screen.getByText('What shall we build?')).toBeTruthy()
    expect(screen.queryByText('What can I help with?')).toBeNull()
    expect(screen.getByText('Helper')).toBeTruthy()
    expect(screen.queryByText(/model-a/)).toBeNull()
  })

  it('falls back to the default question when the character sets none', async () => {
    await renderApp({
      config: { activeProfileId: 'pb', profiles },
    })
    expect(screen.getByText('What can I help with?')).toBeTruthy()
    expect(screen.getByText('Robo')).toBeTruthy()
  })

  it('saves a custom welcome question for the selected character', async () => {
    const { configPatches } = await renderApp({
      config: { activeProfileId: 'pa', profiles },
    })
    fireEvent.click(screen.getByRole('button', { name: /catonooka/ }))
    const panel = await screen.findByRole('dialog', { name: 'Settings' })
    expect(within(panel).getByLabelText<HTMLInputElement>('Welcome question').value).toBe('What shall we build?')
    fireEvent.change(within(panel).getByLabelText('Welcome question'), { target: { value: 'Ask me anything' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
    const patch = await waitFor(() => {
      const found = configPatches.find(body => typeof body.greeting === 'string')
      expect(found).toBeDefined()
      return found
    })
    expect(patch).toMatchObject({ greeting: 'Ask me anything' })
  })

  it('opens the switcher from the welcome logo and swaps the bot avatar on switch', async () => {
    const { configPatches } = await renderApp({
      config: { activeProfileId: 'pa', profiles },
    })
    const welcome = screen.getByRole('button', { name: 'Switch model character' })
    // The active character has no tile, so the classic bot avatar shows.
    expect(welcome.querySelector('img')?.getAttribute('src')).toBe('bot-avatar.png')
    expect(screen.getByText('Helper')).toBeTruthy()
    expect(screen.queryByText(/model-a/)).toBeNull()
    fireEvent.click(welcome)
    const menu = await screen.findByRole('menu', { name: 'Model characters' })
    expect(menu.textContent).toContain('Helper')
    expect(menu.textContent).toContain('Robo')
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Robo/ }))
    await waitFor(() => {
      expect(configPatches).toContainEqual({ switchProfile: 'pb' })
    })
    const swapped = await screen.findByRole('button', { name: 'Switch model character' })
    expect(swapped.querySelector('img')?.getAttribute('src')).toBe('avatars/avatar-22.png')
    expect(screen.getByText('Robo')).toBeTruthy()
    expect(screen.queryByText(/model-b/)).toBeNull()
  })

  it('marks only the active character row as active', async () => {
    await renderApp({
      config: { activeProfileId: 'pa', profiles },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Switch model character' }))
    const menu = await screen.findByRole('menu', { name: 'Model characters' })
    expect(within(menu).getByRole('menuitem', { name: /Helper/ }).className).toContain('active')
    expect(within(menu).getByRole('menuitem', { name: /Robo/ }).className).not.toContain('active')
  })

  it('opens the switcher from an assistant message avatar and closes on Escape', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [assistantItem('hello there')] }],
      config: { activeProfileId: 'pa', profiles },
    })
    await screen.findByText('hello there')
    const avatarButtons = screen.getAllByRole('button', { name: 'Switch model character' })
    fireEvent.click(avatarButtons[0]!)
    const menu = await screen.findByRole('menu', { name: 'Model characters' })
    expect(menu.textContent).toContain('Robo')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Model characters' })).toBeNull()
    })
  })

  it('opens the switcher from the streaming row while a turn runs', async () => {
    localStorage.setItem('dsh-chat-active', 'sess-a')
    await renderApp({
      sessions: [{ id: 'sess-a', title: 'A', items: [] }],
      config: { activeProfileId: 'pa', profiles },
      streams: [timedSseResponse([
        [{ t: 'delta', text: 'mid-flight words' }, 20],
        [{ t: 'turn-end', reason: 'completed' }, 10_000],
      ])],
    })
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>('Message dsh chat…')
    fireEvent.change(composer, { target: { value: 'go' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await screen.findByText('mid-flight words', {}, { timeout: 3000 })
    // The streaming row's avatar is the last bot slot in the thread.
    const avatarButtons = screen.getAllByRole('button', { name: 'Switch model character' })
    fireEvent.click(avatarButtons[avatarButtons.length - 1]!)
    const menu = await screen.findByRole('menu', { name: 'Model characters' })
    expect(menu.textContent).toContain('Robo')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Model characters' })).toBeNull()
    })
  })

  it('renames the active character from the switcher menu', async () => {
    const { configPatches } = await renderApp({
      config: { activeProfileId: 'pa', profiles },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Switch model character' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rename character' })
    const input = within(dialog).getByLabelText<HTMLInputElement>('Character name')
    expect(input.value).toBe('Helper')
    fireEvent.change(input, { target: { value: 'Helper II' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))
    await waitFor(() => {
      expect(configPatches).toContainEqual({ renameProfile: { id: 'pa', name: 'Helper II' } })
    })
    expect(await screen.findByText('Helper II')).toBeTruthy()
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Rename character' })).toBeNull()
    })
  })

  it('edit-in-settings opens the settings panel', async () => {
    await renderApp({
      config: { activeProfileId: 'pa', profiles },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Switch model character' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit in settings' }))
    await screen.findByRole('dialog')
  })

  it('creates a character with its avatar and system prompt from the dialog', async () => {
    const { configPatches } = await renderApp({
      config: { activeProfileId: 'pa', profiles },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Switch model character' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New character…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New character' })
    fireEvent.change(within(dialog).getByLabelText('Character name'), { target: { value: 'Sidekick' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Avatar 20' }))
    fireEvent.change(within(dialog).getByLabelText('Character system prompt'), { target: { value: 'Answer in one line.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      expect(configPatches).toContainEqual({
        newProfile: { name: 'Sidekick', avatar: 20, persona: 'Answer in one line.' },
      })
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'New character' })).toBeNull()
    })
  })

  it('gates the new-character dialog on a name and submits from the Enter key', async () => {
    const { configPatches } = await renderApp({
      config: { activeProfileId: 'pa', profiles },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Switch model character' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New character…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New character' })
    // No name yet: Create stays disabled and the classic tile is pre-picked.
    const create = within(dialog).getByRole('button', { name: 'Create' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    expect(within(dialog).getByRole('button', { name: 'Classic avatar' }).className).toContain('active')
    const nameInput = within(dialog).getByLabelText('Character name')
    fireEvent.change(nameInput, { target: { value: 'Bare' } })
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    await waitFor(() => {
      expect(configPatches).toContainEqual({ newProfile: { name: 'Bare' } })
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'New character' })).toBeNull()
    })
  })

  it('saves the system prompt onto the character the panel switched to', async () => {
    const { configPatches } = await renderApp({
      config: { activeProfileId: 'pa', profiles },
    })
    fireEvent.click(screen.getByRole('button', { name: /catonooka/ }))
    const panel = await screen.findByRole('dialog', { name: 'Settings' })
    fireEvent.change(within(panel).getByLabelText('Provider profile'), { target: { value: 'pb' } })
    fireEvent.change(within(panel).getByLabelText('System prompt'), { target: { value: 'Be terse.' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
    const patch = await waitFor(() => {
      const found = configPatches.find(body => typeof body.persona === 'string')
      expect(found).toBeDefined()
      return found
    })
    expect(patch).toMatchObject({ switchProfile: 'pb', persona: 'Be terse.' })
  })

  it('re-seeds the system prompt and avatar rows when the panel switches character', async () => {
    await renderApp({
      config: { activeProfileId: 'pa', profiles },
    })
    fireEvent.click(screen.getByRole('button', { name: /catonooka/ }))
    const panel = await screen.findByRole('dialog', { name: 'Settings' })
    expect(within(panel).getByLabelText<HTMLTextAreaElement>('System prompt').value).toBe('helper persona')
    expect(within(panel).getByLabelText<HTMLInputElement>('Welcome question').value).toBe('What shall we build?')
    expect(within(panel).getByRole('button', { name: 'Avatar 22' }).className).not.toContain('active')
    fireEvent.change(within(panel).getByLabelText('Provider profile'), { target: { value: 'pb' } })
    expect(within(panel).getByLabelText<HTMLTextAreaElement>('System prompt').value).toBe('robo persona')
    expect(within(panel).getByLabelText<HTMLInputElement>('Welcome question').value).toBe('What can I help with?')
    expect(within(panel).getByRole('button', { name: 'Avatar 22' }).className).toContain('active')
  })

  it('keeps the avatar pools apart: cats for users, robots for characters', async () => {
    await renderApp({
      config: { activeProfileId: 'pa', profiles },
    })
    fireEvent.click(screen.getByRole('button', { name: /catonooka/ }))
    const panel = await screen.findByRole('dialog', { name: 'Settings' })
    // Every tile appears in exactly one grid: cats (1-10) in the user grid,
    // robots (11-30) in the character grid — never in both.
    expect(within(panel).getAllByRole('button', { name: 'Avatar 10' })).toHaveLength(1)
    expect(within(panel).getAllByRole('button', { name: 'Avatar 22' })).toHaveLength(1)
    expect(within(panel).getAllByRole('button', { name: 'Avatar 30' })).toHaveLength(1)
    // User grid (10 cats) + character grid (20 robots) = 30 numbered tiles;
    // the classic bot avatar is an extra unnumbered option.
    expect(within(panel).getAllByRole('button', { name: /^Avatar \d+$/ })).toHaveLength(30)
  })

  it('offers only robot tiles in the new-character dialog', async () => {
    await renderApp({
      config: { activeProfileId: 'pa', profiles },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Switch model character' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New character…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New character' })
    expect(within(dialog).getByRole('button', { name: 'Avatar 11' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Avatar 30' })).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Avatar 10' })).toBeNull()
  })

  it('applies a character avatar tile instantly from settings', async () => {
    const { configPatches } = await renderApp({
      config: { activeProfileId: 'pa', profiles },
    })
    fireEvent.click(screen.getByRole('button', { name: /catonooka/ }))
    const panel = await screen.findByRole('dialog', { name: 'Settings' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Avatar 22' }))
    await waitFor(() => {
      expect(configPatches).toContainEqual({ avatar: 22 })
    })
  })

  it('restores the classic avatar instantly from settings', async () => {
    const { configPatches } = await renderApp({
      config: { activeProfileId: 'pb', profiles },
    })
    fireEvent.click(screen.getByRole('button', { name: /catonooka/ }))
    const panel = await screen.findByRole('dialog', { name: 'Settings' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Classic avatar' }))
    await waitFor(() => {
      expect(configPatches).toContainEqual({ avatar: null })
    })
  })
})
