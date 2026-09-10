/**
 * Unit coverage for the extension bridge: long-poll handoff, FIFO queueing,
 * settlements, timeouts, profile-label routing, and the heartbeats that
 * answer "connected".
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACTUATION_ACTIONS,
  DEFAULT_BRIDGE_CLIENT,
  DEFAULT_SESSION_IDLE_CLOSE_MS,
  ExtensionBridge,
  EXTENSION_PROTOCOL,
  isActuationJob,
  type ExtensionJob,
} from '../src/bridge.ts'

/** Jobs settle on real timers; every test disposes to clear them. */
const bridges: ExtensionBridge[] = []

function bridge(options: ConstructorParameters<typeof ExtensionBridge>[0] = {}): ExtensionBridge {
  const created = new ExtensionBridge(options)
  bridges.push(created)
  return created
}

afterEach(() => {
  for (const created of bridges.splice(0)) created.dispose()
})

const webJob = { kind: 'web' as const, query: 'dsh chat', url: 'https://duckduckgo.com/?q=dsh+chat', engine: 'duckduckgo' as const, maxResults: 5 }

/** Queue-order tests only enqueue search jobs, so read the search arm back. */
async function nextSearchJob(created: ExtensionBridge, waitMs = 5): Promise<ExtensionJob | null> {
  const job = await created.nextJob(waitMs)
  expect(job === null || 'kind' in job).toBe(true)
  return job
}

/** Browser jobs only ride pollers whose build speaks the current protocol,
 * so tests poll as a current build unless they exercise version gating. */
async function nextBrowserJob(
  created: ExtensionBridge,
  waitMs = 5,
  client = DEFAULT_BRIDGE_CLIENT,
  actuation = false,
): Promise<ExtensionJob | null> {
  return await created.nextJob(waitMs, undefined, client, actuation, EXTENSION_PROTOCOL)
}

describe('nextJob', () => {
  it('hands a queued job straight to the next long-poll', async () => {
    const created = bridge()
    const settlement = created.enqueue(webJob, 60)
    // The job resolves to the waiter without a tick passing in between.
    const job = await created.nextJob(10)
    expect(job).toMatchObject({ kind: 'web', query: 'dsh chat' })
    expect(typeof job?.id).toBe('string')
    created.settle({ id: job?.id, ok: true, sources: [] })
    await expect(settlement).resolves.toEqual({ ok: true, sources: [] })
  })

  it('resolves null after the wait lapses with nothing queued', async () => {
    const created = bridge()
    await expect(created.nextJob(5)).resolves.toBeNull()
  })

  it('serves queued jobs in FIFO order when no waiter is parked', async () => {
    const created = bridge()
    const first = created.enqueue({ ...webJob, query: 'first' }, 60)
    const second = created.enqueue({ ...webJob, query: 'second' }, 60)
    const firstJob = await nextSearchJob(created)
    if (firstJob !== null && 'kind' in firstJob) expect(firstJob.query).toBe('first')
    const secondJob = await nextSearchJob(created)
    if (secondJob !== null && 'kind' in secondJob) expect(secondJob.query).toBe('second')
    created.dispose()
    await expect(first).resolves.toMatchObject({ ok: false })
    await expect(second).resolves.toMatchObject({ ok: false })
  })
})

describe('enqueue ids', () => {
  it('mints distinct ids per job', async () => {
    const created = bridge()
    const ids: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const settlement = created.enqueue({ ...webJob, query: `q${String(index)}` }, 60)
      const job = await created.nextJob(5)
      ids.push(job?.id ?? 'missing')
      created.settle({ id: job?.id, ok: true, sources: [] })
      await settlement
    }
    expect(new Set(ids).size).toBe(3)
  })
})

