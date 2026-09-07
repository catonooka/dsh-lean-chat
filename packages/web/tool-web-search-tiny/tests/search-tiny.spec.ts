/**
 * Unit coverage for the pure parts of the tiny search tool: generated-question
 * sanitization, result formatting, and the plugin's default config surface.
 */

import { describe, expect, it } from 'vitest'
import {
  Config,
  EXTERNAL_WEB_CONTENT_NOTICE,
  formatSearchOutput,
  sanitizeGeneratedQuestion,
  type WebSearchTinyValue,
} from '../src/index.ts'

function value(overrides: Partial<WebSearchTinyValue> = {}): WebSearchTinyValue {
  return {
    query: 'latest version?',
    searchQuestion: 'DeepSeek Harness latest release version',
    searchedAt: '2026-09-08T12:00:00.000Z',
    sources: [
      {
        url: 'https://example.com/a',
        title: 'Example A',
        snippet: 'First result',
        publishedAt: '2026-09-01',
      },
      { url: 'https://example.com/b' },
    ],
    truncated: false,
    ...overrides,
  }
}

describe('sanitizeGeneratedQuestion', () => {
  it('keeps a clean generated question', () => {
    expect(sanitizeGeneratedQuestion('DeepSeek chat latest model', 'raw')).toBe('DeepSeek chat latest model')
  })

  it('strips symmetric wrapping quotes', () => {
    expect(sanitizeGeneratedQuestion('"deepseek api pricing"  ', 'raw')).toBe('deepseek api pricing')
  })

  it('collapses whitespace runs and keeps the first line', () => {
    expect(sanitizeGeneratedQuestion('  a   b\nc d ', 'raw')).toBe('a b')
  })

  it('falls back to the raw query on empty output', () => {
    expect(sanitizeGeneratedQuestion('   ', 'raw query')).toBe('raw query')
  })

  it('falls back to the raw query when over the length cap', () => {
    expect(sanitizeGeneratedQuestion('x'.repeat(201), 'raw')).toBe('raw')
  })
})

describe('formatSearchOutput', () => {
  it('renders notice, question, timestamped sources, and citation instruction', () => {
    const text = formatSearchOutput(value())
    expect(text.startsWith(EXTERNAL_WEB_CONTENT_NOTICE)).toBe(true)
    expect(text).toContain('Search question: DeepSeek Harness latest release version')
    expect(text).toContain('- [Example A](https://example.com/a) — First result (published 2026-09-01)')
    expect(text).toContain('- [example.com](https://example.com/b)')
    expect(text).toContain('Searched at 2026-09-08T12:00:00.000Z.')
    expect(text).toContain('Cite the relevant URLs above as markdown links')
  })

  it('reports empty results without a source list', () => {
    const text = formatSearchOutput(value({ sources: [] }))
    expect(text).toContain('No results found.')
    expect(text).not.toContain('Sources:')
  })

  it('notes truncation', () => {
    const text = formatSearchOutput(value({ truncated: true }))
    expect(text).toContain('(Showing the first 2 sources. Refine the query for more.)')
  })
})

describe('Config', () => {
  it('applies the documented defaults', () => {
    expect(Config({})).toEqual({
      maxResults: 5,
      generateQuestion: true,
      generatorModel: 'deepseek-chat',
      generatorProvider: 'deepseek-official',
      timeoutMs: 45_000,
    })
  })
})
