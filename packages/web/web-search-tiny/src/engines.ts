/**
 * Pure parsing and mapping helpers for the tiny metasearch engines. Kept free
 * of network concerns so tests can feed fixture strings straight in.
 * @module @deepseek-ai/dsh-web-search-tiny/engines
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'

/** Decode the handful of HTML entities DuckDuckGo and Wikipedia emit in text fields. */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_whole, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_whole, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&mdash;/gu, '—')
    .replace(/&ndash;/gu, '–')
    .replace(/&hellip;/gu, '…')
    .replace(/&amp;/gu, '&')
}

/** Strip tags, collapse whitespace, decode entities — one safe text cell. */
export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/gu, '')).replace(/\s+/gu, ' ').trim()
}

/**
 * Unwrap a DuckDuckGo redirect href to the real target URL. DDG result links
 * point at `//duckduckgo.com/l/?uddg=<percent-encoded target>&rut=...`; the
 * `uddg` parameter carries the destination verbatim. Non-redirect hrefs pass
 * through untouched, and anything that does not decode to an http(s) URL is
 * rejected (returns undefined) so callers can drop the result.
 * @param href - the raw href attribute value from a result anchor.
 * @returns the absolute target URL, or undefined when unusable.
 */
export function unwrapDuckDuckGoHref(href: string): string | undefined {
  let url: URL
  try {
    url = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://duckduckgo.com')
  } catch {
    return undefined
  }
  if (url.hostname === 'duckduckgo.com' && url.pathname === '/l/') {
    const target = url.searchParams.get('uddg')
    if (target === null) return undefined
    try {
      const unwrapped = new URL(target)
      if (unwrapped.protocol !== 'https:' && unwrapped.protocol !== 'http:') return undefined
      return unwrapped.toString()
    } catch {
      return undefined
    }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.hostname === 'duckduckgo.com' || url.hostname === 'duckduckgo.com.') return undefined
  return url.toString()
}

/** One parsed DuckDuckGo HTML block: link and (possibly absent) snippet text. */
export interface DuckDuckGoParse {
  readonly links: { url: string; title: string }[]
  readonly snippets: string[]
}

/**
 * Parse DuckDuckGo's html endpoint markup: anchors with class `result__a`
 * carry the target and title in document order, and `result__snippet`
 * elements carry snippet text in the same order. Ad rows (`y.js`, `ad_domain`)
 * and undecodable hrefs are dropped. Snippets pair with links by index; a
 * missing snippet is simply omitted.
 * @param html - the raw response body from `https://html.duckduckgo.com/html/`.
 * @returns the ordered links and snippets found.
 */
export function parseDuckDuckGoHtml(html: string): DuckDuckGoParse {
  const links: { url: string; title: string }[] = []
  for (const match of html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gu)) {
    const href = match[1] ?? ''
    if (/\/\/duckduckgo\.com\/y\.js/u.test(href) || /ad_domain=/u.test(href)) continue
    const url = unwrapDuckDuckGoHref(decodeEntities(href))
    if (url === undefined) continue
    const title = htmlToText(match[2] ?? '')
    if (title === '') continue
    links.push({ url, title })
  }
  const snippets: string[] = []
  for (const match of html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td|span)>/gu)) {
    snippets.push(htmlToText(match[1] ?? ''))
  }
  return { links, snippets }
}

/** Shape of `action=query&list=search` results as returned by the Wikipedia API. */
export interface WikipediaSearchHit {
  readonly title?: unknown
  readonly snippet?: unknown
  readonly timestamp?: unknown
}

/** Map one Wikipedia API hit to a source; malformed entries return undefined. */
export function wikipediaHitToSource(hit: WikipediaSearchHit): WebSearchSource | undefined {
  if (typeof hit.title !== 'string' || hit.title === '') return undefined
  const page = `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /gu, '_'))}`
  return {
    url: page,
    title: hit.title,
    ...typeof hit.snippet === 'string' ? { snippet: htmlToText(hit.snippet) } : {},
    ...typeof hit.timestamp === 'string' ? { publishedAt: hit.timestamp } : {},
  }
}
