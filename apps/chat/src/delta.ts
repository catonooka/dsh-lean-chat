/**
 * Delta batching for streaming replies: tokens accumulate in a buffer and
 * land on a coarse timer, so subscribers run at frame cadence instead of
 * once per SSE chunk. The feed owns the accumulated text outside React
 * state — only subscribed streaming components re-render per batch, never
 * the whole app tree.
 */

/** Buffers text deltas and flushes them in coarse batches to subscribers. */
export class StreamFeed {
  private buffered = ''
  private landed = ''
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly listeners = new Set<(text: string) => void>()

  /**
   * @param intervalMs - flush cadence while text is buffered.
   */
  constructor(private readonly intervalMs: number = 50) {}

  /** The text landed so far this turn (the buffer is not included). */
  get text(): string {
    return this.landed
  }

  /**
   * Subscribe to landed text; the listener receives the full accumulated
   * text after each flush. Unsubscribe with the returned function.
   */
  subscribe(listener: (text: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Buffer one delta; the timer starts with the first buffered text. */
  push(text: string): void {
    this.buffered += text
    if (this.timer === undefined) {
      this.timer = setInterval(() => { this.tick() }, this.intervalMs)
    }
  }

  /** Land everything now — used when ordering must be preserved. */
  flushNow(): void {
    this.tick()
  }

  /**
   * Replace the accumulated text outright (a committed assistant frame
   * supersedes the deltas that previewed it).
   */
  setFull(text: string): void {
    this.buffered = ''
    this.landed = text
    this.emit()
  }

  /** Land anything left, stop the timer, and reset for the next turn.
   * @returns the final accumulated text. */
  reset(): string {
    this.tick()
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    const final = this.landed
    this.landed = ''
    this.emit()
    return final
  }

  private tick(): void {
    if (this.buffered === '') return
    this.landed += this.buffered
    this.buffered = ''
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this.landed)
  }
}
