/**
 * Unit coverage for the user-Chrome provider's pure routing and mapping.
 */

import { describe, expect, it } from 'vitest'
import { routeSearchTarget, toSources, CHROME_PROVIDER_ID } from '../src/provider.ts'

describe('routeSearchTarget', () => {
  it('routes an x: prefix to logged-in X search with operators intact', () => {
    expect(routeSearchTarget('x: from:me dsh chat')).toEqual({
      kind: 'x',
      query: 'from:me dsh chat',
      url: `https://x.com/search?q=${encodeURIComponent('from:me dsh chat')}&f=live`,
    })
  })

  it('routes site:x.com and site:twitter.com markers to X, stripping the marker', () => {
    expect(routeSearchTarget('giá vàng site:x.com').kind).toBe('x')
    expect(routeSearchTarget('giá vàng site:x.com').query).toBe('giá vàng')
    expect(routeSearchTarget('news site:twitter.com').kind).toBe('x')
    expect(routeSearchTarget('news site:twitter.com').query).toBe('news')
  })

  it('searches Google for everything else, encoding the query', () => {
    const route = routeSearchTarget('giá cà phê hôm nay')
    expect(route.kind).toBe('web')
    expect(route.url).toBe(`https://www.google.com/search?q=${encodeURIComponent('giá cà phê hôm nay')}`)
  })

  it('falls back to Google when the X marker carries nothing else', () => {
    expect(routeSearchTarget('x:').kind).toBe('web')
    expect(routeSearchTarget('site:x.com').kind).toBe('web')
  })
})

describe('toSources', () => {
  it('drops empty hits, deduplicates by URL, and caps at the budget', () => {
    const sources = toSources([
      { title: 'a', url: 'https://a' },
      { title: '', url: 'https://empty-title' },
      { title: 'b', url: '' },
      { title: 'a again', url: 'https://a' },
      { title: 'b', url: 'https://b', snippet: 'second' },
      { title: 'c', url: 'https://c' },
    ], 2)
    expect(sources).toEqual([
      { title: 'a', url: 'https://a' },
      { title: 'b', url: 'https://b', snippet: 'second' },
    ])
  })

  it('keeps optional snippet and publishedAt only when present', () => {
    expect(toSources([{ title: 't', url: 'https://x/1', snippet: '', publishedAt: '' }], 5))
      .toEqual([{ title: 't', url: 'https://x/1' }])
    expect(toSources([{ title: 't', url: 'https://x/1', publishedAt: '2026-09-08' }], 5)[0]?.publishedAt)
      .toBe('2026-09-08')
  })
})

describe('provider id', () => {
  it('registers under a stable id', () => {
    expect(CHROME_PROVIDER_ID).toBe('user-chrome')
  })
})
