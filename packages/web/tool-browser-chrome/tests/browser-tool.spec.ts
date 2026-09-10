/**
 * Unit coverage for the browser tool: the step dispatch over a stubbed
 * bridge, the compact value/render contract, and the actionable failures
 * (extension absent, profile absent, bad URL, extension-reported errors).
 */

import { describe, expect, it } from 'vitest'
import {
  BROWSER_TOOL_NAME,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  EXTERNAL_PAGE_CONTENT_NOTICE,
  defineBrowserTool,
  type BrowserBridge,
  type BrowserToolValue,
} from '../src/index.ts'
import type { BrowserJob, BrowserSettlement } from '@deepseek-ai/dsh-web-search-chrome/src/bridge.ts'

interface BridgeState {
  seen: boolean
  clients: Map<string, boolean>
  clientList: Array<{ client: string; actuation: boolean }>
  jobs: Array<{ job: Omit<BrowserJob, 'id'>; timeoutMs: number }>
  respond: (job: Omit<BrowserJob, 'id'>) => BrowserSettlement
}

function stubBridge(state: Partial<BridgeState> = {}): BrowserBridge & { state: BridgeState } {
  const full: BridgeState = {
    seen: true,
    clients: new Map([['default', true]]),
    clientList: [{ client: 'default', actuation: false }],
    jobs: [],
    respond: () => ({ ok: true, browser: { url: 'https://x.com/me', title: 'me', snapshot: 'page "me"', truncated: false } }),
    ...state,
  }
  const bridge: BrowserBridge = {
    seenWithin: () => full.seen,
    clientSeenWithin: (client: string) => full.clients.get(client) === true,
    clientList: () => full.clientList.map(entry => ({ ...entry, lastSeenAt: 1 })),
    // The real enqueue is overloaded per job arm; the stub only serves the
    // browser arm and adopts the overloaded type wholesale.
    enqueue: (async (job: Omit<BrowserJob, 'id'>, timeoutMs: number) => {
      full.jobs.push({ job, timeoutMs })
      return full.respond(job)
    }) as BrowserBridge['enqueue'],
  }
  return Object.assign(bridge, { state: full })
}

/** The definition exposes execute/render/presentationMeta directly. */
interface ToolDefinition {
  name: string
  timeoutMs: number
  isConcurrencySafe: () => boolean
  execute: (args: Record<string, unknown>) => Promise<BrowserToolValue>
  output: {
    render: (args: Record<string, unknown>, value: BrowserToolValue) => Array<{ type: string; text: string }>
    presentationMeta: (args: Record<string, unknown>, value: BrowserToolValue) => Record<string, unknown>
  }
}

function tool(bridge: BrowserBridge): ToolDefinition {
  return defineBrowserTool({ bridge }) as unknown as ToolDefinition
}

describe('browser tool definition', () => {
  it('registers a compact, non-concurrent, patient tool', () => {
    const created = tool(stubBridge())
    expect(created.name).toBe(BROWSER_TOOL_NAME)
    expect(created.timeoutMs).toBe(DEFAULT_TOOL_TIMEOUT_MS)
    expect(created.isConcurrencySafe()).toBe(false)
  })

  it('answers status from the bridge heartbeat without a job', async () => {
    const bridge = stubBridge({ clientList: [{ client: 'work', actuation: false }, { client: 'default', actuation: false }] })
    const created = tool(bridge)
    const value = await created.execute({ action: 'status' })
    expect(value).toEqual({ action: 'status', truncated: false, profiles: [{ profile: 'work' }, { profile: 'default' }] })
    expect(bridge.state.jobs).toHaveLength(0)
    const rendered = created.output.render({ action: 'status' }, value)
    expect(rendered[0]?.text).toBe(`${EXTERNAL_PAGE_CONTENT_NOTICE}\n\nConnected Chrome profiles: work, default.`)
  })
})

