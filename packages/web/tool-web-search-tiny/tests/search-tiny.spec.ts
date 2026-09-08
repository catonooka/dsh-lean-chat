/**
 * Unit coverage for the pure parts of the tiny search tool: generated-question
 * sanitization, result formatting, and the plugin's default config surface.
 */

import { describe, expect, it } from 'vitest'
import {
  Config,
  EXTERNAL_WEB_CONTENT_NOTICE,
  formatSearchOutput,
  generatorSystem,
  resolveStaleYear,
  sanitizeGeneratedQuestion,
  withCurrentDate,
  type WebSearchTinyValue,
} from '../src/index.ts'

const NOW = new Date('2026-09-08T03:12:04.236Z')

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

describe('withCurrentDate', () => {
  it('stamps a full UTC date on "now" vocabulary across languages', () => {
    expect(withCurrentDate('thời tiết hôm nay tại Hà Nội', NOW)).toBe('thời tiết hôm nay tại Hà Nội 2026-09-08')
    expect(withCurrentDate('今天上海天气', NOW)).toBe('今天上海天气 2026-09-08')
    expect(withCurrentDate('tiempo hoy en Madrid', NOW)).toBe('tiempo hoy en Madrid 2026-09-08')
    expect(withCurrentDate("météo aujourd'hui à Paris", NOW)).toBe("météo aujourd'hui à Paris 2026-09-08")
  })

  it('stamps only the year on "freshness" vocabulary', () => {
    expect(withCurrentDate('latest Node.js version', NOW)).toBe('latest Node.js version 2026')
    expect(withCurrentDate('phien ban moi nhat cua Node.js', NOW)).toBe('phien ban moi nhat cua Node.js 2026')
    expect(withCurrentDate('Node.js 最新版本', NOW)).toBe('Node.js 最新版本 2026')
    expect(withCurrentDate('최신 뉴스', NOW)).toBe('최신 뉴스 2026')
  })

  it('leaves queries that already name a year or carry no time word untouched', () => {
    expect(withCurrentDate('Node.js 24 LTS features', NOW)).toBe('Node.js 24 LTS features')
    expect(withCurrentDate('best phở in District 1', NOW)).toBe('best phở in District 1')
  })
})

describe('resolveStaleYear', () => {
  it('replaces a generator-invented stale year with the current date on now-class queries', () => {
    expect(resolveStaleYear('giá vàng hôm nay 2025', 'giá vàng hôm nay', NOW)).toBe('giá vàng hôm nay 2026-09-08')
  })

  it('strips stale years baked into the raw tool-call arguments by the conversation model', () => {
    expect(resolveStaleYear('giá cà phê hôm nay 2025', 'giá cà phê hôm nay 2025', NOW)).toBe('giá cà phê hôm nay 2026-09-08')
    expect(resolveStaleYear('weather today 2025', 'weather today 2025', NOW)).toBe('weather today 2026-09-08')
  })

  it('keeps the current year on now-class queries and drops only older years on freshness-class', () => {
    expect(resolveStaleYear('giá vàng hôm nay 2026', 'giá vàng hôm nay 2026', NOW)).toBe('giá vàng hôm nay 2026')
    expect(resolveStaleYear('newest Ubuntu LTS 2024', 'newest Ubuntu LTS', NOW)).toBe('newest Ubuntu LTS 2026')
    expect(resolveStaleYear('newest Ubuntu LTS 2027 roadmap', 'newest Ubuntu LTS 2027 roadmap', NOW)).toBe('newest Ubuntu LTS 2027 roadmap')
  })

  it('keeps years the raw query named without time vocabulary, and leaves non-time queries alone', () => {
    expect(resolveStaleYear('F1 2025 season review', 'F1 2025 season review', NOW)).toBe('F1 2025 season review')
    expect(resolveStaleYear('best phở District 1', 'best phở District 1', NOW)).toBe('best phở District 1')
  })

  it('strips multiple stale years and collapses the whitespace', () => {
    expect(resolveStaleYear('weather today  2024 vs 2025', 'weather today 2024 vs 2025', NOW)).toBe('weather today vs 2026-09-08')
  })
})

describe('generatorSystem', () => {
  it('carries the current time and the language/time-resolution instructions', () => {
    const system = generatorSystem(NOW)
    expect(system).toContain('2026-09-08T03:12:04.236Z')
    expect(system).toContain('Tuesday')
    expect(system).toContain("the input's language")
    expect(system).toContain('absolute dates')
  })
})

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
