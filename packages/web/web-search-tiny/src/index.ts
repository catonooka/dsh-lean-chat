/**
 * Register the tiny keyless metasearch provider in `ctx.web`. A SearXNG-style
 * aggregator reduced to searching: DuckDuckGo HTML results merged with
 * Wikipedia API hits — no API key, no per-search model call.
 * @module @deepseek-ai/dsh-web-search-tiny
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { TinyMetasearchProvider, type TinyMetasearchOptions } from './provider.ts'

export { TinyMetasearchProvider, TINY_PROVIDER_ID, mergeResults } from './provider.ts'
export {
  decodeEntities,
  htmlToText,
  parseDuckDuckGoHtml,
  unwrapDuckDuckGoHref,
  wikipediaHitToSource,
} from './engines.ts'
export type { DuckDuckGoParse, WikipediaSearchHit } from './engines.ts'
export type { TinyMetasearchOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-tiny'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Default per-engine wall-clock budget in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000

/** Plugin config: per-engine budget and the Wikipedia toggle. */
export interface Config {
  /** Per-engine timeout budget (ms). */
  timeoutMs?: number
  /** Query Wikipedia alongside DuckDuckGo. */
  wikipedia?: boolean
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  wikipedia: z.boolean().default(true),
})

/**
 * Register the tiny metasearch provider with the resolved config.
 * @param ctx - context whose `web` service receives the provider.
 * @param config - validated {@link Config} with schemastery defaults applied.
 */
export function apply(ctx: Context, config: Config): void {
  const options: TinyMetasearchOptions = {
    timeoutMs: config.timeoutMs as number,
    wikipedia: config.wikipedia as boolean,
  }
  ctx.web.registerSearchProvider(new TinyMetasearchProvider(options))
}
