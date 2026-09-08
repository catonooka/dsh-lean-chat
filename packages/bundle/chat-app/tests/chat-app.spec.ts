/**
 * Unit coverage for the chat glue's pure history projection and settings.
 */

import { describe, expect, it } from 'vitest'
import {
  applySettingsPatch,
  sortSessionsByActivity,
  normalizeSearchQuery,
  paginateSessions,
  parseSettingsFile,
  projectSurfaceEvent,
  resolveProviderFallback,
  truncateSnippet,
  type ChatSettings,
  type Config,
} from '../src/index.ts'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

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
  chromeCdpPort: 9222,
  chromeWebEngine: 'google',
}

const baseSettings: ChatSettings = {
  provider: 'deepseek-official',
  profiles: [{ id: 'default', name: 'Default', model: 'deepseek-chat' }],
  activeProfileId: 'default',
  persona: 'You are a helpful assistant.',
  searchTool: 'tiny-metasearch',
}

const twoProfiles: ChatSettings = {
  ...baseSettings,
  profiles: [
    { id: 'a', name: 'Gateway A', model: 'model-a', baseUrl: 'https://a.example/v1', apiKey: 'key-a' },
    { id: 'b', name: 'Gateway B', model: 'model-b' },
  ],
  activeProfileId: 'a',
}

