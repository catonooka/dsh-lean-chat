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
  const factory = new Function('chrome', 'snapshotPage', 'extractText', `${backgroundSource}\nreturn { run, parseWebUrl, reapIdleSessions }`)
  return factory(chromeStub, serializer.snapshotPage, serializer.extractText) as WorkerExports
}

/** The chrome surface background.js touches, faked promise-style like MV3. */
function fakeChrome(initialSessions: Record<string, unknown> = {}) {
  const sent: SentCommand[] = []
  let nextTabId = 0
  const liveTabs = new Set<number>()
  const sessionStore: Record<string, unknown> = { browserSessions: initialSessions }
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
      sendCommand: async (target: { tabId: number }, method: string, params: Record<string, unknown>) => {
        sent.push({ tabId: target.tabId, method, params })
        if (method === 'Runtime.evaluate') {
          const expression = String(params.expression)
          if (expression === 'document.readyState === "complete"') {
            return { result: { type: 'boolean', value: document.readyState === 'complete' } }
          }
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
        return {}
      },
    },
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
