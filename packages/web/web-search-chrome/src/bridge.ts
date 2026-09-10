/**
 * The local bridge between the chat app and the companion Chrome extension:
 * the app enqueues jobs (searches and read-only browser steps), the
 * extension's service worker long-polls `/api/chrome/next`, runs the job with
 * this browser's own cookies, and posts the result back. Every connected
 * extension instance labels itself with its Chrome profile name, so a job can
 * be pinned to one identity when several profiles are connected at once.
 * @module @deepseek-ai/dsh-web-search-chrome/bridge
 */

import { coerceRawHits, type RawHit, type WebEngine } from './provider.ts'

/** The label a poller carries when the extension did not configure one. */
export const DEFAULT_BRIDGE_CLIENT = 'default'

/** One search handed to the extension. */
export interface SearchJob {
  /** Bridge-assigned id, echoed back with the result. */
  id: string
  /** Where the search runs: the user's logged-in X, or a general engine page. */
  kind: 'x' | 'web'
  /** The search question for that kind. */
  query: string
  /** The page URL a `web` job fetches. */
  url: string
  /** Which engine the job targets; `x` for X jobs. */
  engine: WebEngine | 'x'
  /** Result budget; the extension may return more, the app trims. */
  maxResults: number
  /** Only the extension running under this Chrome profile may take the job. */
  client?: string
}

/** One browser step the extension runs in the user's own Chrome. */
export interface BrowserJob {
  /** Bridge-assigned id, echoed back with the result. */
  id: string
  /** Discriminator: this job drives a real tab instead of a search fetch. */
  type: 'browser'
  /** The step to run against the session's tab. */
  action: 'open' | 'snapshot' | 'extract' | 'close' | 'click' | 'type' | 'press' | 'scroll' | 'back'
  /** Which named tab the step addresses; the extension keeps one tab per name. */
  session: string
  /** The page to load for an `open`. */
  url?: string
  /** What the model wants pulled off the page for an `extract`. */
  goal?: string
  /** The `@eN` ref from the latest snapshot that `click`/`type` targets. */
  ref?: string
  /** The text a `type` step enters into the ref'd field. */
  text?: string
  /** The key a `press` step sends (Enter, Tab, Escape, arrows, …). */
  key?: string
  /** The direction a `scroll` step rolls. */
  direction?: 'up' | 'down' | 'left' | 'right'
  /** Only the extension running under this Chrome profile may take the job. */
  client?: string
}

/** Steps that act on the page instead of reading it; they only ever run in a
 * Chrome profile whose user turned actions on for that profile. */
export const ACTUATION_ACTIONS: ReadonlySet<string> = new Set(['click', 'type', 'press', 'scroll', 'back'])

/** Whether one queued job needs an actions-enabled profile to run it. */
export function isActuationJob(job: ExtensionJob): boolean {
  return 'type' in job && job.type === 'browser' && ACTUATION_ACTIONS.has(job.action)
}

/** Any job the bridge hands to an extension long-poll. */
export type ExtensionJob = SearchJob | BrowserJob

/** The page state one browser step observed. */
export interface BrowserObservation {
  url: string
  title: string
  snapshot?: string
  text?: string
  truncated: boolean
}

/** What the extension posts back for a search job. */
export type SearchSettlement = { ok: true; sources: RawHit[] } | { ok: false; error: string }

/** What the extension posts back for a browser job. */
export type BrowserSettlement = { ok: true; browser: BrowserObservation } | { ok: false; error: string }

/** What the extension posts back for one job, whichever arm it belongs to. */
export type ExtensionSettlement = SearchSettlement | BrowserSettlement

/** Coerce one extension-posted observation into shape, or reject it. */
function coerceObservation(raw: unknown): BrowserObservation | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const payload = raw as Record<string, unknown>
  const observation: BrowserObservation = {
    url: typeof payload.url === 'string' ? payload.url : '',
    title: typeof payload.title === 'string' ? payload.title : '',
    truncated: payload.truncated === true,
  }
  if (typeof payload.snapshot === 'string') observation.snapshot = payload.snapshot
  if (typeof payload.text === 'string') observation.text = payload.text
  return observation
}

/** A pending job awaiting its settlement, with its give-up timer. */
interface PendingSlot {
  arm: 'search' | 'browser'
  resolve: (settlement: ExtensionSettlement) => void
  timer: ReturnType<typeof setTimeout>
}