describe('applySettingsPatch', () => {
  it('applies each field, trims route strings, and edits the active profile', () => {
    expect(applySettingsPatch(baseSettings, { provider: ' p ', model: ' m ', reasoningEffort: 'high', temperature: 0.3 }))
      .toEqual({
        ...baseSettings,
        provider: 'p',
        reasoningEffort: 'high',
        temperature: 0.3,
        profiles: [{ id: 'default', name: 'Default', model: 'm' }],
      })
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

  it('trims and validates the active profile baseUrl and apiKey, clearing with null', () => {
    const withBase = applySettingsPatch(baseSettings, { baseUrl: ' https://gw.example/v1/ ' })
    expect(withBase.profiles[0]?.baseUrl).toBe('https://gw.example/v1')
    expect(() => applySettingsPatch(baseSettings, { baseUrl: 'ftp://gw.example' })).toThrow('http(s) URL')
    expect(() => applySettingsPatch(baseSettings, { baseUrl: 'not a url' })).toThrow('http(s) URL')
    const withKey = applySettingsPatch(baseSettings, { apiKey: ' sk-abc ' })
    expect(withKey.profiles[0]?.apiKey).toBe('sk-abc')
    expect(() => applySettingsPatch(baseSettings, { apiKey: '   ' })).toThrow('non-empty')
    expect(applySettingsPatch(withKey, { apiKey: null }).profiles[0]?.apiKey).toBeUndefined()
  })

  it('switches the search tool between the two engines only', () => {
    expect(applySettingsPatch(baseSettings, { searchTool: 'user-chrome' }).searchTool).toBe('user-chrome')
    expect(applySettingsPatch(baseSettings, { searchTool: 'tiny-metasearch' }).searchTool).toBe('tiny-metasearch')
    expect(() => applySettingsPatch(baseSettings, { searchTool: 'deepseek-official' })).toThrow('searchTool')
  })
})

describe('provider profiles', () => {
  it('switches the active profile and rejects unknown ids', () => {
    expect(applySettingsPatch(twoProfiles, { switchProfile: 'b' }).activeProfileId).toBe('b')
    expect(() => applySettingsPatch(twoProfiles, { switchProfile: 'zz' })).toThrow('unknown profile "zz"')
    expect(() => applySettingsPatch(twoProfiles, { activeProfileId: '' })).toThrow('profile id')
  })

  it('applies field edits after a switch, whatever the key order', () => {
    const switched = applySettingsPatch(twoProfiles, { model: 'm-b', baseUrl: 'https://b.example/v1', switchProfile: 'b' })
    expect(switched.activeProfileId).toBe('b')
    expect(switched.profiles.find(profile => profile.id === 'b')).toMatchObject({ model: 'm-b', baseUrl: 'https://b.example/v1' })
    expect(switched.profiles.find(profile => profile.id === 'a')).toMatchObject({ model: 'model-a', baseUrl: 'https://a.example/v1' })

    const reordered = applySettingsPatch(twoProfiles, { switchProfile: 'b', apiKey: 'kb' })
    expect(reordered.profiles.find(profile => profile.id === 'b')?.apiKey).toBe('kb')
  })

  it('renames with trimming and rejects empty, oversized, or unknown targets', () => {
    expect(applySettingsPatch(twoProfiles, { renameProfile: { id: 'a', name: '  My gateway  ' } }).profiles[0]?.name)
      .toBe('My gateway')
    expect(() => applySettingsPatch(twoProfiles, { renameProfile: { id: 'a', name: '  ' } })).toThrow('non-empty')
    expect(() => applySettingsPatch(twoProfiles, { renameProfile: { id: 'a', name: 'x'.repeat(61) } })).toThrow('at most 60')
    expect(() => applySettingsPatch(twoProfiles, { renameProfile: { id: 'zz', name: 'n' } })).toThrow('unknown profile')
    expect(() => applySettingsPatch(twoProfiles, { renameProfile: { id: 'a' } })).toThrow('needs a name')
  })

  it('creates a profile copying the active endpoint, activates it, and mints a fresh id', () => {
    let calls = 0
    const created = applySettingsPatch(twoProfiles, { newProfile: { name: ' Sandbox ' } }, () => {
      calls += 1
      return calls === 1 ? 'a' : 'fresh'
    })
    expect(created.profiles).toHaveLength(3)
    expect(created.activeProfileId).toBe('fresh')
    expect(created.profiles.find(profile => profile.id === 'fresh')).toMatchObject({
      name: 'Sandbox', model: 'model-a', baseUrl: 'https://a.example/v1', apiKey: 'key-a',
    })
    expect(applySettingsPatch(twoProfiles, { newProfile: {} }).profiles[2]?.name).toBe('Profile 3')
  })

  it('deletes a profile, refusing the last one and reactivating the survivor', () => {
    expect(() => applySettingsPatch(baseSettings, { deleteProfile: { id: 'default' } })).toThrow('last profile')
    expect(() => applySettingsPatch(twoProfiles, { deleteProfile: { id: 'zz' } })).toThrow('unknown profile')
    const deleted = applySettingsPatch(twoProfiles, { deleteProfile: { id: 'a' } })
    expect(deleted.profiles).toEqual([{ id: 'b', name: 'Gateway B', model: 'model-b' }])
    expect(deleted.activeProfileId).toBe('b')
    const deletedIdle = applySettingsPatch(twoProfiles, { deleteProfile: { id: 'b' } })
    expect(deletedIdle.activeProfileId).toBe('a')
  })

  it('replaces the profile list wholesale, healing the active id and dropping bad entries', () => {
    const replaced = applySettingsPatch(twoProfiles, {
      profiles: [{ id: 'x', name: 'X', model: 'mx' }, 'junk', { id: 'y', name: ' ', model: 'my' }],
    })
    expect(replaced.profiles).toEqual([{ id: 'x', name: 'X', model: 'mx' }])
    expect(replaced.activeProfileId).toBe('x')
    expect(() => applySettingsPatch(twoProfiles, { profiles: [] })).toThrow('at least one')
    expect(() => applySettingsPatch(twoProfiles, { profiles: 'nope' })).toThrow('array')
    expect(() => applySettingsPatch(twoProfiles, {
      profiles: [{ id: 'p', name: 'P', model: 'm' }, { id: 'p', name: 'P2', model: 'm2' }],
    })).toThrow('unique')
  })
})

describe('parseSettingsFile', () => {
  it('falls back to config defaults without a file', () => {
    expect(parseSettingsFile(undefined, baseConfig)).toEqual(baseSettings)
  })

  it('falls back to config defaults on a corrupt file', () => {
    expect(parseSettingsFile('{oops', baseConfig)).toEqual(baseSettings)
  })

  it('overlays a valid persisted file onto the default profile', () => {
    const raw = JSON.stringify({ model: 'qwen3.8-flash-next', reasoningEffort: 'off', temperature: 0.7 })
    expect(parseSettingsFile(raw, baseConfig))
      .toEqual({
        ...baseSettings,
        reasoningEffort: 'off',
        temperature: 0.7,
        profiles: [{ id: 'default', name: 'Default', model: 'qwen3.8-flash-next' }],
      })
  })

  it('names a migrated legacy profile after its gateway host', () => {
    const parsed = parseSettingsFile(JSON.stringify({
      model: 'm2',
      baseUrl: 'https://mllm.dreamingengineer.com/v1',
      apiKey: 'k',
    }), baseConfig)
    expect(parsed.profiles).toEqual([{
      id: 'default',
      name: 'mllm.dreamingengineer.com',
      model: 'm2',
      baseUrl: 'https://mllm.dreamingengineer.com/v1',
      apiKey: 'k',
    }])
    expect(parsed.activeProfileId).toBe('default')
  })

  it('round-trips a modern profiled file', () => {
    const parsed = parseSettingsFile(JSON.stringify({
      provider: 'deepseek-official',
      profiles: [
        { id: 'a', name: 'Gateway A', model: 'model-a', baseUrl: 'https://a.example/v1', apiKey: 'key-a' },
        { id: 'b', name: 'Gateway B', model: 'model-b' },
      ],
      activeProfileId: 'b',
      persona: 'custom persona',
    }), baseConfig)
    expect(parsed).toEqual({
      ...baseSettings,
      profiles: [
        { id: 'a', name: 'Gateway A', model: 'model-a', baseUrl: 'https://a.example/v1', apiKey: 'key-a' },
        { id: 'b', name: 'Gateway B', model: 'model-b' },
      ],
      activeProfileId: 'b',
      persona: 'custom persona',
    })
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

describe('applySettingsPatch — boundary corners', () => {
  it('accepts temperature at the exact bounds and rejects just outside', () => {
    expect(applySettingsPatch(baseSettings, { temperature: 0 }).temperature).toBe(0)
    expect(applySettingsPatch(baseSettings, { temperature: 2 }).temperature).toBe(2)
    expect(() => applySettingsPatch(baseSettings, { temperature: -0.1 })).toThrow()
    expect(() => applySettingsPatch(baseSettings, { temperature: 2.1 })).toThrow()
    expect(() => applySettingsPatch(baseSettings, { temperature: Number.POSITIVE_INFINITY })).toThrow()
    expect(() => applySettingsPatch(baseSettings, { temperature: Number.NaN })).toThrow()
    expect(() => applySettingsPatch(baseSettings, { temperature: '0.5' as unknown as number })).toThrow()
  })

  it('accepts the exact persona and API-key caps and rejects one over', () => {
    expect(applySettingsPatch(baseSettings, { persona: 'p'.repeat(4000) }).persona).toBe('p'.repeat(4000))
    expect(() => applySettingsPatch(baseSettings, { persona: 'p'.repeat(4001) })).toThrow()
    expect(applySettingsPatch(baseSettings, { apiKey: 'k'.repeat(500) }).profiles[0]?.apiKey).toBe('k'.repeat(500))
    expect(() => applySettingsPatch(baseSettings, { apiKey: 'k'.repeat(501) })).toThrow()
  })

  it('keeps internal spaces and case in route strings, trimming only the edges', () => {
    expect(applySettingsPatch(baseSettings, { model: ' qwen 3.5 Flash ' }).profiles[0]?.model).toBe('qwen 3.5 Flash')
  })
})

describe('applySettingsPatch — baseUrl corners', () => {
  it('accepts local hosts, uppercase schemes, and multi-trailing-slash trims', () => {
    expect(applySettingsPatch(baseSettings, { baseUrl: 'http://localhost:11434' }).profiles[0]?.baseUrl).toBe('http://localhost:11434')
    expect(applySettingsPatch(baseSettings, { baseUrl: 'HTTPS://GW.EXAMPLE/V1' }).profiles[0]?.baseUrl).toBe('HTTPS://GW.EXAMPLE/V1')
    expect(applySettingsPatch(baseSettings, { baseUrl: 'https://gw.example/v1///' }).profiles[0]?.baseUrl).toBe('https://gw.example/v1')
  })

  it('rejects bare schemes, embedded spaces, and empty-after-trim values that stay set', () => {
    expect(() => applySettingsPatch(baseSettings, { baseUrl: 'https://' })).toThrow('http(s) URL')
    expect(() => applySettingsPatch(baseSettings, { baseUrl: 'https://ex ample.com' })).toThrow('http(s) URL')
    // Whitespace-only clears the override rather than throwing.
    const withOverride: ChatSettings = { ...baseSettings, profiles: [{ id: 'default', name: 'Default', model: 'deepseek-chat', baseUrl: 'https://x' }] }
    expect(applySettingsPatch(withOverride, { baseUrl: '   ' }).profiles[0]?.baseUrl).toBeUndefined()
  })
})

describe('parseSettingsFile — hostile file corners', () => {
  it('falls back on an empty file, null values, and wrong-typed overlays', () => {
    expect(parseSettingsFile('', baseConfig)).toEqual(baseSettings)
    expect(parseSettingsFile(JSON.stringify({ model: null }), baseConfig)).toEqual(baseSettings)
    expect(parseSettingsFile(JSON.stringify({ temperature: 'hot' }), baseConfig)).toEqual(baseSettings)
  })

  it('overlays only the given keys and keeps the rest of the defaults', () => {
    expect(parseSettingsFile(JSON.stringify({ searchTool: 'user-chrome' }), baseConfig))
      .toEqual({ ...baseSettings, searchTool: 'user-chrome' })
  })
})

describe('paginateSessions — edge offsets', () => {
  const records = [1, 2, 3, 4, 5]
  it('returns an empty page (with the total) past the end and at exactly the end', () => {
    expect(paginateSessions(records, '5', '5')).toEqual({ page: [], total: 5 })
    expect(paginateSessions(records, '5', '10000')).toEqual({ page: [], total: 5 })
  })
  it('serves a one-item page', () => {
    expect(paginateSessions(records, '1', '4')).toEqual({ page: [5], total: 5 })
  })
})

describe('normalizeSearchQuery — length and content edges', () => {
  it('accepts exactly 500 characters and rejects 501', () => {
    expect(normalizeSearchQuery('q'.repeat(500))).toBe('q'.repeat(500))
    expect(() => normalizeSearchQuery('q'.repeat(501))).toThrow('at most 500')
  })
  it('rejects whitespace-only and tab/newline-only input', () => {
    expect(() => normalizeSearchQuery(' \t\n ')).toThrow('not be empty')
  })
})

describe('truncateSnippet — code-point corners', () => {
  it('keeps text at or under the budget untouched', () => {
    expect(truncateSnippet('a'.repeat(240))).toBe('a'.repeat(240))
    expect(truncateSnippet('')).toBe('')
  })
  it('clips by code points, not UTF-16 units, appending the ellipsis', () => {
    const emoji = '🎉'.repeat(241)
    const clipped = truncateSnippet(emoji)
    // 240 emoji code points (480 UTF-16 units) plus the one-unit ellipsis.
    expect(Array.from(clipped).length).toBe(241)
    expect(clipped.endsWith('…')).toBe(true)
    expect(clipped.slice(0, -1)).toBe('🎉'.repeat(240))
  })
})

describe('projectSurfaceEvent — malformed meta corners', () => {
  it('slices the source list to the cap and filters malformed entries', () => {
    const sources = [
      { url: 'https://a', title: 'A', publishedAt: '2026-01-01' },
      { url: 42 },
      'not an object',
      null,
      { title: 'no url' },
      ...Array.from({ length: 10 }, (_, index) => ({ url: `https://x/${String(index)}` })),
    ]
    const item = projectSurfaceEvent(surfaceEvent('tool/result', { message: { content: [] }, meta: { query: 'q', sources } }))
    expect(item?.sources).toHaveLength(8)
    expect(item?.sources?.[0]).toEqual({ url: 'https://a', title: 'A', publishedAt: '2026-01-01' })
    expect(item?.sources?.[1]?.url).toBe('https://x/0')
  })

  it('ignores a non-array sources field and non-string scalars', () => {
    const item = projectSurfaceEvent(surfaceEvent('tool/result', {
      message: { content: [] },
      meta: { query: 'q', sources: 'nope', searchedAt: 123, searchQuestion: null },
    }))
    expect(item).toEqual({ role: 'tool', name: 'web_search', query: 'q', text: undefined })
  })

  it('keeps whitespace-only user and assistant text (only empty text is skipped)', () => {
    expect(projectSurfaceEvent(surfaceEvent('user/message', { content: [{ type: 'text', text: '   ' }] })))
      .toEqual({ role: 'user', text: '   ' })
    expect(projectSurfaceEvent(surfaceEvent('assistant/message', { message: { content: [{ type: 'text', text: ' ' }] } })))
      .toEqual({ role: 'assistant', text: ' ' })
  })
})

describe('sortSessionsByActivity', () => {
  const sessions = [
    { header: { id: SessionId('newest'), createdAt: 300 } },
    { header: { id: SessionId('middle'), createdAt: 200 } },
    { header: { id: SessionId('oldest'), createdAt: 100 } },
  ]

  it('bumps a continued old conversation above newer, untouched ones', () => {
    const ordered = sortSessionsByActivity(sessions, new Map([['oldest', 999]]))
    expect(ordered.map(session => session.header.id)).toEqual(['oldest', 'newest', 'middle'])
  })

  it('falls back to creation time when no activity stamp exists', () => {
    expect(sortSessionsByActivity(sessions, new Map()).map(session => session.header.id))
      .toEqual(['newest', 'middle', 'oldest'])
  })

  it('prefers activity over creation when both exist', () => {
    const ordered = sortSessionsByActivity(sessions, new Map([['newest', 50], ['middle', 400]]))
    expect(ordered.map(session => session.header.id)).toEqual(['middle', 'oldest', 'newest'])
  })

  it('breaks activity ties by id ascending for a deterministic page order', () => {
    const tied = [
      { header: { id: SessionId('b'), createdAt: 100 } },
      { header: { id: SessionId('a'), createdAt: 100 } },
    ]
    expect(sortSessionsByActivity(tied, new Map()).map(session => session.header.id)).toEqual(['a', 'b'])
  })

  it('does not mutate the input and handles an empty list', () => {
    const input = [{ header: { id: SessionId('x'), createdAt: 1 } }]
    sortSessionsByActivity(input, new Map())
    expect(input).toHaveLength(1)
    expect(sortSessionsByActivity([], new Map())).toEqual([])
  })
})

describe('resolveProviderFallback', () => {
  it('keeps a registered current provider', () => {
    expect(resolveProviderFallback('deepseek-official', ['deepseek-official'], 'deepseek-official'))
      .toBe('deepseek-official')
  })

  it('heals an unregistered provider to the fallback, then to the first route', () => {
    expect(resolveProviderFallback('local LLM', ['deepseek-official'], 'deepseek-official'))
      .toBe('deepseek-official')
    expect(resolveProviderFallback('local LLM', ['pi-ai', 'deepseek-official'], 'gone')).toBe('pi-ai')
  })

  it('keeps the fallback when nothing is registered at all', () => {
    expect(resolveProviderFallback('local LLM', [], 'deepseek-official')).toBe('deepseek-official')
  })
})