describe('settle', () => {
  it('keeps only well-typed hits from a success payload', async () => {
    const created = bridge()
    const settlement = created.enqueue(webJob, 60)
    const job = await created.nextJob(5)
    expect(created.settle({
      id: job?.id,
      ok: true,
      sources: [
        { title: 'a', url: 'https://a' },
        { title: 7, url: 'https://bad-type' },
        'not an object',
        { title: 'b', url: 'https://b', snippet: 's', publishedAt: '2026-09-08' },
      ],
    })).toBe(true)
    await expect(settlement).resolves.toEqual({
      ok: true,
      sources: [
        { title: 'a', url: 'https://a' },
        { title: 'b', url: 'https://b', snippet: 's', publishedAt: '2026-09-08' },
      ],
    })
  })

  it('surfaces the extension error, defaulting an empty one', async () => {
    const created = bridge()
    const settlement = created.enqueue(webJob, 60)
    const job = await created.nextJob(5)
    created.settle({ id: job?.id, ok: false, error: 'not logged in to x.com' })
    await expect(settlement).resolves.toEqual({ ok: false, error: 'not logged in to x.com' })

    const retry = created.enqueue(webJob, 60)
    const retryJob = await created.nextJob(5)
    created.settle({ id: retryJob?.id, ok: false, error: '' })
    await expect(retry).resolves.toMatchObject({ ok: false, error: 'the extension reported an unknown failure' })
  })

  it('rejects malformed payloads and unknown ids without settling', async () => {
    const created = bridge()
    const settlement = created.enqueue(webJob, 60)
    const job = await created.nextJob(5)
    expect(created.settle(null)).toBe(false)
    expect(created.settle(['array'])).toBe(false)
    expect(created.settle({ ok: true, sources: [] })).toBe(false)
    expect(created.settle({ id: 'no-such-job', ok: true, sources: [] })).toBe(false)
    // The real job is still pending and settles normally afterwards.
    expect(created.settle({ id: job?.id, ok: true, sources: [] })).toBe(true)
    await expect(settlement).resolves.toEqual({ ok: true, sources: [] })
  })
})

describe('timeouts and disposal', () => {
  it('fails a job the extension never answers', async () => {
    const created = bridge()
    const settlement = created.enqueue(webJob, 10)
    await expect(settlement).resolves.toEqual({ ok: false, error: 'the extension did not answer within 10ms' })
    // A late result for the timed-out job is refused.
    expect(created.settle({ id: '1', ok: true, sources: [] })).toBe(false)
  })

  it('dispose empties waiters and fails pending jobs', async () => {
    const created = bridge()
    const served = created.nextJob(10_000)
    const settlement = created.enqueue(webJob, 10_000)
    const parked = created.nextJob(10_000)
    created.dispose()
    await expect(served).resolves.toMatchObject({ query: 'dsh chat' })
    await expect(parked).resolves.toBeNull()
    await expect(settlement).resolves.toEqual({ ok: false, error: 'the bridge closed before the extension answered' })
  })
})

describe('heartbeat', () => {
  it('tracks recency through markSeen and seenWithin', () => {
    const created = bridge()
    expect(created.seenWithin(15_000, 1_000)).toBe(false)
    created.markSeen(1_000)
    expect(created.seenWithin(15_000, 15_999)).toBe(true)
    expect(created.seenWithin(15_000, 16_001)).toBe(false)
  })
})

describe('job shape', () => {
  it('carries the route decision for both kinds', async () => {
    const created = bridge()
    const jobs: ExtensionJob[] = []
    const xSettlement = created.enqueue({
      kind: 'x', query: 'from:me dsh', url: 'https://x.com/search?q=from%3Ame%20dsh&f=live', engine: 'x', maxResults: 5,
    }, 60)
    const webSettlement = created.enqueue(webJob, 60)
    jobs.push((await created.nextJob(5)) as ExtensionJob, (await created.nextJob(5)) as ExtensionJob)
    expect(jobs.find(job => 'kind' in job && job.kind === 'x')).toMatchObject({ query: 'from:me dsh', engine: 'x' })
    expect(jobs.find(job => 'kind' in job && job.kind === 'web')).toMatchObject({ engine: 'duckduckgo', url: webJob.url })
    created.dispose()
    await xSettlement
    await webSettlement
  })
})