/** A parked long-poll, remembered with the profile label it polls for and
 * whether that profile's user allows actions (not just reading). */
interface ParkedPoll {
  client: string
  actuation: boolean
  resolve: (job: ExtensionJob | null) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The in-process job queue shared by the app's routes and its dispatch:
 * `nextJob` serves the extension's long-polls, `enqueue` holds a job until
 * the extension settles it or the timeout lapses, and every request from the
 * extension refreshes the heartbeats that `seenWithin` answers from — one for
 * the bridge overall, one per Chrome profile label, each carrying whether that
 * profile's user allows actions.
 */
export class ExtensionBridge {
  private nextJobId = 1
  private lastSeenAt = 0
  private readonly queue: ExtensionJob[] = []
  private readonly pending = new Map<string, PendingSlot>()
  private readonly waiters: ParkedPoll[] = []
  private readonly clientSeenAt = new Map<string, number>()
  private readonly clientActuation = new Map<string, boolean>()

  /**
   * Record that an extension just made a bridge request.
   * @param now - the heartbeat timestamp.
   * @param client - the Chrome profile label the request came from.
   */
  markSeen(now: number = Date.now(), client: string = DEFAULT_BRIDGE_CLIENT): void {
    this.lastSeenAt = now
    this.clientSeenAt.set(client, now)
  }

  /** Record whether one profile's user allows actions in that profile. */
  setClientActuation(client: string, allowed: boolean): void {
    this.clientActuation.set(client, allowed)
  }

  /** Whether any profile's extension made a request within the window. */
  seenWithin(ttlMs: number, now: number = Date.now()): boolean {
    return this.lastSeenAt > 0 && now - this.lastSeenAt <= ttlMs
  }

  /** Whether the labeled profile's extension made a request within the window. */
  clientSeenWithin(client: string, ttlMs: number, now: number = Date.now()): boolean {
    const at = this.clientSeenAt.get(client)
    return at !== undefined && at > 0 && now - at <= ttlMs
  }

