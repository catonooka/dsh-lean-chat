/**
 * @deepseek-ai/dsh-web-search-chrome — mounts the user-Chrome search
 * provider on the web seam. Chrome must be running with
 * `--remote-debugging-port=<cdpPort>`; searches then run in the user's real
 * browser, seeing their logged-in sessions.
 * @module @deepseek-ai/dsh-web-search-chrome
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { UserChromeSearchProvider } from './provider.ts'

/** Stable Cordis plugin name. */
export const name = 'web-search-chrome'

/** The web seam must exist before the provider can register. */
export const inject = ['web']

/** Plugin config: where Chrome's DevTools endpoint listens and how long a search may take. */
export interface Config {
  /** Chrome's remote-debugging port. */
  cdpPort: number
  /** Whole-search budget, navigation included, in milliseconds. */
  timeoutMs: number
  /** Which general search engine non-X queries use inside Chrome. */
  webEngine: 'google' | 'bing' | 'duckduckgo'
}

export const Config: z<Config> = z.object({
  cdpPort: z.number().default(9222),
  timeoutMs: z.number().default(12_000),
  webEngine: z.union([z.const('google'), z.const('bing'), z.const('duckduckgo')]).default('google'),
})

/** Register the user-Chrome provider on the web seam. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new UserChromeSearchProvider({
    cdpPort: config.cdpPort,
    timeoutMs: config.timeoutMs,
    webEngine: config.webEngine,
  }))
}