describe('bridge — long-poll and settlement corners', () => {
  it('serves one job to the earliest parked long-poll only', async () => {
    const created = bridge()
    const first = created.nextJob(10_000)
    const second = created.nextJob(10_000)
    const settlement = created.enqueue(webJob, 10_000)
    await expect(first).resolves.toMatchObject({ query: 'dsh chat' })
    created.dispose()
    await expect(second).resolves.toBeNull()
    await expect(settlement).resolves.toMatchObject({ ok: false })
  })

  it('reports the timeout budget in the failure text', async () => {
    const created = bridge()
    await expect(created.enqueue(webJob, 25)).resolves.toEqual({
      ok: false,
      error: 'the extension did not answer within 25ms',
    })
  })

  it('treats a non-array sources payload as no sources, not a failure', async () => {
    const created = bridge()
    const settlement = created.enqueue(webJob, 60)
    const job = await created.nextJob(5)
    expect(created.settle({ id: job?.id, ok: true, sources: 'nope' })).toBe(true)
    await expect(settlement).resolves.toEqual({ ok: true, sources: [] })
  })

  it('accepts a settlement exactly once per job', async () => {
    const created = bridge()
    const settlement = created.enqueue(webJob, 60)
    const job = await created.nextJob(5)
    expect(created.settle({ id: job?.id, ok: false, error: 'first' })).toBe(true)
    expect(created.settle({ id: job?.id, ok: false, error: 'second' })).toBe(false)
    await expect(settlement).resolves.toEqual({ ok: false, error: 'first' })
  })

  it('resolves an immediate empty long-poll at wait zero', async () => {
    const created = bridge()
    await expect(created.nextJob(0)).resolves.toBeNull()
  })

  it('stays connected across clock skew when the heartbeat is in the future', () => {
    const created = bridge()
    created.markSeen(5_000)
    expect(created.seenWithin(15_000, 1_000)).toBe(true)
  })
})

describe('stale queue hygiene', () => {
  it('drops an unanswered job from the queue at its timeout', async () => {
    const created = bridge()
    // No waiter is parked, so the job sits in the queue; its caller times
    // out without the extension ever connecting.
    const settlement = created.enqueue(webJob, 10)
    await expect(settlement).resolves.toEqual({ ok: false, error: 'the extension did not answer within 10ms' })
    // The dead job must not be handed to the next long-poll after a
    // reconnect: the extension would run a full search nobody awaits.
    await expect(created.nextJob(10)).resolves.toBeNull()
  })

  it('keeps a job queued that a waiter already took (delivery in flight)', async () => {
    const created = bridge()
    const parked = created.nextJob(10_000)
    const settlement = created.enqueue(webJob, 10)
    const job = await parked
    expect(job).toMatchObject({ query: 'dsh chat' })
    // Timed out after delivery: nothing queued to drop, settle still refuses.
    await expect(settlement).resolves.toMatchObject({ ok: false })
    expect(created.settle({ id: '1', ok: true, sources: [] })).toBe(false)
  })

  it('releases a parked waiter as soon as its poll client aborts', async () => {
    const created = bridge()
    const abort = new AbortController()
    const parked = created.nextJob(10_000, abort.signal)
    abort.abort()
    await expect(parked).resolves.toBeNull()
    // The aborted waiter is gone: the next enqueue parks a fresh one only
    // for a live poll, and a later poll still gets the job.
    const settlement = created.enqueue(webJob, 10_000)
    const job = await created.nextJob(10)
    expect(job).toMatchObject({ query: 'dsh chat' })
    expect(created.settle({ id: job?.id ?? '', ok: true, sources: [] })).toBe(true)
    await expect(settlement).resolves.toEqual({ ok: true, sources: [] })
  })

  it('an abort after delivery changes nothing', async () => {
    const created = bridge()
    const abort = new AbortController()
    const parked = created.nextJob(10_000, abort.signal)
    const settlement = created.enqueue(webJob, 10_000)
    const job = await parked
    abort.abort()
    expect(job).toMatchObject({ query: 'dsh chat' })
    expect(created.settle({ id: job?.id ?? '', ok: true, sources: [] })).toBe(true)
    await expect(settlement).resolves.toEqual({ ok: true, sources: [] })
  })
})