  /** The profile labels seen within the window, freshest first, with whether
   * each allows actions. */
  clientList(ttlMs: number, now: number = Date.now()): { client: string; lastSeenAt: number; actuation: boolean }[] {
    return [...this.clientSeenAt.entries()]
      .filter(([, at]) => at > 0 && now - at <= ttlMs)
      .map(([client, lastSeenAt]) => ({ client, lastSeenAt, actuation: this.clientActuation.get(client) === true }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  /** Whether one poller may run one job: label pin plus, for actuation
   * steps, the profile's own opt-in. */
  private mayTake(job: ExtensionJob, client: string, actuation: boolean): boolean {
    if (isActuationJob(job) && !actuation) return false
    return job.client === undefined || job.client === client
  }

  /**
   * Long-poll the next job this profile may take: resolves immediately when
   * one is queued, else `null` once `waitMs` passes — or as soon as `signal`
   * aborts, so a poller that died mid-park (sleeping machine, reloaded
   * extension) stops holding a waiter that a fresh job would be handed to and
   * lost. A poller takes the jobs pinned to its own profile label first, then
   * the unpinned jobs any profile may run; jobs pinned to another label never
   * move, and actuation steps move only to profiles whose user allows them.
   */
  nextJob(waitMs: number, signal?: AbortSignal, client: string = DEFAULT_BRIDGE_CLIENT, actuation = false): Promise<ExtensionJob | null> {
    const pinned = this.queue.findIndex(job => job.client === client && (!isActuationJob(job) || actuation))
    const pinnedJob = pinned !== -1 ? this.queue.splice(pinned, 1)[0] : undefined
    if (pinnedJob !== undefined) return Promise.resolve(pinnedJob)
    const shared = this.queue.findIndex(job => job.client === undefined && (!isActuationJob(job) || actuation))
    const sharedJob = shared !== -1 ? this.queue.splice(shared, 1)[0] : undefined
    if (sharedJob !== undefined) return Promise.resolve(sharedJob)
    return new Promise((resolve) => {
      const waiter: ParkedPoll = {
        client,
        actuation,
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index !== -1) this.waiters.splice(index, 1)
          resolve(null)
        }, waitMs),
      }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', () => {
        const index = this.waiters.indexOf(waiter)
        if (index !== -1) {
          this.waiters.splice(index, 1)
          clearTimeout(waiter.timer)
          resolve(null)
        }
        // A waiter already resolved with a job is out of our hands; its
        // settle will report the dead socket and the job timer fails it.
      }, { once: true })
    })
  }

  /**
   * Queue one search job and wait for its settlement.
   * @param job - the search to hand over (without an id).
   * @param timeoutMs - how long the extension may take before the promise
   *   settles with a failure.
   * @returns the extension's settlement, or a timeout failure.
   */
  enqueue(job: Omit<SearchJob, 'id'>, timeoutMs: number): Promise<SearchSettlement>
  /**
   * Queue one browser step and wait for its settlement.
   * @param job - the step to hand over (without an id).
   * @param timeoutMs - how long the extension may take; browser steps wait on
   *   real page loads, so callers pass a longer budget than for searches.
   * @returns the extension's settlement, or a timeout failure.
   */
  enqueue(job: Omit<BrowserJob, 'id'>, timeoutMs: number): Promise<BrowserSettlement>
  enqueue(job: Omit<ExtensionJob, 'id'>, timeoutMs: number): Promise<ExtensionSettlement> {
    const full = { id: String(this.nextJobId++), ...job } as ExtensionJob
    const arm: 'search' | 'browser' = 'type' in full && full.type === 'browser' ? 'browser' : 'search'
    return new Promise((resolve) => {
      const entry: PendingSlot = {
        arm,
        resolve,
        timer: setTimeout(() => {
          this.pending.delete(full.id)
          // A job the extension never took must leave the queue too — after
          // a reconnect it would otherwise be executed serially for a
          // caller that already gave up on it.
          const queuedAt = this.queue.indexOf(full)
          if (queuedAt !== -1) this.queue.splice(queuedAt, 1)
          resolve({ ok: false, error: `the extension did not answer within ${String(timeoutMs)}ms` })
        }, timeoutMs),
      }
      this.pending.set(full.id, entry)
      // A pinned job goes to a poller of the same label; an unpinned one
      // prefers the unlabeled poller and falls back to any parked one; an
      // actuation step only ever rides a profile that allows actions.
      const waiter = full.client === undefined
        ? this.waiters.find(parked => parked.client === DEFAULT_BRIDGE_CLIENT && this.mayTake(full, parked.client, parked.actuation))
          ?? this.waiters.find(parked => this.mayTake(full, parked.client, parked.actuation))
        : this.waiters.find(parked => this.mayTake(full, parked.client, parked.actuation))
      if (waiter !== undefined) {
        const index = this.waiters.indexOf(waiter)
        this.waiters.splice(index, 1)
        clearTimeout(waiter.timer)
        waiter.resolve(full)
      } else {
        this.queue.push(full)
      }
    })
  }

  /**
   * Deliver one result payload from the extension.
   * @param raw - the `POST /api/chrome/result` body.
   * @returns whether a pending job consumed it; `false` for unknown ids,
   *   malformed payloads, payloads of the wrong arm, and jobs that already
   *   timed out.
   */
  settle(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
    const payload = raw as { id?: unknown; ok?: unknown; sources?: unknown; browser?: unknown; error?: unknown }
    if (typeof payload.id !== 'string') return false
    const entry = this.pending.get(payload.id)
    if (entry === undefined) return false
    if (payload.ok === true) {
      const observation = coerceObservation(payload.browser)
      if (entry.arm === 'browser') {
        if (observation === null) return false
        this.pending.delete(payload.id)
        clearTimeout(entry.timer)
        entry.resolve({ ok: true, browser: observation })
        return true
      }
      // A browser-shaped payload for a search job is the wrong arm; the job
      // stays pending for a real search settlement.
      if (observation !== null && payload.sources === undefined) return false
      this.pending.delete(payload.id)
      clearTimeout(entry.timer)
      entry.resolve({ ok: true, sources: coerceRawHits(payload.sources) })
      return true
    }
    this.pending.delete(payload.id)
    clearTimeout(entry.timer)
    entry.resolve({
      ok: false,
      error: typeof payload.error === 'string' && payload.error !== ''
        ? payload.error
        : 'the extension reported an unknown failure',
    })
    return true
  }

  /** Drop everything: open long-polls resolve empty, pending jobs fail. */
  dispose(): void {
    this.queue.length = 0
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.resolve(null)
    }
    for (const [id, entry] of [...this.pending]) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.resolve({ ok: false, error: 'the bridge closed before the extension answered' })
    }
  }
}
