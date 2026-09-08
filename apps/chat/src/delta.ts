/**
 * Delta batching for streaming replies: tokens accumulate in a buffer and
 * land in React state on a coarse timer, so the tree and the markdown parser
 * run at frame cadence instead of once per SSE chunk.
 */

/** Buffers text deltas and flushes them in coarse batches. */
export class DeltaBatcher {
  private buffer = ''
  private timer: ReturnType<typeof setInterval> | undefined

  /**
   * @param flush - where buffered text lands (React state, typically).
   * @param intervalMs - flush cadence while text is buffered.
   */
  constructor(
    private readonly flush: (text: string) => void,
    private readonly intervalMs: number = 50,
  ) {}

  /** Buffer one delta; the timer starts with the first buffered text. */
  push(text: string): void {
    this.buffer += text
    if (this.timer === undefined) {
      this.timer = setInterval(() => { this.tick() }, this.intervalMs)
    }
  }

  /** Land everything now — used when ordering must be preserved. */
  flushNow(): void {
    this.tick()
  }

  /** Land anything left and stop the timer; the batcher is done. */
  dispose(): void {
    this.tick()
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private tick(): void {
    if (this.buffer === '') return
    const text = this.buffer
    this.buffer = ''
    this.flush(text)
  }
}