describe('browser tool dispatch', () => {
  it('enqueues an open job with the session and profile routing', async () => {
    const bridge = stubBridge()
    const created = tool(bridge)
    const value = await created.execute({ action: 'open', url: 'https://x.com/me', profile: 'default', session: 'x-feed' })
    expect(bridge.state.jobs).toEqual([
      { job: { type: 'browser', action: 'open', session: 'x-feed', client: 'default', url: 'https://x.com/me' }, timeoutMs: DEFAULT_JOB_TIMEOUT_MS },
    ])
    expect(value).toEqual({ action: 'open', url: 'https://x.com/me', title: 'me', snapshot: 'page "me"', truncated: false })
  })

  it('defaults the session to main and drops empty optional fields', async () => {
    const bridge = stubBridge()
    const created = tool(bridge)
    await created.execute({ action: 'snapshot' })
    expect(bridge.state.jobs[0]?.job).toEqual({ type: 'browser', action: 'snapshot', session: 'main' })
  })

  it('extract may navigate first; goal rides the job', async () => {
    const bridge = stubBridge()
    const created = tool(bridge)
    await created.execute({ action: 'extract', url: 'https://x.com/me', goal: 'the five most recent posts' })
    expect(bridge.state.jobs[0]?.job).toEqual({
      type: 'browser', action: 'extract', session: 'main', url: 'https://x.com/me', goal: 'the five most recent posts',
    })
  })

  it('carries the remaining step actions across to the bridge', async () => {
    const bridge = stubBridge({ respond: () => ({ ok: true, browser: { url: '', title: '', truncated: false } }) })
    const created = tool(bridge)
    for (const action of ['snapshot', 'extract', 'close'] as const) {
      await created.execute({ action })
    }
    expect(bridge.state.jobs.map(entry => entry.job.action)).toEqual(['snapshot', 'extract', 'close'])
  })
})

describe('browser tool failures', () => {
  it('tells the user to load the extension when none answered lately', async () => {
    const created = tool(stubBridge({ seen: false }))
    await expect(created.execute({ action: 'open', url: 'https://x.com/me' })).rejects.toThrow('the Chrome extension is not connected')
  })

  it('lists connected profiles when the requested one is absent', async () => {
    const created = tool(stubBridge({ clientList: [{ client: 'work', actuation: false }, { client: 'default', actuation: false }] }))
    await expect(created.execute({ action: 'snapshot', profile: 'personal' }))
      .rejects.toThrow('no Chrome profile named "personal" is connected — connected: work, default')
  })

  it('rejects open without a url and any non-http(s) url', async () => {
    const created = tool(stubBridge())
    await expect(created.execute({ action: 'open' })).rejects.toThrow('the open action needs a url')
    await expect(created.execute({ action: 'open', url: '  ' })).rejects.toThrow('the open action needs a url')
    await expect(created.execute({ action: 'open', url: 'file:///etc/passwd' })).rejects.toThrow('only http(s)')
    await expect(created.execute({ action: 'extract', url: 'chrome://settings' })).rejects.toThrow('only http(s)')
  })

  it('surfaces an extension-reported failure as the step error', async () => {
    const created = tool(stubBridge({ respond: () => ({ ok: false, error: 'the debugger was refused' }) }))
    await expect(created.execute({ action: 'open', url: 'https://x.com/me' })).rejects.toThrow('the browser step failed: the debugger was refused')
  })
})

