// @vitest-environment jsdom
/**
 * End-to-end coverage of the extension's browser-step path with a faked
 * chrome API: the real background.js dispatches a browser job, drives its
 * session tab through the fake chrome.debugger, and posts the settlement the
 * bridge expects. Runtime.evaluate executes the real injected serializer
 * against this file's jsdom document, so the observation is authentic.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTENSION_PROTOCOL } from '../src/bridge.ts'

interface SerializedPage {
  url: string
  title: string
  snapshot: string
  truncated: boolean
}

interface WorkerExports {
  run: (job: Record<string, unknown>) => Promise<void>
  parseWebUrl: (candidate: string) => string
  reapIdleSessions: (now?: number) => Promise<void>
  setActuationAllowed: (value: boolean) => void
  clientQuery: () => string
}

interface SentCommand {
  tabId: number
  method: string
  params: Record<string, unknown>
}

function loadWorker(chromeStub: unknown): WorkerExports {
  // The jsdom environment replaces the global URL, so the extension directory
  // resolves from the repo root the suite always runs from.
  const directory = join(process.cwd(), 'packages/web/web-search-chrome/extension')
  const serializerSource = readFileSync(join(directory, 'serializer.js'), 'utf8')
  const backgroundSource = readFileSync(join(directory, 'background.js'), 'utf8')
  const serializer = new Function(`${serializerSource}\nreturn { snapshotPage, extractText }`)() as Record<string, unknown>
  const factory = new Function('chrome', 'snapshotPage', 'extractText', `${backgroundSource}\nreturn { run, parseWebUrl, reapIdleSessions, setActuationAllowed, clientQuery }`)
  return factory(chromeStub, serializer.snapshotPage, serializer.extractText) as WorkerExports
}

/** The chrome surface background.js touches, faked promise-style like MV3. */
function fakeChrome(initialSessions: Record<string, unknown> = {}, options: {
  refCenter?: { x: number; y: number } | null
  pageScriptError?: string
  rawObservation?: unknown
  /** Whether an injected scroll actually moved the page (jsdom cannot). */
  scrollMoved?: boolean
  /** Debugger commands matching one of these methods never resolve. */
  hangMethods?: string[]
} = {}) {
  const sent: SentCommand[] = []
  let nextTabId = 0
  const liveTabs = new Set<number>()
  const sessionStore: Record<string, unknown> = { browserSessions: initialSessions }
  const refCenter = options.refCenter === undefined ? { x: 150, y: 40 } : options.refCenter
  const chromeStub = {
    storage: {
      // The boot callback is never invoked, so the poll loop never starts.
      local: { get: (_defaults: unknown, _callback: (stored: unknown) => void) => undefined },
      onChanged: { addListener: (_listener: unknown) => undefined },
      session: {
        get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...sessionStore }),
        set: async (values: Record<string, unknown>) => { Object.assign(sessionStore, values) },
      },
    },
    alarms: {
      create: (_name: unknown, _info: unknown) => undefined,
      onAlarm: { addListener: (_listener: unknown) => undefined },
    },
    tabs: {
      create: async () => {
        nextTabId += 1
        liveTabs.add(nextTabId)
        return { id: nextTabId }
      },
      get: async (tabId: number) => {
        if (!liveTabs.has(tabId)) throw new Error(`No tab with id: ${String(tabId)}`)
        return { id: tabId }
      },
      remove: async (tabId: number) => { liveTabs.delete(tabId) },
    },
    debugger: {
      attach: async () => undefined,
      detach: async () => undefined,
      // The real extension reads the callback form (the promise form of
      // Page.navigate never resolves in MV3 service workers); the fake
      // honors both so either call style works.
      sendCommand: (
        target: { tabId: number },
        method: string,
        params: Record<string, unknown>,
        callback?: (result: unknown) => void,
      ) => {
        if ((options.hangMethods ?? []).includes(method)) return new Promise(() => {})
        sent.push({ tabId: target.tabId, method, params })
        const respond = (): unknown => {
          if (method !== 'Runtime.evaluate') return {}
          const expression = String(params.expression)
          if (expression === 'document.readyState === "complete"') {
            return { result: { type: 'boolean', value: document.readyState === 'complete' } }
          }
          // The page helpers background.js injects carry markers; answer them
          // from the fake's configured state (refCenter null = stale ref).
          if (expression.startsWith('/*dsh-click*/') || expression.startsWith('/*dsh-focus*/')) {
            return { result: { type: 'boolean', value: refCenter !== null } }
          }
          if (expression.startsWith('/*dsh-mod*/')) return { result: { type: 'number', value: 4 } }
          if (expression.startsWith('/*dsh-scroll*/')) return { result: { type: 'boolean', value: options.scrollMoved !== false } }
          if (expression.startsWith('/*dsh-back*/')) return { result: { type: 'object', value: null } }
          if (options.pageScriptError !== undefined) return { exceptionDetails: { text: options.pageScriptError } }
          if (options.rawObservation !== undefined) return { result: { type: 'object', value: options.rawObservation } }
          // The serializer injections: run them against this jsdom document;
          // a page script error reports back the way real CDP does.
          try {
            const value = eval(expression) as SerializedPage
            return { result: { type: 'object', value } }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { exceptionDetails: { text: message } }
          }
        }
        const response = respond()
        callback?.(response)
        return Promise.resolve(response)
      },
    },
    runtime: {},
  }
  return { chromeStub, sent, createdTabs: () => nextTabId, liveTabs, sessionStore }
}

