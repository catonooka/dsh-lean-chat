/**
 * Unit coverage for delta batching: buffering, cadence, manual flush, and
 * disposal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeltaBatcher } from '../src/delta.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('DeltaBatcher', () => {
  it('buffers pushes and lands them on the cadence, then stops the timer', async () => {
    vi.useFakeTimers()
    const landed: string[] = []
    const batcher = new DeltaBatcher((text) => { landed.push(text) }, 50)
    batcher.push('he')
    batcher.push('ll')
    batcher.push('o')
    expect(landed).toEqual([])
    vi.advanceTimersByTime(50)
    expect(landed).toEqual(['hello'])
    vi.advanceTimersByTime(200)
    expect(landed).toEqual(['hello']) // nothing new: no stray flushes
    batcher.dispose()
  })

  it('flushNow lands buffered text out of band, without breaking later pushes', async () => {
    vi.useFakeTimers()
    const landed: string[] = []
    const batcher = new DeltaBatcher((text) => { landed.push(text) }, 50)
    batcher.push('a')
    batcher.flushNow()
    expect(landed).toEqual(['a'])
    batcher.push('b')
    vi.advanceTimersByTime(50)
    expect(landed).toEqual(['a', 'b'])
    batcher.dispose()
  })

  it('dispose lands the remainder and stops cadence for good', async () => {
    vi.useFakeTimers()
    const landed: string[] = []
    const batcher = new DeltaBatcher((text) => { landed.push(text) }, 50)
    batcher.push('tail')
    batcher.dispose()
    expect(landed).toEqual(['tail'])
    vi.advanceTimersByTime(500)
    expect(landed).toEqual(['tail'])
  })

  it('a no-op flush on an empty buffer emits nothing', () => {
    const landed: string[] = []
    const batcher = new DeltaBatcher((text) => { landed.push(text) }, 50)
    batcher.flushNow()
    batcher.dispose()
    expect(landed).toEqual([])
  })
})