describe('browser tool actuation', () => {
  it('refuses every actuation step while no profile opted in', async () => {
    const created = tool(stubBridge())
    for (const action of ['click', 'type', 'press', 'scroll', 'back'] as const) {
      await expect(created.execute({ action, ...(action === 'type' ? { ref: '@e1', text: 'x' } : {}) }))
        .rejects.toThrow('no Chrome profile allows actions yet')
    }
  })

  it('refuses a pinned actuation step against a read-only profile, naming the capable ones', async () => {
    const created = tool(stubBridge({
      clients: new Map([['guest', true], ['main', true]]),
      clientList: [{ client: 'main', actuation: false }, { client: 'guest', actuation: true }],
    }))
    await expect(created.execute({ action: 'click', ref: '@e1', profile: 'main' }))
      .rejects.toThrow('the "main" profile is read-only — profiles with actions: guest')
  })

  it('dispatches click and type jobs with their ref and text', async () => {
    const bridge = stubBridge({ clients: new Map([['guest', true]]), clientList: [{ client: 'guest', actuation: true }] })
    const created = tool(bridge)
    await created.execute({ action: 'click', ref: ' @e3 ', profile: 'guest', session: 'form' })
    await created.execute({ action: 'type', ref: '@e3', text: 'hello', profile: 'guest' })
    expect(bridge.state.jobs.map(entry => entry.job)).toEqual([
      { type: 'browser', action: 'click', session: 'form', client: 'guest', ref: '@e3' },
      { type: 'browser', action: 'type', session: 'main', client: 'guest', ref: '@e3', text: 'hello' },
    ])
  })

  it('validates what each actuation step requires', async () => {
    const created = tool(stubBridge({ clientList: [{ client: 'guest', actuation: true }] }))
    await expect(created.execute({ action: 'click' })).rejects.toThrow('the click action needs a ref from a snapshot')
    await expect(created.execute({ action: 'type', ref: '@e1' })).rejects.toThrow('the type action needs text')
    await expect(created.execute({ action: 'press' })).rejects.toThrow('the press action needs a key')
  })

  it('dispatches press and scroll with their key and direction', async () => {
    const bridge = stubBridge({ clientList: [{ client: 'guest', actuation: true }] })
    const created = tool(bridge)
    await created.execute({ action: 'press', key: 'enter' })
    await created.execute({ action: 'scroll', direction: 'up' })
    await created.execute({ action: 'scroll' })
    expect(bridge.state.jobs.map(entry => ({ action: entry.job.action, key: entry.job.key, direction: entry.job.direction }))).toEqual([
      { action: 'press', key: 'enter', direction: undefined },
      { action: 'scroll', key: undefined, direction: 'up' },
      { action: 'scroll', key: undefined, direction: 'down' },
    ])
  })

  it('marks action-capable profiles in the status answer and its render', async () => {
    const bridge = stubBridge({
      clientList: [{ client: 'guest', actuation: true }, { client: 'main', actuation: false }],
    })
    const created = tool(bridge)
    const value = await created.execute({ action: 'status' })
    expect(value.profiles).toEqual([{ profile: 'guest', actuation: true }, { profile: 'main' }])
    expect(created.output.render({ action: 'status' }, value)[0]?.text)
      .toContain('Connected Chrome profiles: guest (actions on), main.')
  })
})

describe('browser tool rendering', () => {
  it('renders the guard, page header, snapshot, and truncation note', () => {
    const bridge = stubBridge()
    const created = tool(bridge)
    const value: BrowserToolValue = {
      action: 'open', url: 'https://x.com/me', title: 'me (@me)', snapshot: '# Home\n[@e1 link "Profile"]', truncated: true,
    }
    const rendered = created.output.render({ action: 'open' }, value)
    expect(rendered).toEqual([{
      type: 'text',
      text: [
        EXTERNAL_PAGE_CONTENT_NOTICE,
        'Page: me (@me) — https://x.com/me',
        '# Home\n[@e1 link "Profile"]',
        '(page content was truncated)',
      ].join('\n\n'),
    }])
  })

  it('caps an oversized snapshot defensively', () => {
    const created = tool(stubBridge())
    const value: BrowserToolValue = { action: 'snapshot', snapshot: 'x'.repeat(25_000), truncated: true }
    const text = created.output.render({ action: 'snapshot' }, value)[0]?.text ?? ''
    expect(text.length).toBeLessThan(EXTERNAL_PAGE_CONTENT_NOTICE.length + 21_000)
    expect(text.endsWith('(page content was truncated)')).toBe(true)
    expect(text).toContain('…')
  })

  it('presents an excerpt for the UI chip and names its producer', () => {
    const created = tool(stubBridge())
    const meta = created.output.presentationMeta({ action: 'extract' }, {
      action: 'extract', url: 'https://x.com/me', title: 'me', text: 'first line of the extraction\nsecond line', truncated: false,
    })
    expect(meta).toEqual({
      name: BROWSER_TOOL_NAME, action: 'extract', url: 'https://x.com/me', title: 'me', excerpt: 'first line of the extraction',
    })
  })
})
