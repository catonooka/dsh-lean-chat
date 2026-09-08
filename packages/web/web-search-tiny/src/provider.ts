/**
 * The tiny metasearch provider: a keyless SearXNG-style aggregator behind the
 * `ctx.web` search seam. One DuckDuckGo HTML query fans out beside one
 * Wikipedia API query; results merge, deduplicate by URL, and cap at
 * `maxResults`. No API key, no per-search model call, and graceful
 * degradation when one engine fails.
 * @module @deepseek-ai/dsh-web-search-tiny/provider
 */

import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult, type WebSearchSource } from '@deepseek-ai/dsh-web'
import { parseDuckDuckGoHtml, wikipediaHitToSource, type WikipediaSearchHit } from './engines.ts'

/** Stable provider id, registered with `ctx.web.registerSearchProvider`. */
export const TINY_PROVIDER_ID = 'tiny-metasearch'

/** DuckDuckGo's keyless HTML results endpoint. */
const DUCK_DUCK_GO_URL = 'https://html.duckduckgo.com/html/'

/** Wikipedia's keyless search API endpoint. */
const WIKIPEDIA_URL = 'https://en.wikipedia.org/w/api.php'

/** Browser-like user agent for the HTML endpoint; a descriptive one for the API. */
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const API_USER_AGENT = 'dsh-tiny-metasearch/0.1 (https://github.com/catonooka/deepseek-harness)'

/** How many results to ask each engine for before merging. */
const PER_ENGINE_LIMIT = 8

/** Resolved provider configuration. */
export interface TinyMetasearchOptions {
  /** Per-engine wall-clock budget in milliseconds. */
  timeoutMs: number
  /** Query the Wikipedia engine alongside DuckDuckGo. */
  wikipedia: boolean
}

/** Query DuckDuckGo's HTML endpoint and parse its result blocks. */
async function searchDuckDuckGo(query: string, signal: AbortSignal, timeoutMs: number): Promise<WebSearchSource[]> {
  const response = await fetch(DUCK_DUCK_GO_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': BROWSER_USER_AGENT,
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  })
  if (!response.ok) {
    throw new WebError(`duckduckgo html endpoint returned ${String(response.status)}`, 'WEB_PROVIDER_ERROR')
  }
  const parsed = parseDuckDuckGoHtml(await response.text())
  return parsed.links.map((link, index) => ({
    url: link.url,
    title: link.title,
    ...parsed.snippets[index] !== undefined && parsed.snippets[index] !== '' ? { snippet: parsed.snippets[index] } : {},
  }))
}

/** Query Wikipedia's search API and map its hits. */
async function searchWikipedia(query: string, signal: AbortSignal, timeoutMs: number): Promise<WebSearchSource[]> {
  const url = new URL(WIKIPEDIA_URL)
  url.searchParams.set('action', 'query')
  url.searchParams.set('list', 'search')
  url.searchParams.set('srsearch', query)
  url.searchParams.set('srlimit', String(PER_ENGINE_LIMIT))
  url.searchParams.set('format', 'json')
  const response = await fetch(url, {
    headers: { 'user-agent': API_USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  })
  if (!response.ok) {
    throw new WebError(`wikipedia api returned ${String(response.status)}`, 'WEB_PROVIDER_ERROR')
  }
  const body = await response.json() as { query?: { search?: WikipediaSearchHit[] } }
  const hits = body.query?.search ?? []
  return hits
    .map(hit => wikipediaHitToSource(hit))
    .filter((source): source is WebSearchSource => source !== undefined)
}

/** Normalize a URL for deduplication: drop the trailing slash only. */
function normalizeUrl(url: string): string {
  return url.endsWith('/') && !url.endsWith('://') ? url.slice(0, -1) : url
}

/** Merged-engine outcome: the capped source list and whether the cap dropped anything. */
export interface MergedResults {
  readonly sources: WebSearchSource[]
  readonly truncated: boolean
}

/**
 * Merge engine results: DuckDuckGo order first, Wikipedia appended, deduped
 * by normalized URL, capped at `maxResults`. Returns the merged list and
 * whether the cap dropped anything.
 */
export function mergeResults(
  primary: readonly WebSearchSource[],
  secondary: readonly WebSearchSource[],
  maxResults: number,
): MergedResults {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const source of [...primary, ...secondary]) {
    const key = normalizeUrl(source.url)
    if (seen.has(key)) continue
    seen.add(key)
    if (sources.length === maxResults) return { sources, truncated: true }
    sources.push(source)
  }
  return { sources, truncated: false }
}

/**
 * The keyless metasearch provider. `available()` is always true — the engines
 * need no configuration, and engine-level failures degrade into fewer results
 * (or one structured `WEB_PROVIDER_ERROR` when every engine failed).
 */
export class TinyMetasearchProvider implements WebSearchProvider {
  readonly id = TINY_PROVIDER_ID

  constructor(private readonly options: TinyMetasearchOptions) {}

  available(): boolean {
    return true
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const cancelled = signal ?? new AbortController().signal
    const engines: { name: string; run: () => Promise<WebSearchSource[]> }[] = [
      { name: 'duckduckgo', run: () => searchDuckDuckGo(request.query, cancelled, this.options.timeoutMs) },
    ]
    if (this.options.wikipedia) {
      engines.push({ name: 'wikipedia', run: () => searchWikipedia(request.query, cancelled, this.options.timeoutMs) })
    }
    const settled = await Promise.allSettled(engines.map(engine => engine.run()))
    const primary: WebSearchSource[] = []
    const secondary: WebSearchSource[] = []
    const failures: string[] = []
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        (index === 0 ? primary : secondary).push(...outcome.value)
      } else {
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        failures.push(`${engines[index]?.name ?? 'engine'}: ${reason}`)
      }
    })
    if (primary.length === 0 && secondary.length === 0) {
      throw new WebError(
        `tiny metasearch produced no results (${failures.join('; ')})`,
        'WEB_PROVIDER_ERROR',
      )
    }
    const merged = mergeResults(primary, secondary, request.maxResults ?? PER_ENGINE_LIMIT)
    return { sources: merged.sources, truncated: merged.truncated }
  }
}
