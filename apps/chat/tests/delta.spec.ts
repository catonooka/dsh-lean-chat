/**
 * Unit coverage for the streaming feed: buffering, cadence, manual and full
 * flushes, turn reset, and subscriber fan-out.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { StreamFeed } from '../src/delta.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('StreamFeed', () => {
  it('buffers pushes and lands them on the cadence, then stops the timer', async () => {
    vi.useFakeTimers()
    const heard: string[] = []
    const feed = new StreamFeed(50)
    feed.subscribe((text) => { heard.push(text) })
    feed.push('he')
    feed.push('ll')
    feed.push('o')
    expect(heard).toEqual([])
    vi.advanceTimersByTime(50)
    expect(heard).toEqual(['hello'])
    vi.advanceTimersByTime(200)
    expect(heard).toEqual(['hello']) // nothing new: no stray flushes
    feed.reset()
  })

  it('flushNow lands buffered text out of band, without breaking later pushes', async () => {
    vi.useFakeTimers()
    const heard: string[] = []
    const feed = new StreamFeed(50)
    feed.subscribe((text) => { heard.push(text) })
    feed.push('a')
    feed.flushNow()
    expect(heard).toEqual(['a'])
    feed.push('b')
    vi.advanceTimersByTime(50)
    expect(heard).toEqual(['a', 'ab'])
    feed.reset()
  })

  it('setFull replaces the accumulated text and drops the buffer', async () => {
    vi.useFakeTimers()
    const heard: string[] = []
    const feed = new StreamFeed(50)
    feed.subscribe((text) => { heard.push(text) })
    feed.push('partial draf')
    feed.setFull('the committed message')
    expect(feed.text).toBe('the committed message')
    vi.advanceTimersByTime(200)
    expect(heard).toEqual(['the committed message'])
    feed.reset()
  })

  it('reset lands the remainder, stops cadence for good, and returns the final text', async () => {
    vi.useFakeTimers()
    const heard: string[] = []
    const feed = new StreamFeed(50)
    feed.subscribe((text) => { heard.push(text) })
    feed.push('tail')
    const final = feed.reset()
    expect(final).toBe('tail')
    expect(heard).toEqual(['tail', '']) // the reset also announces the clear
    feed.push('next')
    vi.advanceTimersByTime(500)
    expect(heard).toEqual(['tail', '', 'next'])
    feed.reset()
  })

  it('a flush with an empty buffer emits nothing but the reset still clears', () => {
    const heard: string[] = []
    const feed = new StreamFeed(50)
    feed.subscribe((text) => { heard.push(text) })
    feed.flushNow()
    feed.reset()
    expect(heard).toEqual([''])
  })

  it('unsubscribed listeners stop hearing flushes', async () => {
    vi.useFakeTimers()
    const heard: string[] = []
    const feed = new StreamFeed(50)
    const unsubscribe = feed.subscribe((text) => { heard.push(text) })
    feed.push('first')
    vi.advanceTimersByTime(50)
    unsubscribe()
    feed.push('second')
    vi.advanceTimersByTime(100)
    expect(heard).toEqual(['first'])
    feed.reset()
  })
})
