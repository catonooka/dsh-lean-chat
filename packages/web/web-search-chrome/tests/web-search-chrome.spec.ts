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

describe('routeSearchTarget — corners', () => {
  it('accepts an uppercase X: prefix', () => {
    const route = routeSearchTarget('X: from:me dsh')
    expect(route.kind).toBe('x')
    expect(route.query).toBe('from:me dsh')
  })

  it('does not treat xx: or x_ as the X prefix', () => {
    expect(routeSearchTarget('xx: from:me').kind).toBe('web')
    expect(routeSearchTarget('x_ something').kind).toBe('web')
  })

  it('strips repeated site markers and collapses the leftovers', () => {
    const route = routeSearchTarget('site:x.com từ site:twitter.com giá vàng')
    expect(route.kind).toBe('x')
    expect(route.query).toBe('từ giá vàng')
  })

  it('encodes reserved characters in every engine URL', () => {
    const query = 'a&b=c #1'
    for (const engine of ['google', 'bing', 'duckduckgo'] as const) {
      const route = routeSearchTarget(query, engine)
      expect(route.kind).toBe('web')
      expect(route.url).toBe(`https://${engine === 'google' ? 'www.google.com/search' : engine === 'bing' ? 'www.bing.com/search' : 'duckduckgo.com/'}?q=${encodeURIComponent(query)}`)
    }
    expect(routeSearchTarget('x:a b&c').url).toBe(`https://x.com/search?q=${encodeURIComponent('a b&c')}&f=live`)
  })
})

describe('toSources — corners', () => {
  it('returns nothing for a zero budget', () => {
    expect(toSources([{ title: 'a', url: 'https://a' }], 0)).toEqual([])
  })

  it('drops whitespace-only titles and urls', () => {
    expect(toSources([
      { title: '   ', url: 'https://a' },
      { title: 'a', url: '   ' },
      { title: 'a', url: 'https://a' },
    ], 5)).toEqual([{ title: 'a', url: 'https://a' }])
  })

  it('caps before pushing, not after', () => {
    const sources = toSources([
      { title: 'a', url: 'https://a' },
      { title: 'b', url: 'https://b' },
    ], 1)
    expect(sources).toEqual([{ title: 'a', url: 'https://a' }])
  })

  it('keeps urls distinct when they differ only past the origin', () => {
    const sources = toSources([
      { title: 'a', url: 'https://x/1' },
      { title: 'b', url: 'https://x/2' },
    ], 5)
    expect(sources).toHaveLength(2)
  })
})
