/**
 * Unit coverage for the tiny metasearch: DuckDuckGo HTML parsing, redirect
 * unwrapping, entity decoding, Wikipedia mapping, and merge/dedup.
 */

import { describe, expect, it } from 'vitest'
import {
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
