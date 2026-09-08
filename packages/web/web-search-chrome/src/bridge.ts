/**
 * The local bridge between the chat app and the companion Chrome extension:
 * the app enqueues search jobs, the extension's service worker long-polls
 * `/api/chrome/next`, runs the search with this browser's own cookies, and
 * posts the result back — no debug port, no visible tab.
 * @module @deepseek-ai/dsh-web-search-chrome/bridge
 */

import { coerceRawHits, type RawHit, type WebEngine } from './provider.ts'

/** One search handed to the extension. */
export interface ExtensionJob {
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
}

/** What the extension posts back for one job. */
export type ExtensionSettlement = { ok: true; sources: RawHit[] } | { ok: false; error: string }

/** A pending job awaiting its settlement, with its give-up timer. */
interface PendingSlot {
  resolve: (settlement: ExtensionSettlement) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The in-process job queue shared by the app's routes and its search
 * dispatch: `nextJob` serves the extension's long-polls, `enqueue` holds a
 * search until the extension settles it or the timeout lapses, and every
 * request from the extension refreshes the heartbeat that `seenWithin`
 * answers from.
 */
export class ExtensionBridge {
  private nextJobId = 1
  private lastSeenAt = 0
  private readonly queue: ExtensionJob[] = []
  private readonly pending = new Map<string, PendingSlot>()
  private readonly waiters: { resolve: (job: ExtensionJob | null) => void; timer: ReturnType<typeof setTimeout> }[] = []

  /** Record that the extension just made a bridge request. */
  markSeen(now: number = Date.now()): void {
    this.lastSeenAt = now
  }

  /** Whether the extension made a request within the heartbeat window. */
  seenWithin(ttlMs: number, now: number = Date.now()): boolean {
    return this.lastSeenAt > 0 && now - this.lastSeenAt <= ttlMs
  }

  /**
   * Long-poll the next job: resolves immediately when one is queued, else
   * `null` once `waitMs` passes. The extension re-polls right away either
   * way, so the request stream doubles as its heartbeat.
   */
  nextJob(waitMs: number): Promise<ExtensionJob | null> {
    const head = this.queue.shift()
    if (head !== undefined) return Promise.resolve(head)
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index !== -1) this.waiters.splice(index, 1)
          resolve(null)
        }, waitMs),
      }
      this.waiters.push(waiter)
    })
  }

  /**
   * Queue one job and wait for its settlement.
   * @param job - the search to hand over (without an id).
   * @param timeoutMs - how long the extension may take before the promise
   *   settles with a failure.
   * @returns the extension's settlement, or a timeout failure.
   */
  enqueue(job: Omit<ExtensionJob, 'id'>, timeoutMs: number): Promise<ExtensionSettlement> {
    const full: ExtensionJob = { id: String(this.nextJobId++), ...job }
    return new Promise((resolve) => {
      const entry: PendingSlot = {
        resolve,
        timer: setTimeout(() => {
          this.pending.delete(full.id)
          resolve({ ok: false, error: `the extension did not answer within ${String(timeoutMs)}ms` })
        }, timeoutMs),
      }
      this.pending.set(full.id, entry)
      const waiter = this.waiters.shift()
      if (waiter !== undefined) {
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
   *   malformed payloads, and jobs that already timed out.
   */
  settle(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
    const payload = raw as { id?: unknown; ok?: unknown; sources?: unknown; error?: unknown }
    if (typeof payload.id !== 'string') return false
    const entry = this.pending.get(payload.id)
    if (entry === undefined) return false
    this.pending.delete(payload.id)
    clearTimeout(entry.timer)
    if (payload.ok === true) {
      entry.resolve({ ok: true, sources: coerceRawHits(payload.sources) })
    } else {
      entry.resolve({
        ok: false,
        error: typeof payload.error === 'string' && payload.error !== ''
          ? payload.error
          : 'the extension reported an unknown failure',
      })
    }
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
