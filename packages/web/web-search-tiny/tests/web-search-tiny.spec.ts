/**
 * Unit coverage for the tiny metasearch: DuckDuckGo HTML parsing, redirect
 * unwrapping, entity decoding, Wikipedia mapping, and merge/dedup.
 */

import { describe, expect, it } from 'vitest'
import {
  TinyMetasearchProvider,
  decodeEntities,
  htmlToText,
  mergeResults,
  parseDuckDuckGoHtml,
  unwrapDuckDuckGoHref,
  wikipediaHitToSource,
} from '../src/index.ts'

const DDG_FIXTURE = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fabout%2Freleases&amp;rut=abc">Node.js &amp; Releases</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fabout%2Freleases">Node.js &#39;release&#39; schedule &mdash; LTS lines for <b>30 months</b>.</a>
</div>
<div class="result result--ad">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/y.js?ad_provider=foo&amp;u3=...">Sponsored result</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://example.com/second-page">Second &lt;page&gt;</a>
  </h2>
  <a class="result__snippet" href="https://example.com/second-page">The second snippet.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="javascript:alert(1)">Bad scheme</a>
  </h2>
</div>
`

describe('parseDuckDuckGoHtml', () => {
  it('extracts links in order, unwraps uddg redirects, decodes entities', () => {
    const parsed = parseDuckDuckGoHtml(DDG_FIXTURE)
    expect(parsed.links).toEqual([
      { url: 'https://nodejs.org/en/about/releases', title: 'Node.js & Releases' },
      { url: 'https://example.com/second-page', title: 'Second <page>' },
    ])
  })

  it('extracts snippets in order with tags stripped', () => {
    const parsed = parseDuckDuckGoHtml(DDG_FIXTURE)
    expect(parsed.snippets[0]).toBe("Node.js 'release' schedule — LTS lines for 30 months.")
    expect(parsed.snippets[1]).toBe('The second snippet.')
  })

  it('drops ad rows and non-http hrefs', () => {
    const parsed = parseDuckDuckGoHtml(DDG_FIXTURE)
    expect(parsed.links.some(link => link.title === 'Sponsored result')).toBe(false)
    expect(parsed.links.some(link => link.url.startsWith('javascript:'))).toBe(false)
  })
})

describe('unwrapDuckDuckGoHref', () => {
  it('unwraps a uddg redirect to its percent-encoded target', () => {
    expect(unwrapDuckDuckGoHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fq%3D1&rut=x'))
      .toBe('https://example.com/a?q=1')
  })

  it('passes plain http(s) hrefs through', () => {
    expect(unwrapDuckDuckGoHref('https://example.com/page')).toBe('https://example.com/page')
  })

  it('rejects internal duckduckgo links and non-http schemes', () => {
    expect(unwrapDuckDuckGoHref('https://duckduckgo.com/settings')).toBeUndefined()
    expect(unwrapDuckDuckGoHref('javascript:alert(1)')).toBeUndefined()
    expect(unwrapDuckDuckGoHref('//duckduckgo.com/l/?rut=no-target')).toBeUndefined()
  })
})

describe('decodeEntities / htmlToText', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a&amp;b &#39;c&#x27;d&lt;e&quot;')).toBe("a&b 'c'd<e\"")
  })

  it('strips tags and collapses whitespace', () => {
    expect(htmlToText('The <b>second</b>\n  snippet.')).toBe('The second snippet.')
  })
})

describe('wikipediaHitToSource', () => {
  it('maps a hit to a wiki URL with a stripped snippet and timestamp', () => {
    expect(wikipediaHitToSource({
      title: 'Canberra',
      snippet: '<span class="searchmatch">Canberra</span> is the capital of Australia',
      timestamp: '2026-09-01T12:00:00Z',
    })).toEqual({
      url: 'https://en.wikipedia.org/wiki/Canberra',
      title: 'Canberra',
      snippet: 'Canberra is the capital of Australia',
      publishedAt: '2026-09-01T12:00:00Z',
    })
  })

  it('rejects malformed hits', () => {
    expect(wikipediaHitToSource({ snippet: 'no title' })).toBeUndefined()
    expect(wikipediaHitToSource({ title: '' })).toBeUndefined()
  })
})

describe('mergeResults', () => {
  const a = { url: 'https://a.com/', title: 'A' }
  const aAgain = { url: 'https://a.com', title: 'A duplicate' }
  const b = { url: 'https://b.com/x', title: 'B' }
  const c = { url: 'https://c.com', title: 'C' }

  it('keeps primary order, appends secondary, dedupes by normalized URL', () => {
    const merged = mergeResults([a, b], [aAgain, c], 10)
    expect(merged.sources.map(source => source.title)).toEqual(['A', 'B', 'C'])
    expect(merged.truncated).toBe(false)
  })

  it('caps at maxResults and flags truncation', () => {
    const merged = mergeResults([a, b], [c], 2)
    expect(merged.sources.map(source => source.title)).toEqual(['A', 'B'])
    expect(merged.truncated).toBe(true)
  })
})

describe('decodeEntities — corners', () => {
  it('substitutes U+FFFD for out-of-range numeric entities instead of throwing', () => {
    expect(decodeEntities('&#x110000;')).toBe('�')
    expect(decodeEntities('&#1114112;')).toBe('�')
    expect(() => decodeEntities('&#x10FFFF;')).not.toThrow()
    expect(decodeEntities('&#x10FFFF;')).toBe(String.fromCodePoint(0x10ffff))
  })
})

describe('htmlToText — corners', () => {
  it('collapses nested tags, newlines, and entities in one pass', () => {
    expect(htmlToText('<b>a<i>b</i></b>\n  c &amp; d')).toBe('ab c & d')
    expect(htmlToText('&#x1F600; smile')).toBe('😀 smile')
  })
})

describe('parseDuckDuckGoHtml — attribute-order corners', () => {
  it('parses anchors whether href precedes or follows class', () => {
    const html = [
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2F">A</a>',
      '<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.example%2F" class="result__a">B</a>',
      '<a rel="nofollow" data-x="1" class="result__a" href="https://c.example/">C</a>',
    ].join('')
    expect(parseDuckDuckGoHtml(html).links).toEqual([
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://b.example/', title: 'B' },
      { url: 'https://c.example/', title: 'C' },
    ])
  })

  it('drops anchors whose title strips to nothing and hrefs that unwrap to nothing', () => {
    const html = [
      '<a class="result__a" href="https://keep.example/">real</a>',
      '<a class="result__a" href="https://empty.example/"><span></span></a>',
      '<a class="result__a" href="//duckduckgo.com/l/?rut=abc">no uddg</a>',
    ].join('')
    expect(parseDuckDuckGoHtml(html).links).toEqual([{ url: 'https://keep.example/', title: 'real' }])
  })

  it('pairs snippets by index and ignores unterminated snippet markup', () => {
    const html = '<div class="result__snippet">one</div><span class="result__snippet">two</span>'
      + '<td class="result__snippet">never closed'
    expect(parseDuckDuckGoHtml(html).snippets).toEqual(['one', 'two'])
  })
})

describe('unwrapDuckDuckGoHref — corners', () => {
  it('rejects uddg targets that are not absolute http(s) URLs', () => {
    expect(unwrapDuckDuckGoHref('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)')).toBeUndefined()
    expect(unwrapDuckDuckGoHref('//duckduckgo.com/l/?uddg=%2Frelative%2Fpath')).toBeUndefined()
    expect(unwrapDuckDuckGoHref('//duckduckgo.com/l/?rut=x')).toBeUndefined()
  })

  it('accepts uppercase schemes and keeps the query string verbatim', () => {
    expect(unwrapDuckDuckGoHref('HTTPS://EXAMPLE.COM/P?Q=1&R=2')).toBe('https://example.com/P?Q=1&R=2')
  })
})

describe('wikipediaHitToSource — corners', () => {
  it('encodes titles with underscores and strips markup from snippets', () => {
    const source = wikipediaHitToSource({ title: 'Ho Chi Minh City', snippet: 'largest <b>city</b> &amp; hub', timestamp: '2026-01-02T03:04:05Z' })
    expect(source?.url).toBe('https://en.wikipedia.org/wiki/Ho_Chi_Minh_City')
    expect(source?.snippet).toBe('largest city & hub')
    expect(source?.publishedAt).toBe('2026-01-02T03:04:05Z')
  })

  it('omits non-string snippet and timestamp instead of failing', () => {
    expect(wikipediaHitToSource({ title: 'X', snippet: 7, timestamp: null })).toEqual({ url: 'https://en.wikipedia.org/wiki/X', title: 'X' })
  })
})

describe('mergeResults — corners', () => {
  it('dedupes trailing-slash variants but never slices bare origins', () => {
    const merged = mergeResults(
      [{ url: 'https://a.example' }, { url: 'https://b.example/' }],
      [{ url: 'https://a.example/' }],
      5,
    )
    expect(merged.sources.map(source => source.url)).toEqual(['https://a.example', 'https://b.example/'])
    expect(merged.truncated).toBe(false)
  })

  it('flags truncation exactly when the cap drops a result', () => {
    expect(mergeResults([{ url: 'https://a' }, { url: 'https://b' }], [], 2).truncated).toBe(false)
    expect(mergeResults([{ url: 'https://a' }, { url: 'https://b' }], [], 1).truncated).toBe(true)
    expect(mergeResults([{ url: 'https://a' }], [], 0).sources).toEqual([])
  })
})

describe('TinyMetasearchProvider result cache', () => {
  const serp = (marker: string): string => `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a class="result__a" href="https://example.com/${marker}">${marker}</a></h2>
  <a class="result__snippet" href="https://example.com/${marker}">snippet ${marker}</a>
