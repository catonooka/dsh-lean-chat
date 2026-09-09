/**
 * Unit coverage for the extension bridge: long-poll handoff, FIFO queueing,
 * settlements, timeouts, profile-label routing, and the heartbeats that
 * answer "connected".
 */

import { afterEach, describe, expect, it } from 'vitest'
import { ExtensionBridge, type ExtensionJob } from '../src/bridge.ts'

/** Jobs settle on real timers; every test disposes to clear them. */
const bridges: ExtensionBridge[] = []

function bridge(): ExtensionBridge {
  const created = new ExtensionBridge()
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
    const job = await created.nextJob(5)
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

  it('defaults missing observation fields and refuses malformed payloads', async () => {
    const created = bridge()
    const settlement = created.enqueue({ type: 'browser', action: 'extract', session: 'main', goal: 'recent posts' }, 60)
    const job = await created.nextJob(5)
    // A success without a well-typed observation object does not consume the
    // job: the extension would have to retry with a real payload.
    expect(created.settle({ id: job?.id, ok: true })).toBe(false)
    expect(created.settle({ id: job?.id, ok: true, browser: 'nope' })).toBe(false)
    expect(created.settle({ id: job?.id, ok: true, browser: { url: 'https://x.com/me', extra: 1 } })).toBe(true)
    await expect(settlement).resolves.toEqual({ ok: true, browser: { url: 'https://x.com/me', title: '', truncated: false } })
  })

  it('refuses settlements of the wrong arm without consuming the job', async () => {
    const created = bridge()
    const search = created.enqueue(webJob, 60)
    const searchJob = await created.nextJob(5)
    expect(created.settle({ id: searchJob?.id, ok: true, browser: { url: '', title: '', truncated: false } })).toBe(false)
    expect(created.settle({ id: searchJob?.id, ok: true, sources: [] })).toBe(true)
    await expect(search).resolves.toEqual({ ok: true, sources: [] })

    const browse = created.enqueue({ type: 'browser', action: 'snapshot', session: 'main' }, 60)
    const browseJob = await created.nextJob(5)
    expect(created.settle({ id: browseJob?.id, ok: true, sources: [] })).toBe(false)
    expect(created.settle({ id: browseJob?.id, ok: true, browser: { url: 'https://x.com/me', title: 'me', truncated: false } })).toBe(true)
    await expect(browse).resolves.toMatchObject({ ok: true, browser: { title: 'me' } })
  })
})

describe('profile-label routing', () => {
  it('serves a pinned job only to a poller with the same label', async () => {
    const created = bridge()
    const settlement = created.enqueue({ type: 'browser', action: 'snapshot', session: 'main', client: 'work' }, 60)
    // The unlabeled poller must not take a job pinned to another identity.
    await expect(created.nextJob(5)).resolves.toBeNull()
    const job = await created.nextJob(5, undefined, 'work')
    expect(job).toMatchObject({ type: 'browser', client: 'work' })
    created.dispose()
    await settlement
  })

  it('skips ahead to the pinned job and leaves unpinned ones for any poller', async () => {
    const created = bridge()
    const plain = created.enqueue(webJob, 60)
    const pinned = created.enqueue({ type: 'browser', action: 'open', session: 'main', url: 'https://a.dev', client: 'work' }, 60)
    // The work poller jumps past the unpinned search waiting in front.
    expect(await created.nextJob(5, undefined, 'work')).toMatchObject({ client: 'work' })
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
    const workParked = created.nextJob(10_000, undefined, 'work')
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
      { client: 'default', lastSeenAt: 2_000 },
      { client: 'work', lastSeenAt: 1_000 },
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
    expect(created.clientList(15_000, 20_000)).toEqual([{ client: 'default', lastSeenAt: 20_000 }])
    expect(created.seenWithin(15_000, 20_000)).toBe(true)
  })
})