describe('browser jobs', () => {
  it('round-trips an open step and its observation', async () => {
    const created = bridge()
    const settlement = created.enqueue({ type: 'browser', action: 'open', session: 'main', url: 'https://x.com/me' }, 60)
    const job = await nextBrowserJob(created)
    expect(job).toMatchObject({ type: 'browser', action: 'open', session: 'main', url: 'https://x.com/me' })
    expect(created.settle({
      id: job?.id,
      ok: true,
      browser: { url: 'https://x.com/me', title: 'me (@me)', snapshot: 'page "me (@me)"', truncated: true },
    })).toBe(true)
    await expect(settlement).resolves.toEqual({
      ok: true,
      browser: { url: 'https://x.com/me', title: 'me (@me)', snapshot: 'page "me (@me)"', truncated: true },
    })
  })

  it('fails the job when the observation payload is malformed', async () => {
    const created = bridge()
    const settlement = created.enqueue({ type: 'browser', action: 'extract', session: 'main', goal: 'recent posts' }, 60)
    const job = await nextBrowserJob(created)
    // A success with a present-but-malformed observation fails at once
    // instead of hanging the caller until its timeout.
    expect(created.settle({ id: job?.id, ok: true, browser: 'nope' })).toBe(true)
    await expect(settlement).resolves.toMatchObject({ ok: false, error: 'the extension posted a malformed browser observation' })
    // The job is consumed: a corrected payload arrives too late.
    expect(created.settle({ id: job?.id, ok: true, browser: { url: 'https://x.com/me' } })).toBe(false)
  })

  it('coerces a well-typed observation and drops unknown fields', async () => {
    const created = bridge()
    const settlement = created.enqueue({ type: 'browser', action: 'snapshot', session: 'main' }, 60)
    const job = await nextBrowserJob(created)
    expect(created.settle({ id: job?.id, ok: true, browser: { url: 'https://x.com/me', extra: 1 } })).toBe(true)
    await expect(settlement).resolves.toEqual({ ok: true, browser: { url: 'https://x.com/me', title: '', truncated: false } })
  })

  it('fails a wrong-arm settlement fast instead of timing out', async () => {
    const created = bridge()
    // A pre-browser build answers every job with search data; the caller
    // must hear that within the settlement, not after its whole budget.
    const browse = created.enqueue({ type: 'browser', action: 'snapshot', session: 'main' }, 10_000)
    const browseJob = await nextBrowserJob(created)
    expect(created.settle({ id: browseJob?.id, ok: true, sources: [] })).toBe(true)
    await expect(browse).resolves.toEqual({
      ok: false,
      error: 'the extension answered this browser step with search data — its build is older than the app; reload it in chrome://extensions',
    })

    // The mirror image: browser data for a search job fails it too.
    const search = created.enqueue(webJob, 10_000)
    const searchJob = await created.nextJob(5)
    expect(created.settle({ id: searchJob?.id, ok: true, browser: { url: '', title: '', truncated: false } })).toBe(true)
    await expect(search).resolves.toMatchObject({ ok: false, error: expect.stringContaining('newer than the app') })
  })
})

describe('profile-label routing', () => {
  it('serves a pinned job only to a poller with the same label', async () => {
    const created = bridge()
    const settlement = created.enqueue({ type: 'browser', action: 'snapshot', session: 'main', client: 'work' }, 60)
    // The unlabeled poller must not take a job pinned to another identity.
    await expect(nextBrowserJob(created)).resolves.toBeNull()
    const job = await nextBrowserJob(created, 5, 'work')
    expect(job).toMatchObject({ type: 'browser', client: 'work' })
    created.dispose()
    await settlement
  })

  it('skips ahead to the pinned job and leaves unpinned ones for any poller', async () => {
    const created = bridge()
    const plain = created.enqueue(webJob, 60)
    const pinned = created.enqueue({ type: 'browser', action: 'open', session: 'main', url: 'https://a.dev', client: 'work' }, 60)
    // The work poller jumps past the unpinned search waiting in front.
    expect(await nextBrowserJob(created, 5, 'work')).toMatchObject({ client: 'work' })
    // The default poller still gets the unpinned job.
    const plainJob = await nextSearchJob(created)
    if (plainJob !== null && 'kind' in plainJob) expect(plainJob.kind).toBe('web')
    created.dispose()
    await plain
    await pinned
  })

  it('hands a pinned job to the matching parked waiter, not the first one', async () => {
    const created = bridge()
    const defaultParked = created.nextJob(10_000)
    const workParked = created.nextJob(10_000, undefined, 'work', false, EXTENSION_PROTOCOL)
    const pinned = created.enqueue({ type: 'browser', action: 'snapshot', session: 'main', client: 'work' }, 60)
    await expect(workParked).resolves.toMatchObject({ client: 'work' })
    const plain = created.enqueue(webJob, 60)
    await expect(defaultParked).resolves.toMatchObject({ kind: 'web' })
    created.dispose()
    await pinned
    await plain
  })

  it('times a pinned job out even while another profile keeps polling', async () => {
    const created = bridge()
    const settlement = created.enqueue({ type: 'browser', action: 'snapshot', session: 'main', client: 'work' }, 10)
    await expect(settlement).resolves.toEqual({ ok: false, error: 'the extension did not answer within 10ms' })
    // The dead job is gone for the eventual work poller too.
    await expect(created.nextJob(5, undefined, 'work')).resolves.toBeNull()
  })
})

