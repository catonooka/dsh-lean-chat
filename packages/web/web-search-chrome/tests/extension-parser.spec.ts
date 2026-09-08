/**
 * Unit coverage for the companion extension's pure parsing helpers. The real
 * background.js is evaluated with a stubbed chrome API (the storage callback
 * is never invoked, so the poll loop never starts), pinning the exact code
 * Chrome runs rather than a copy of it.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface ExtensionHit {
  title: string
  url: string
  snippet?: string
  publishedAt?: string
}

interface WorkerHelpers {
  parseSerp: (html: string, limit: number) => ExtensionHit[]
  unwrap: (href: string) => string
  decodeEntities: (text: string) => string
  textify: (fragment: string) => string
  parseAdaptive: (body: unknown, limit: number) => ExtensionHit[]
}

function loadWorker(): WorkerHelpers {
  const source = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '../extension/background.js'), 'utf8')
  const chrome = {
    storage: {
      local: { get: (_defaults: unknown, _callback: (stored: unknown) => void) => undefined },
      onChanged: { addListener: (_listener: unknown) => undefined },
    },
    alarms: {
      create: (_name: unknown, _info: unknown) => undefined,
      onAlarm: { addListener: (_listener: unknown) => undefined },
    },
  }
  const factory = new Function(
    'chrome',
    `${source}\nreturn { parseSerp, unwrap, decodeEntities, textify, parseAdaptive }`,
  )
  return factory(chrome) as WorkerHelpers
}

const worker = loadWorker()

describe('extension parseSerp', () => {
  it('extracts Google-shaped results (anchor wrapping the heading)', () => {
    const hits = worker.parseSerp([
      '<a href="https://a.example/x?a=1&amp;b=2"><h3>Title &amp; One</h3></a>',
      'snippet words',
      '<a href="https://google.com/intl/en"><h3>google self link</h3></a>',
      '<a href="https://b.example/page"><h3>Second</h3></a>',
      'more snippet',
    ].join('\n'), 5)
    expect(hits).toEqual([
      { title: 'Title & One', url: 'https://a.example/x?a=1&b=2', snippet: 'snippet words google self link Second more snippet' },
      { title: 'Second', url: 'https://b.example/page', snippet: 'more snippet' },
    ])
  })

  it('extracts Bing-shaped results and unwraps /ck/a redirects', () => {
    const wrapped = `a1${Buffer.from('https://real.example/target').toString('base64').replace(/\+/g, '-').replace(/\//g, '_')}`
    const hits = worker.parseSerp(
      `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=${wrapped}&ntb=1">Bing Result</a></h2><p>bing snippet</p></li>`,
      5,
    )
    expect(hits).toEqual([{ title: 'Bing Result', url: 'https://real.example/target', snippet: 'bing snippet' }])
  })

  it('extracts DuckDuckGo-shaped results and decodes hex entities', () => {
    const hits = worker.parseSerp(
      '<a data-testid="result-title-a" href="https://c.example/page"><h2>It&#x27;s a title</h2></a>ddg snippet',
      5,
    )
    expect(hits).toEqual([{ title: "It's a title", url: 'https://c.example/page', snippet: 'ddg snippet' }])
  })

  it('drops engine-self links, duplicates, and non-http targets, and caps at the limit', () => {
    const html = [
      '<a href="https://duckduckgo.com/x"><h3>DDG self</h3></a>',
      '<a href="https://www.bing.com/search"><h3>Bing self</h3></a>',
      '<a href="javascript:void(0)"><h3>JS link</h3></a>',
      '<a href="https://same.example"><h3>First</h3></a>',
      '<a href="https://same.example"><h3>Duplicate</h3></a>',
      '<a href="https://a.example"><h3>A</h3></a>',
      '<a href="https://b.example"><h3>B</h3></a>',
    ].join('')
    const hits = worker.parseSerp(html, 2)
    expect(hits.map(hit => hit.url)).toEqual(['https://same.example', 'https://a.example'])
  })

  it('skips anchors whose heading text is empty after stripping', () => {
    const hits = worker.parseSerp('<a href="https://x.example"><h3><img alt="pic"></h3></a>after', 5)
    expect(hits).toEqual([])
  })
})

describe('extension unwrap', () => {
  it('passes through non-bing and non-ck/a hrefs untouched', () => {
    expect(worker.unwrap('https://a.example/x?u=a1abc')).toBe('https://a.example/x?u=a1abc')
    expect(worker.unwrap('https://www.bing.com/search?q=x')).toBe('https://www.bing.com/search?q=x')
    expect(worker.unwrap('https://www.bing.com/ck/a?u=zz-not-a1')).toBe('https://www.bing.com/ck/a?u=zz-not-a1')
  })

  it('returns the original when the unwrapped value is not a web URL', () => {
    const garbage = `a1${'garbage!'.replace(/\+/g, '-').replace(/\//g, '_')}`
    expect(worker.unwrap(`https://www.bing.com/ck/a?u=${encodeURIComponent(garbage)}`))
      .toMatch(/^https:\/\/www\.bing\.com\/ck\/a/)
  })
})

describe('extension decodeEntities', () => {
  it('decodes the named and numeric forms the engines emit', () => {
    expect(worker.decodeEntities('&amp;&lt;&gt;&quot;&nbsp;&#39;')).toBe('&<>" \'')
    expect(worker.decodeEntities('caf&eacute;')).toBe('caf&eacute;')
    expect(worker.decodeEntities('&#x27;&#X41;')).toBe("'A")
    expect(worker.decodeEntities('&nope;')).toBe('&nope;')
    expect(worker.decodeEntities('&AMP;')).toBe('&')
  })
})

describe('extension textify', () => {
  it('drops script and style bodies, not just their tags', () => {
    expect(worker.textify('before<script>evil()</script>after')).toBe('before after')
    expect(worker.textify('a<style>x{color:red}</style>b')).toBe('a b')
  })

  it('drops a tag cut off at the window edge and spaces only block boundaries', () => {
    // textify keeps surrounding whitespace; the caller trims.
    expect(worker.textify('word <a class="tilk" href="https://www.bing.com')).toBe('word ')
    expect(worker.textify('<strong>deepseek</strong>-ai</h2><p>next block'))
      .toBe('deepseek-ai next block')
  })
})

describe('extension parseAdaptive', () => {
  const adaptive = (createdAt: string, id: string): unknown => ({
    globalObjects: {
      tweets: {
        [id]: { id_str: id, full_text: `tweet ${id}`, created_at: createdAt, user_id: 'u1' },
        late: { id_str: 'late', created_at: createdAt, user_id: 'u1' },
        bare: { full_text: 'no id', user_id: 'u1' },
        [`${id}b`]: { id_str: `${id}b`, created_at: createdAt, user_id: 'missing-user', full_text: 'anon' },
      },
      users: { u1: { screen_name: 'catonooka' } },
    },
  })

  it('maps tweets to citeable sources, newest first, with screen names and dates', () => {
    const hits = worker.parseAdaptive(adaptive('Wed Sep 08 03:14:15 +0000 2026', 't1'), 10)
    expect(hits).toEqual([
      { title: 'tweet t1', url: 'https://x.com/catonooka/status/t1', snippet: 'tweet t1', publishedAt: '2026-09-08' },
      { title: 'anon', url: 'https://x.com/i/status/t1b', snippet: 'anon', publishedAt: '2026-09-08' },
    ])
  })

  it('caps at the limit and omits unparsable dates', () => {
    const body = {
      globalObjects: {
        tweets: {
          a: { id_str: 'a', full_text: 'ta', created_at: 'not a date', user_id: 'u' },
          b: { id_str: 'b', full_text: 'tb', created_at: 'Wed Sep 08 01:00:00 +0000 2026', user_id: 'u' },
        },
        users: {},
      },
    }
    const hits = worker.parseAdaptive(body, 1)
    expect(hits).toEqual([{ title: 'tb', url: 'https://x.com/i/status/b', snippet: 'tb', publishedAt: '2026-09-08' }])
    const noDate = worker.parseAdaptive(body, 10).find(hit => hit.url.endsWith('/a'))
    expect(noDate?.publishedAt).toBeUndefined()
  })

  it('answers empty for a body without globalObjects', () => {
    expect(worker.parseAdaptive({}, 5)).toEqual([])
    expect(worker.parseAdaptive(undefined, 5)).toEqual([])
  })
})