interface PostedResult {
  url: string
  body: Record<string, unknown>
}

let posted: PostedResult[] = []

beforeEach(() => {
  document.body.innerHTML = ''
  document.title = ''
  posted = []
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    posted.push({ url, body: init?.body !== undefined ? JSON.parse(init.body) as Record<string, unknown> : {} })
    return new Response('{}', { status: 200 })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('extension browser jobs', () => {
  it('opens a session tab, navigates, and settles the observation', async () => {
    document.title = 'me (@me) on X'
    document.body.innerHTML = '<h1>Home</h1><a href="/me">Profile</a><p>hello world</p>'
    const { chromeStub, sent } = fakeChrome()
    const worker = loadWorker(chromeStub)
    await worker.run({ id: '7', type: 'browser', action: 'open', session: 'main', url: 'https://x.com/me' })
    expect(posted).toHaveLength(1)
    expect(posted[0]?.url).toBe('http://127.0.0.1:3095/api/chrome/result')
    const settlement = posted[0]?.body
    expect(settlement?.id).toBe('7')
    expect(settlement?.ok).toBe(true)
    const observation = settlement?.browser as SerializedPage
    expect(observation.title).toBe('me (@me) on X')
    expect(observation.snapshot).toContain('# Home')
    expect(observation.snapshot).toContain('[@e1 link "Profile"] http://localhost:3000/me')
    expect(observation.snapshot).toContain('- hello world')
    expect(observation.truncated).toBe(false)
    // The drive went through the debugger: enable, navigate, a readiness
    // probe, then the serializer injection.
    expect(sent.map(command => command.method)).toEqual(['Page.enable', 'Page.navigate', 'Runtime.evaluate', 'Runtime.evaluate'])
    expect(sent[1]?.params).toEqual({ url: 'https://x.com/me' })
  })

  it('reuses one tab per session name and serializes steps on it', async () => {
    document.body.innerHTML = '<p>page one</p>'
    const { chromeStub, sent, createdTabs } = fakeChrome()
    const worker = loadWorker(chromeStub)
    const first = worker.run({ id: '1', type: 'browser', action: 'open', session: 'main', url: 'https://a.example/' })
    const second = worker.run({ id: '2', type: 'browser', action: 'open', session: 'main', url: 'https://b.example/' })
    await Promise.all([first, second])
    // One tab for both steps, and the commands never interleave.
    expect(createdTabs()).toBe(1)
    const navigations = sent.filter(command => command.method === 'Page.navigate')
    expect(navigations.map(command => command.params.url)).toEqual(['https://a.example/', 'https://b.example/'])
    const evaluateOrder = sent.map(command => command.method)
    const firstSnapshot = evaluateOrder.indexOf('Runtime.evaluate')
    const secondNavigate = evaluateOrder.lastIndexOf('Page.navigate')
    expect(firstSnapshot).toBeLessThan(secondNavigate)
    expect(posted.map(result => result.body.id)).toEqual(['1', '2'])
  })

  it('keeps separate tabs for separate session names', async () => {
    const { chromeStub, createdTabs } = fakeChrome()
    const worker = loadWorker(chromeStub)
    await Promise.all([
      worker.run({ id: '1', type: 'browser', action: 'snapshot', session: 'one' }),
      worker.run({ id: '2', type: 'browser', action: 'snapshot', session: 'two' }),
    ])
    expect(createdTabs()).toBe(2)
    expect(posted.map(result => result.body.ok)).toEqual([true, true])
  })

  it('settles a failure for an unsupported action or a non-web URL', async () => {
    const { chromeStub } = fakeChrome()
    const worker = loadWorker(chromeStub)
    await worker.run({ id: '1', type: 'browser', action: 'invent', session: 'main' })
    await worker.run({ id: '2', type: 'browser', action: 'open', session: 'main', url: 'chrome://settings' })
    expect(posted[0]?.body).toEqual({ id: '1', ok: false, error: 'unsupported browser action: invent' })
    expect(posted[1]?.body).toEqual({ id: '2', ok: false, error: 'only http(s) pages can be opened' })
  })

  it('extracts readable text, navigating first when a URL rides the job', async () => {
    document.title = 'me on X'
    document.body.innerHTML = [
      '<nav>Home Notifications</nav>',
      '<article><h2>Post the first</h2><p>Shipped the browser tool.</p><p>Second post about profiles.</p></article>',
    ].join('')
    const { chromeStub, sent } = fakeChrome()
    const worker = loadWorker(chromeStub)
    await worker.run({ id: '9', type: 'browser', action: 'extract', session: 'main', url: 'https://x.com/me' })
    const settlement = posted[0]?.body
    expect(settlement?.ok).toBe(true)
    const observation = settlement?.browser as { text: string; truncated: boolean; title: string }
    expect(observation.title).toBe('me on X')
    expect(observation.truncated).toBe(false)
    expect(observation.text).toContain('## Post the first')
    expect(observation.text).toContain('Shipped the browser tool.')
    expect(observation.text).not.toContain('Notifications')
    const methods = sent.map(command => command.method)
    expect(methods).toContain('Page.navigate')
    expect(methods[methods.length - 1]).toBe('Runtime.evaluate')
  })

  it('extracts the current page when no URL is given', async () => {
    document.body.innerHTML = '<article><p>Already open content.</p></article>'
    const { chromeStub, sent } = fakeChrome()
    const worker = loadWorker(chromeStub)
    await worker.run({ id: '3', type: 'browser', action: 'extract', session: 'main' })
    const observation = posted[0]?.body.browser as { text: string }
    expect(observation.text).toContain('Already open content.')
    expect(sent.some(command => command.method === 'Page.navigate')).toBe(false)
  })

  it('closes the session tab and detaches; a later step mints a fresh one', async () => {
    document.body.innerHTML = '<p>page</p>'
    const { chromeStub, createdTabs, liveTabs, sessionStore } = fakeChrome()
    const worker = loadWorker(chromeStub)
    await worker.run({ id: '1', type: 'browser', action: 'open', session: 'main', url: 'https://a.example/' })
    expect(createdTabs()).toBe(1)
    await worker.run({ id: '2', type: 'browser', action: 'close', session: 'main' })
    expect(liveTabs.size).toBe(0)
    expect((sessionStore.browserSessions as Record<string, unknown>).main).toBeUndefined()
    expect(posted[1]?.body).toEqual({ id: '2', ok: true, browser: { url: '', title: '', truncated: false } })
    await worker.run({ id: '3', type: 'browser', action: 'snapshot', session: 'main' })
    expect(createdTabs()).toBe(2)
  })

  it('reaps idle session tabs but keeps freshly used ones', async () => {
    const now = Date.now()
    const { chromeStub, liveTabs, sessionStore } = fakeChrome({
      stale: { tabId: 41, at: now - 11 * 60 * 1000 },
      fresh: { tabId: 42, at: now - 1000 },
    })
    liveTabs.add(41)
    liveTabs.add(42)
    const worker = loadWorker(chromeStub)
    await worker.reapIdleSessions(now)
    expect(liveTabs.has(41)).toBe(false)
    expect(liveTabs.has(42)).toBe(true)
    const remaining = sessionStore.browserSessions as Record<string, { tabId: number }>
    expect(remaining.stale).toBeUndefined()
    expect(remaining.fresh?.tabId).toBe(42)
  })
})

describe('extension actuation jobs', () => {
  it('clicks a snapshot ref through page script and returns the new outline', async () => {
    document.body.innerHTML = '<h1>After</h1><a href="/next">Next</a>'
    const { chromeStub, sent } = fakeChrome()
    const worker = loadWorker(chromeStub)
    worker.setActuationAllowed(true)
    await worker.run({ id: '1', type: 'browser', action: 'click', session: 'main', ref: '@e3' })
    const settlement = posted[0]?.body
    expect(settlement?.ok).toBe(true)
    const observation = settlement?.browser as SerializedPage
    expect(observation.snapshot).toContain('# After')
    // The click rides el.click() in page script — Input.dispatchMouseEvent
    // never answers on current Chrome builds — and no mouse command ships.
    const clickEval = sent.find(command => command.method === 'Runtime.evaluate' && String(command.params.expression).startsWith('/*dsh-click*/'))
    expect(String(clickEval?.params.expression)).toContain('"@e3"')
    expect(String(clickEval?.params.expression)).toContain('.click()')
    expect(sent.some(command => command.method === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('types by focusing through script, selecting all through the chord, and inserting text', async () => {
    document.body.innerHTML = '<input placeholder="Search">'
    const { chromeStub, sent } = fakeChrome()
    const worker = loadWorker(chromeStub)
    worker.setActuationAllowed(true)
    await worker.run({ id: '2', type: 'browser', action: 'type', session: 'main', ref: '@e1', text: 'hello world' })
    const methods = sent.map(command => `${command.method}:${String(command.params.type ?? '')}`)
    expect(methods).toContain('Input.dispatchKeyEvent:rawKeyDown')
    expect(methods).toContain('Input.dispatchKeyEvent:keyUp')
    const focusEval = sent.find(command => command.method === 'Runtime.evaluate' && String(command.params.expression).startsWith('/*dsh-focus*/'))
    expect(String(focusEval?.params.expression)).toContain('.focus()')
    expect(sent.some(command => command.method === 'Input.dispatchMouseEvent')).toBe(false)
    const insert = sent.find(command => command.method === 'Input.insertText')
    expect(insert?.params).toEqual({ text: 'hello world' })
    const chord = sent.find(command => command.method === 'Input.dispatchKeyEvent' && command.params.key === 'a')
    expect(chord?.params.modifiers).toBe(4)
    expect(posted[0]?.body.ok).toBe(true)
  })

  it('refuses actuation when the profile has not opted in', async () => {
    const { chromeStub, sent } = fakeChrome()
    const worker = loadWorker(chromeStub)
    await worker.run({ id: '3', type: 'browser', action: 'click', session: 'main', ref: '@e1' })
    expect(posted[0]?.body).toEqual({
      id: '3', ok: false, error: 'actions are not enabled for this Chrome profile — turn them on in the extension options',
    })
    expect(sent.filter(command => command.method.startsWith('Input.'))).toHaveLength(0)
  })

  it('reports a stale ref instead of clicking blindly', async () => {
    const { chromeStub, sent } = fakeChrome({}, { refCenter: null })
    const worker = loadWorker(chromeStub)
    worker.setActuationAllowed(true)
    await worker.run({ id: '4', type: 'browser', action: 'click', session: 'main', ref: '@e9' })
    expect(posted[0]?.body).toEqual({ id: '4', ok: false, error: 'ref @e9 is not on the page — take a fresh snapshot and use its refs' })
    expect(sent.filter(command => command.method.startsWith('Input.'))).toHaveLength(0)
  })

  it('presses named keys and rejects unknown ones', async () => {
    document.body.innerHTML = '<p>page</p>'
    const { chromeStub, sent } = fakeChrome()
    const worker = loadWorker(chromeStub)
    worker.setActuationAllowed(true)
    await worker.run({ id: '5', type: 'browser', action: 'press', session: 'main', key: 'Enter' })
    const keyEvents = sent.filter(command => command.method === 'Input.dispatchKeyEvent')
    expect(keyEvents.map(command => command.params.type)).toEqual(['keyDown', 'keyUp'])
    expect(keyEvents[0]?.params).toMatchObject({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    expect(posted[0]?.body.ok).toBe(true)
    await worker.run({ id: '6', type: 'browser', action: 'press', session: 'main', key: 'F13' })
    expect(posted[1]?.body.ok).toBe(false)
    expect(posted[1]?.body.error).toContain('unsupported key "F13"')
  })

  it('scrolls a direction through page script and goes back', async () => {
    document.body.innerHTML = '<p>page</p>'
    const { chromeStub, sent } = fakeChrome()
    const worker = loadWorker(chromeStub)
    worker.setActuationAllowed(true)
    await worker.run({ id: '7', type: 'browser', action: 'scroll', session: 'main', direction: 'down' })
    // Scrolling rides injected script (the debugger's wheel command hangs on
    // current Chrome), never an Input.dispatchMouseEvent.
    const scrollEval = sent.find(command => command.method === 'Runtime.evaluate' && String(command.params.expression).startsWith('/*dsh-scroll*/'))
    expect(String(scrollEval?.params.expression)).toContain('window.scrollBy')
    expect(sent.some(command => command.method === 'Input.dispatchMouseEvent' && command.params.type === 'mouseWheel')).toBe(false)
    expect(posted[0]?.body.ok).toBe(true)
    await worker.run({ id: '8', type: 'browser', action: 'back', session: 'main' })
    expect(sent.some(command => command.method === 'Runtime.evaluate' && String(command.params.expression).startsWith('/*dsh-back*/'))).toBe(true)
    expect(posted[1]?.body.ok).toBe(true)
    // A nowhere-to-scroll page fails with the actionable message.
    const stuck = fakeChrome({}, { scrollMoved: false })
    const stuckWorker = loadWorker(stuck.chromeStub)
    stuckWorker.setActuationAllowed(true)
    await stuckWorker.run({ id: '9', type: 'browser', action: 'scroll', session: 'main', direction: 'down' })
    expect(posted[2]?.body).toMatchObject({ id: '9', ok: false, error: 'the page has nowhere to scroll' })
  })
})

describe('one-trip reading', () => {
  const timeline = [
    '<nav>Home</nav>',
    '<main>',
    ...['shipped the browser tool', 'profiles land safely', 'actuation is opt-in', 'docs caught up', 'e2e went green']
      .map((text, index) => `<article><div>me · Sep ${String(10 - index)}</div><p>post ${String(index + 1)}: ${text}</p></article>`),
    '<a href="/compose">Compose</a>',
    '</main>',
  ].join('')

  it('answers "read my five recent posts" in a single trip', async () => {
    document.body.innerHTML = timeline
    const { chromeStub, sent } = fakeChrome()
    const worker = loadWorker(chromeStub)
    await worker.run({ id: 'r1', type: 'browser', action: 'extract', session: 'main', url: 'https://x.com/me' })
    const settlement = posted[0]?.body
    expect(settlement?.ok).toBe(true)
    const observation = settlement?.browser as SerializedPage & { text: string }
    // The five posts come back as numbered items…
    expect(observation.text).toContain('1. me · Sep 10post 1: shipped the browser tool')
    expect(observation.text).toContain('5. me · Sep 6post 5: e2e went green')
    // …and the outline rides along with refs for any follow-up action.
    expect(observation.snapshot).toContain('[@e1 link "Compose"] http://localhost:3000/compose')
    // Exactly one navigation — one trip end to end.
    expect(sent.filter(command => command.method === 'Page.navigate')).toHaveLength(1)
  })

  it('merges truncation from the text half into the combined observation', async () => {
    document.body.innerHTML = `<main>${Array.from({ length: 40 }, (_, index) => `<article><p>post ${String(index + 1)}</p></article>`).join('')}</main>`
    const { chromeStub } = fakeChrome()
    const worker = loadWorker(chromeStub)
    await worker.run({ id: 'r2', type: 'browser', action: 'extract', session: 'main' })
    const observation = posted[0]?.body.browser as { truncated: boolean; text: string; snapshot: string }
    // Forty items cap at thirty: the text half flags truncation, the snapshot
    // half does not, and the combined answer carries the flag.
    expect(observation.truncated).toBe(true)
    expect(observation.text.split('\n')).toHaveLength(30)
    expect(observation.snapshot).toContain('- post 1')
  })
})

describe('extension page-script failure guards', () => {
  it('surfaces a throwing page script as the step error', async () => {
    const { chromeStub } = fakeChrome({}, { pageScriptError: 'TypeError: Cannot read props of null' })
    const worker = loadWorker(chromeStub)
    await worker.run({ id: '1', type: 'browser', action: 'open', session: 'main', url: 'https://a.example/' })
    expect(posted[0]?.body).toMatchObject({ id: '1', ok: false, error: 'page script failed: TypeError: Cannot read props of null' })
  })

  it('refuses a snapshot observation that is not an object', async () => {
    const { chromeStub } = fakeChrome({}, { rawObservation: 'just a string' })
    const worker = loadWorker(chromeStub)
    await worker.run({ id: '2', type: 'browser', action: 'snapshot', session: 'main' })
    expect(posted[0]?.body).toMatchObject({ id: '2', ok: false, error: 'the page did not answer with an observation' })
  })

  it('refuses an extraction that is not an object', async () => {
    const { chromeStub } = fakeChrome({}, { rawObservation: 42 })
    const worker = loadWorker(chromeStub)
    await worker.run({ id: '3', type: 'browser', action: 'extract', session: 'main' })
    expect(posted[0]?.body).toMatchObject({ id: '3', ok: false, error: 'the page did not answer with an extraction' })
  })
})

describe('extension parseWebUrl', () => {
  it('accepts http and https and normalizes the href', () => {
    const { chromeStub } = fakeChrome()
    const worker = loadWorker(chromeStub)
    expect(worker.parseWebUrl('https://x.com/me')).toBe('https://x.com/me')
    expect(worker.parseWebUrl('http://127.0.0.1:3095/api')).toBe('http://127.0.0.1:3095/api')
  })

  it('rejects every other scheme', () => {
    const { chromeStub } = fakeChrome()
    const worker = loadWorker(chromeStub)
    expect(() => worker.parseWebUrl('chrome://settings')).toThrow('only http(s)')
    expect(() => worker.parseWebUrl('file:///etc/passwd')).toThrow('only http(s)')
    expect(() => worker.parseWebUrl('javascript:alert(1)')).toThrow('only http(s)')
  })
})

describe('extension protocol and dispatch guards', () => {
  it('stamps the poll with the protocol the bridge gates browser jobs on', async () => {
    const { chromeStub } = fakeChrome()
    const worker = loadWorker(chromeStub)
    const query = worker.clientQuery()
    expect(query).toBe(`&v=${String(EXTENSION_PROTOCOL)}`)
    // The bridge package and the extension literal must not drift apart.
    const backgroundSource = readFileSync(join(process.cwd(), 'packages/web/web-search-chrome/extension/background.js'), 'utf8')
    expect(backgroundSource).toMatch(new RegExp(`const PROTOCOL = ${String(EXTENSION_PROTOCOL)}\\b`))
  })

  it('settles an unknown job type as a loud refusal, never as a search', async () => {
    const { chromeStub } = fakeChrome()
    const worker = loadWorker(chromeStub)
    await worker.run({ id: '5', type: 'telemetry', url: 'https://x.com/' })
    expect(posted).toHaveLength(1)
    expect(posted[0]?.body).toMatchObject({
      id: '5',
      ok: false,
      error: 'this extension build cannot run job type "telemetry" — reload the extension in chrome://extensions',
    })
  })

  it('fails a wedged step on the deadline instead of holding the settlement', async () => {
    vi.useFakeTimers()
    try {
      // Page.navigate never resolves: the tab never settles.
      const { chromeStub } = fakeChrome({}, { hangMethods: ['Page.navigate'] })
      const worker = loadWorker(chromeStub)
      const settled = worker.run({ id: '6', type: 'browser', action: 'open', session: 'main', url: 'https://x.com/hang' })
      await vi.advanceTimersByTimeAsync(40_000)
      await settled
      expect(posted).toHaveLength(1)
      expect(posted[0]?.body).toMatchObject({
        id: '6',
        ok: false,
        error: expect.stringContaining('the browser step did not finish within 40s'),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the session lock after a deadline failure so the next step runs', async () => {
    vi.useFakeTimers()
    try {
      const working = fakeChrome()
      const hung = fakeChrome({}, { hangMethods: ['Page.navigate'] })
      const worker = loadWorker(hung.chromeStub)
      const wedged = worker.run({ id: '6', type: 'browser', action: 'open', session: 'main', url: 'https://x.com/hang' })
      await vi.advanceTimersByTimeAsync(40_000)
      await wedged
      expect(posted[0]?.body).toMatchObject({ id: '6', ok: false })
      // The healthy debugger takes over the same session tab; the lock the
      // wedged open held must be free for the next step.
      hung.chromeStub.debugger.sendCommand = working.chromeStub.debugger.sendCommand
      document.title = 'recovered'
      document.body.innerHTML = '<h1>Home</h1>'
      await worker.run({ id: '7', type: 'browser', action: 'snapshot', session: 'main' })
      expect(posted[1]?.body).toMatchObject({ id: '7', ok: true })
      const observation = (posted[1]?.body as { browser?: { title?: string } }).browser
      expect(observation?.title).toBe('recovered')
    } finally {
      vi.useRealTimers()
    }
  })
})