</div>
`

  it('serves a repeat query from cache without refetching the engines', async () => {
    const fetched: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      fetched.push(url)
      if (url.includes('duckduckgo')) {
        return new Response(serp('cached-page'), { status: 200 })
      }
      return new Response(JSON.stringify({ query: { search: [] } }), { status: 200 })
    }) as typeof fetch
    try {
      const provider = new TinyMetasearchProvider({ timeoutMs: 1000, wikipedia: false })
      const first = await provider.search({ query: 'cache me', maxResults: 5 })
      const second = await provider.search({ query: 'cache me', maxResults: 5 })
      expect(first.sources.map(source => source.title)).toEqual(['cached-page'])
      expect(second).toBe(first)
      expect(fetched.filter(url => url.includes('duckduckgo'))).toHaveLength(1)
      // A different query is a different cache entry.
      await provider.search({ query: 'different', maxResults: 5 })
      expect(fetched.filter(url => url.includes('duckduckgo'))).toHaveLength(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keys the cache on the result budget too', async () => {
    const fetched: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      fetched.push(url)
      if (url.includes('duckduckgo')) return new Response(serp('budget-page'), { status: 200 })
      return new Response(JSON.stringify({ query: { search: [] } }), { status: 200 })
    }) as typeof fetch
    try {
      const provider = new TinyMetasearchProvider({ timeoutMs: 1000, wikipedia: false })
      await provider.search({ query: 'same words', maxResults: 5 })
      await provider.search({ query: 'same words', maxResults: 8 })
      expect(fetched.filter(url => url.includes('duckduckgo'))).toHaveLength(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