describe('per-client heartbeats', () => {
  it('tracks clients separately through markSeen, clientList, and clientSeenWithin', () => {
    const created = bridge()
    created.markSeen(1_000, 'work')
    created.markSeen(2_000, 'default')
    expect(created.seenWithin(15_000, 3_000)).toBe(true)
    expect(created.clientList(15_000, 3_000)).toEqual([
      { client: 'default', lastSeenAt: 2_000, actuation: false, version: 0 },
      { client: 'work', lastSeenAt: 1_000, actuation: false, version: 0 },
    ])
    // An unlabelled markSeen lands on the default label.
    created.markSeen(4_000)
    expect(created.clientSeenWithin('default', 15_000, 4_500)).toBe(true)
    expect(created.clientSeenWithin('work', 15_000, 16_001)).toBe(false)
    expect(created.clientSeenWithin('work', 15_000, 15_999)).toBe(true)
  })

  it('drops stale clients from clientList while the bridge stays seen', () => {
    const created = bridge()
    created.markSeen(1_000, 'work')
    created.markSeen(20_000, 'default')
    expect(created.clientList(15_000, 20_000)).toEqual([{ client: 'default', lastSeenAt: 20_000, actuation: false, version: 0 }])
    expect(created.seenWithin(15_000, 20_000)).toBe(true)
  })

  it('carries each profile\'s action opt-in through clientList', () => {
    const created = bridge()
    created.markSeen(1_000, 'main')
    created.setClientActuation('main', true)
    created.markSeen(2_000, 'guest')
    expect(created.clientList(15_000, 2_000)).toEqual([
      { client: 'guest', lastSeenAt: 2_000, actuation: false, version: 0 },
      { client: 'main', lastSeenAt: 1_000, actuation: true, version: 0 },
    ])
    // A later poll can turn actions back off for the profile.
    created.setClientActuation('main', false)
    expect(created.clientList(15_000, 3_000).find(entry => entry.client === 'main')?.actuation).toBe(false)
  })
})

describe('isActuationJob', () => {
  it('flags exactly the five actuation actions', () => {
    expect([...ACTUATION_ACTIONS].sort()).toEqual(['back', 'click', 'press', 'scroll', 'type'])
    for (const action of ['click', 'type', 'press', 'scroll', 'back']) {
      expect(isActuationJob({ id: '1', type: 'browser', action, session: 'main' } as ExtensionJob)).toBe(true)
    }
  })

  it('leaves read steps and search jobs alone', () => {
    for (const action of ['open', 'snapshot', 'extract', 'close']) {
      expect(isActuationJob({ id: '1', type: 'browser', action, session: 'main' } as ExtensionJob)).toBe(false)
    }
    expect(isActuationJob({ id: '2', kind: 'web', query: 'q', url: 'https://a', engine: 'google', maxResults: 5 } as ExtensionJob)).toBe(false)
  })
})

