/**
 * Unit coverage for the chat glue's pure history projection and settings.
 */

import { describe, expect, it } from 'vitest'
import {
  applySettingsPatch,
  normalizeSearchQuery,
  paginateSessions,
  parseSettingsFile,
  projectSurfaceEvent,
  type ChatSettings,
  type Config,
} from '../src/index.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function surfaceEvent(type: string, data: unknown): SessionEvent {
  return {
    type,
    seq: 0,
    time: 0,
    data,
    surfaceOp: 'append',
  } as unknown as SessionEvent
}

describe('projectSurfaceEvent', () => {
  it('projects user and assistant text messages', () => {
    expect(projectSurfaceEvent(surfaceEvent('user/message', { content: [{ type: 'text', text: 'hi' }] })))
      .toEqual({ role: 'user', text: 'hi' })
    expect(projectSurfaceEvent(surfaceEvent('assistant/message', {
      message: { content: [{ type: 'text', text: 'hello' }] },
    }))).toEqual({ role: 'assistant', text: 'hello' })
  })

  it('skips empty (tool-call-only) assistant messages and empty user payloads', () => {
    expect(projectSurfaceEvent(surfaceEvent('assistant/message', { message: { content: [] } })))
      .toBeUndefined()
    expect(projectSurfaceEvent(surfaceEvent('user/message', { content: [] })))
      .toBeUndefined()
  })

  it('projects a web_search result from its presentation meta', () => {
    expect(projectSurfaceEvent(surfaceEvent('tool/result', {
      message: { content: [] },
      meta: {
        query: 'q?',
        searchQuestion: 'the real question',
        searchedAt: '2026-09-08T00:00:00.000Z',
        sources: [{ url: 'https://a', title: 'A', publishedAt: '2026-09-01' }, { url: 'https://b' }],
        truncated: false,
      },
    }))).toEqual({
      role: 'tool',
      name: 'web_search',
      query: 'q?',
      searchQuestion: 'the real question',
      searchedAt: '2026-09-08T00:00:00.000Z',
      sources: [{ url: 'https://a', title: 'A', publishedAt: '2026-09-01' }, { url: 'https://b' }],
    })
  })

  it('falls back to rendered text when meta is absent', () => {
    expect(projectSurfaceEvent(surfaceEvent('tool/result', {
      message: { content: [{ type: 'text', text: 'Error: no provider' }] },
      error: { name: 'WebError', code: 'WEB_PROVIDER_UNAVAILABLE' },
    }))).toEqual({ role: 'tool', name: 'web_search', text: 'Error: no provider' })
  })

  it('ignores non-surface events', () => {
    expect(projectSurfaceEvent(surfaceEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })))
      .toBeUndefined()
  })
})

const baseConfig: Config = {
  openBrowser: false,
  printUrl: false,
  provider: 'deepseek-official',
  model: 'deepseek-chat',
  persona: 'You are a helpful assistant.',
}

const baseSettings: ChatSettings = {
  provider: 'deepseek-official',
  model: 'deepseek-chat',
  persona: 'You are a helpful assistant.',
}

describe('applySettingsPatch', () => {
  it('applies each field and trims route strings', () => {
    expect(applySettingsPatch(baseSettings, { provider: ' p ', model: ' m ', reasoningEffort: 'high', temperature: 0.3 }))
      .toEqual({ ...baseSettings, provider: 'p', model: 'm', reasoningEffort: 'high', temperature: 0.3 })
  })

  it('clears optional fields with null and normalizes an empty persona', () => {
    const set: ChatSettings = { ...baseSettings, reasoningEffort: 'low', temperature: 1, persona: 'custom' }
    expect(applySettingsPatch(set, { reasoningEffort: null, temperature: null, persona: '  ' }))
      .toEqual({ ...baseSettings, persona: 'You are a helpful assistant.' })
  })

  it('rejects unknown keys and invalid values', () => {
    expect(() => applySettingsPatch(baseSettings, { nope: 1 })).toThrow('unknown setting "nope"')
    expect(() => applySettingsPatch(baseSettings, { model: '' })).toThrow()
    expect(() => applySettingsPatch(baseSettings, { reasoningEffort: 'medium' })).toThrow()
    expect(() => applySettingsPatch(baseSettings, { temperature: 3 })).toThrow()
    expect(() => applySettingsPatch(baseSettings, { persona: 7 })).toThrow()
  })

  it('trims and validates baseUrl and apiKey, clearing with null', () => {
    expect(applySettingsPatch(baseSettings, { baseUrl: ' https://gw.example/v1/ ' }).baseUrl).toBe('https://gw.example/v1')
    expect(() => applySettingsPatch(baseSettings, { baseUrl: 'ftp://gw.example' })).toThrow('http(s) URL')
    expect(() => applySettingsPatch(baseSettings, { baseUrl: 'not a url' })).toThrow('http(s) URL')
    const withKey = applySettingsPatch(baseSettings, { apiKey: ' sk-abc ' })
    expect(withKey.apiKey).toBe('sk-abc')
    expect(() => applySettingsPatch(baseSettings, { apiKey: '   ' })).toThrow('non-empty')
    expect(applySettingsPatch(withKey, { apiKey: null }).apiKey).toBeUndefined()
  })
})

describe('parseSettingsFile', () => {
  it('falls back to config defaults without a file', () => {
    expect(parseSettingsFile(undefined, baseConfig)).toEqual(baseSettings)
  })

  it('falls back to config defaults on a corrupt file', () => {
    expect(parseSettingsFile('{oops', baseConfig)).toEqual(baseSettings)
  })

  it('overlays a valid persisted file', () => {
    const raw = JSON.stringify({ model: 'qwen3.8-flash-next', reasoningEffort: 'off', temperature: 0.7 })
    expect(parseSettingsFile(raw, baseConfig))
      .toEqual({ ...baseSettings, model: 'qwen3.8-flash-next', reasoningEffort: 'off', temperature: 0.7 })
  })

  it('falls back when the file carries an unknown key', () => {
    expect(parseSettingsFile(JSON.stringify({ nope: true }), baseConfig)).toEqual(baseSettings)
  })
})

describe('paginateSessions', () => {
  const records = Array.from({ length: 25 }, (_, index) => index)

  it('defaults to the first 20-item page with the full total', () => {
    expect(paginateSessions(records, null, null)).toEqual({ page: records.slice(0, 20), total: 25 })
  })

  it('slices by limit and offset', () => {
    expect(paginateSessions(records, '5', '20')).toEqual({ page: records.slice(20, 25), total: 25 })
    expect(paginateSessions(records, '10', '0')).toEqual({ page: records.slice(0, 10), total: 25 })
  })

  it('clamps malformed, zero, and oversized limits and offsets', () => {
    expect(paginateSessions(records, 'nope', '-3')).toEqual({ page: records.slice(0, 20), total: 25 })
    expect(paginateSessions(records, '0', '0').page).toHaveLength(20)
    expect(paginateSessions(records, '500', '0').page).toHaveLength(25)
  })
})

describe('normalizeSearchQuery', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeSearchQuery('  giá vàng  ')).toBe('giá vàng')
  })

  it('rejects empty, NUL-bearing, and oversized queries', () => {
    expect(() => normalizeSearchQuery('   ')).toThrow('not be empty')
    expect(() => normalizeSearchQuery('a\0b')).toThrow('NUL')
    expect(() => normalizeSearchQuery('x'.repeat(501))).toThrow('at most 500')
  })
})
