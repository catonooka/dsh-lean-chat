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
  clientList: string[]
  jobs: Array<{ job: Omit<BrowserJob, 'id'>; timeoutMs: number }>
  respond: (job: Omit<BrowserJob, 'id'>) => BrowserSettlement
}

function stubBridge(state: Partial<BridgeState> = {}): BrowserBridge & { state: BridgeState } {
  const full: BridgeState = {
    seen: true,
    clients: new Map([['default', true]]),
    clientList: ['default'],
    jobs: [],
    respond: () => ({ ok: true, browser: { url: 'https://x.com/me', title: 'me', snapshot: 'page "me"', truncated: false } }),
    ...state,
  }
  const bridge: BrowserBridge = {
    seenWithin: () => full.seen,
    clientSeenWithin: (client: string) => full.clients.get(client) === true,
    clientList: () => full.clientList.map(client => ({ client, lastSeenAt: 1, actuation: false })),
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
    const bridge = stubBridge({ clientList: ['work', 'default'] })
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
    const created = tool(stubBridge({ clientList: ['work', 'default'] }))
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