describe('actuation routing', () => {
  const clickJob = { type: 'browser' as const, action: 'click' as const, session: 'main', ref: '@e1' }
  it('never hands an actuation job to a read-only poller', async () => {
    const created = bridge()
    const settlement = created.enqueue(clickJob, 15)
    // The read-only default poller finds nothing — its wait lapses empty.
    await expect(nextBrowserJob(created)).resolves.toBeNull()
    await expect(settlement).resolves.toEqual({ ok: false, error: 'the extension did not answer within 15ms' })
  })

  it('hands an actuation job to an actions-enabled poller', async () => {
    const created = bridge()
    const settlement = created.enqueue(clickJob, 60)
    const job = await nextBrowserJob(created, 5, 'guest', true)
    expect(job).toMatchObject({ type: 'browser', action: 'click', ref: '@e1' })
    expect(created.settle({ id: job?.id, ok: true, browser: { url: 'https://a.example', title: 'a', truncated: false } })).toBe(true)
    await expect(settlement).resolves.toMatchObject({ ok: true })
  })

  it('keeps a pinned actuation job away from its read-only label, read jobs flow normally', async () => {
    const created = bridge()
    const pinned = created.enqueue({ ...clickJob, client: 'work' }, 15)
    // The work poller, actions off, cannot take its own pinned click.
    await expect(nextBrowserJob(created, 5, 'work')).resolves.toBeNull()
    await expect(pinned).resolves.toMatchObject({ ok: false })
    // A read-only job for the same label still flows.
    const read = created.enqueue({ type: 'browser', action: 'snapshot', session: 'main', client: 'work' }, 60)
    expect(await nextBrowserJob(created, 5, 'work')).toMatchObject({ action: 'snapshot' })
    created.dispose()
    await read
  })

  it('skips actuation jobs ahead to an actions-enabled parked waiter', async () => {
    const created = bridge()
    const readOnlyParked = created.nextJob(10_000, undefined, DEFAULT_BRIDGE_CLIENT, false, EXTENSION_PROTOCOL)
    const actionsParked = created.nextJob(10_000, undefined, 'guest', true, EXTENSION_PROTOCOL)
    const click = created.enqueue({ ...clickJob, session: 'form' }, 60)
    await expect(actionsParked).resolves.toMatchObject({ action: 'click', session: 'form' })
    const read = created.enqueue({ type: 'browser', action: 'snapshot', session: 'main' }, 60)
    await expect(readOnlyParked).resolves.toMatchObject({ action: 'snapshot' })
    created.dispose()
    await click
    await read
  })
})

describe('protocol versions', () => {
  it('records each poll\'s stamp and reports it through clientList', () => {
    const created = bridge()
    created.markSeen(1_000, 'work')
    created.setClientVersion('work', EXTENSION_PROTOCOL)
    created.markSeen(2_000, 'default')
    expect(created.clientList(15_000, 2_000)).toEqual([
      { client: 'default', lastSeenAt: 2_000, actuation: false, version: 0 },
      { client: 'work', lastSeenAt: 1_000, actuation: false, version: EXTENSION_PROTOCOL },
    ])
    // Junk stamps record as 0, the pre-protocol build's signature.
    created.setClientVersion('default', Number.NaN)
    expect(created.clientList(15_000, 2_000)[0]?.version).toBe(0)
    created.setClientVersion('default', -2)
    expect(created.clientList(15_000, 2_000)[0]?.version).toBe(0)
  })

  it('never hands a queued browser job to an unstamped poller', async () => {
    const created = bridge()
    const settlement = created.enqueue({ type: 'browser', action: 'snapshot', session: 'main' }, 15)
    await expect(created.nextJob(5)).resolves.toBeNull()
    await expect(settlement).resolves.toEqual({ ok: false, error: 'the extension did not answer within 15ms' })
  })

  it('skips a parked stale poller in favor of a current one', async () => {
    const created = bridge()
    const staleParked = created.nextJob(10_000)
    const currentParked = created.nextJob(10_000, undefined, 'work', false, EXTENSION_PROTOCOL)
    const settlement = created.enqueue({ type: 'browser', action: 'open', session: 'main', url: 'https://a.dev' }, 60)
    await expect(currentParked).resolves.toMatchObject({ type: 'browser' })
    // The stale poller still waits; a search flows to it untouched.
    const search = created.enqueue(webJob, 60)
    await expect(staleParked).resolves.toMatchObject({ kind: 'web' })
    created.dispose()
    await settlement
    await search
  })

  it('serves searches to stale pollers — only the browser vocabulary is gated', async () => {
    const created = bridge()
    const settlement = created.enqueue(webJob, 60)
    const job = await created.nextJob(5)
    expect(job).toMatchObject({ query: 'dsh chat' })
    expect(created.settle({ id: job?.id, ok: true, sources: [] })).toBe(true)
    await expect(settlement).resolves.toEqual({ ok: true, sources: [] })
  })
})

describe('idle session auto-close', () => {
  /** Run one snapshot step to completion (it also arms the idle lease). */
  async function stepOnce(created: ExtensionBridge): Promise<void> {
    const settlement = created.enqueue({ type: 'browser', action: 'snapshot', session: 'main' }, 60)
    const job = await created.nextJob(5, undefined, DEFAULT_BRIDGE_CLIENT, false, EXTENSION_PROTOCOL)
    created.settle({ id: job?.id, ok: true, browser: { url: 'https://a.example', title: 'a', truncated: false } })
    await settlement
  }

  /** Under fake timers a parked poll needs the clock moved to answer. */
  async function pollNothing(created: ExtensionBridge): Promise<ExtensionJob | null> {
    const parked = created.nextJob(1, undefined, DEFAULT_BRIDGE_CLIENT, false, EXTENSION_PROTOCOL)
    vi.advanceTimersByTime(1)
    return await parked
  }

  it('hands the extension a close job once a session idles out', async () => {
    vi.useFakeTimers()
    try {
      const created = bridge({ sessionIdleCloseMs: 50 })
      await stepOnce(created)
      // Not before the window lapses (the poll's own 1ms tick included).
      vi.advanceTimersByTime(48)
      expect(await pollNothing(created)).toBeNull()
      vi.advanceTimersByTime(1)
      const closer = await created.nextJob(5, undefined, DEFAULT_BRIDGE_CLIENT, false, EXTENSION_PROTOCOL)
      expect(closer).toMatchObject({ type: 'browser', action: 'close', session: 'main' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('renews the lease on every step, so an active task keeps its tab', async () => {
    vi.useFakeTimers()
    try {
      const created = bridge({ sessionIdleCloseMs: 50 })
      await stepOnce(created)
      vi.advanceTimersByTime(30)
      // A second step halfway through restarts the window.
      await stepOnce(created)
      vi.advanceTimersByTime(31)
      expect(await pollNothing(created)).toBeNull()
      vi.advanceTimersByTime(19)
      const closer = await created.nextJob(5, undefined, DEFAULT_BRIDGE_CLIENT, false, EXTENSION_PROTOCOL)
      expect(closer).toMatchObject({ action: 'close', session: 'main' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('an explicit close cancels the pending janitor job', async () => {
    vi.useFakeTimers()
    try {
      const created = bridge({ sessionIdleCloseMs: 50 })
      await stepOnce(created)
      const close = created.enqueue({ type: 'browser', action: 'close', session: 'main' }, 60)
      const taken = await created.nextJob(5, undefined, DEFAULT_BRIDGE_CLIENT, false, EXTENSION_PROTOCOL)
      expect(taken).toMatchObject({ action: 'close' })
      created.settle({ id: taken?.id, ok: true, browser: { url: '', title: '', truncated: false } })
      await close
      vi.advanceTimersByTime(200)
      // The janitor was cancelled: nothing else is ever delivered.
      expect(await pollNothing(created)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('searches never schedule a close', async () => {
    vi.useFakeTimers()
    try {
      const created = bridge({ sessionIdleCloseMs: 50 })
      const search = created.enqueue(webJob, 60)
      const searchJob = await created.nextJob(5)
      created.settle({ id: searchJob?.id, ok: true, sources: [] })
      await search
      vi.advanceTimersByTime(50)
      // No browser session was ever stepped on: no close appears.
      expect(await pollNothing(created)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sessionIdleCloseMs 0 keeps the old lease-forever behavior', async () => {
    vi.useFakeTimers()
    try {
      const created = bridge({ sessionIdleCloseMs: 0 })
      await stepOnce(created)
      vi.advanceTimersByTime(600_000)
      expect(await pollNothing(created)).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose cancels idle-close leases', async () => {
    vi.useFakeTimers()
    try {
      const created = bridge({ sessionIdleCloseMs: 50 })
      await stepOnce(created)
      created.dispose()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the default lease is two minutes', () => {
    expect(DEFAULT_SESSION_IDLE_CLOSE_MS).toBe(120_000)
  })
})
