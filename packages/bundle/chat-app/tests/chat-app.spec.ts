/**
 * Unit coverage for the chat glue's pure history projection and settings.
 */

import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  activeProfile,
  applySettingsPatch,
  RateLimiter,
  attachmentDescriptors,
  cachePolicyFor,
  collapseRetriedUserTurns,
  modalityClaim,
  evictableSessionIds,
  hasSessionCookie,
  InFlightDedup,
  isLocalOrBridgeRequest,
  isLocalRequest,
  sortSessionsByActivity,
  SessionListingCache,
  normalizeSearchQuery,
  paginateSessions,
  parseAttachment,
  parseAttachmentRef,
  parseReplyTo,
  parseSessionToken,
  parseSettingsFile,
  projectSurfaceEvent,
  requestChunks,
  toolCallSummary,
  resolveProviderFallback,
  TitleSnapshotCache,
  truncateSnippet,
  type ChatItem,
  type ChatSettings,
  type Config,
} from '../src/index.ts'
import { snapshotSessionEvent, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { interpretProbeOutcome, probeMessages } from '../src/capabilities.ts'

function surfaceEvent(type: string, data: unknown): SessionEvent {
  return {
    type,
    seq: 0,
    time: 0,
    data,
    surfaceOp: 'append',
  } as unknown as SessionEvent
}

describe('projectSurfaceEvent', () => {  it('projects user and assistant text messages', () => {
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

it('projects a browser result from its presentation meta, keeping the tool name', () => {
  expect(projectSurfaceEvent(surfaceEvent('tool/result', {
    message: { content: [{ type: 'text', text: 'External web content follows…' }] },
    meta: {
      name: 'browser',
      action: 'extract',
      url: 'https://x.com/me',
      title: 'me (@me)',
      truncated: true,
      excerpt: 'Shipped the browser tool.',
    },
  }))).toEqual({
    role: 'tool',
    name: 'browser',
    action: 'extract',
    url: 'https://x.com/me',
    title: 'me (@me)',
    excerpt: 'Shipped the browser tool.',
  })
})

it('ignores non-surface events', () => {
  expect(projectSurfaceEvent(surfaceEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })))
    .toBeUndefined()
})

it('projects the reply quote that rides a user message next to its content', () => {
  expect(projectSurfaceEvent(surfaceEvent('user/message', {
    content: [{ type: 'text', text: 'same to you' }],
    replyTo: { role: 'assistant', text: 'hello' },
  }))).toEqual({ role: 'user', text: 'same to you', replyTo: { role: 'assistant', text: 'hello' } })
  expect(projectSurfaceEvent(surfaceEvent('user/message', { content: [{ type: 'text', text: 'plain' }] })))
    .toEqual({ role: 'user', text: 'plain' })
})

it('projects a compaction checkpoint as a summary card, not a user bubble', () => {
  expect(projectSurfaceEvent(surfaceEvent('user/message', {
    content: [{ type: 'text', text: '# Compacted checkpoint\nthe user asked about weather' }],
    source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' },
  }))).toEqual({ role: 'compaction', text: '# Compacted checkpoint\nthe user asked about weather' })
})
})

describe('toolCallSummary', () => {
  it('pulls the search query out of a web_search call', () => {
    expect(toolCallSummary('{"query":"bridge routing"}')).toEqual({ query: 'bridge routing' })
  })

  it('pulls action and url out of a browser call, ignoring everything else', () => {
    expect(toolCallSummary('{"action":"open","url":"https://x.com/me","session":"x-feed","goal":"posts"}'))
      .toEqual({ action: 'open', url: 'https://x.com/me' })
  })

  it('answers nothing for malformed or non-object arguments', () => {
    expect(toolCallSummary('not json')).toEqual({})
    expect(toolCallSummary('["array"]')).toEqual({})
    expect(toolCallSummary('{"action":7,"url":null,"query":42}')).toEqual({})
  })
})

describe('applySettingsPatch — auto-compact toggle', () => {
  it('sets, flips, and clears the toggle', () => {
    const off = applySettingsPatch(baseSettings, { autoCompact: false })
    expect(off.autoCompact).toBe(false)
    const on = applySettingsPatch(off, { autoCompact: true })
    expect(on.autoCompact).toBe(true)
    const cleared = applySettingsPatch(on, { autoCompact: null })
    expect('autoCompact' in cleared).toBe(false)
  })

  it('rejects non-boolean values', () => {
    expect(() => applySettingsPatch(baseSettings, { autoCompact: 'yes' })).toThrow('autoCompact must be a boolean')
    expect(() => applySettingsPatch(baseSettings, { autoCompact: 1 })).toThrow('autoCompact must be a boolean')
  })
})

describe('parseSettingsFile — auto-compact toggle', () => {
  it('reads the persisted toggle and defaults to on when absent', () => {
    expect(parseSettingsFile(JSON.stringify({ autoCompact: false }), baseConfig).autoCompact).toBe(false)
    expect(parseSettingsFile(JSON.stringify({ autoCompact: true }), baseConfig).autoCompact).toBe(true)
    expect(parseSettingsFile(undefined, baseConfig).autoCompact).toBeUndefined()
    expect(parseSettingsFile(JSON.stringify({ persona: 'x' }), baseConfig).autoCompact).toBeUndefined()
  })
})

describe('parseReplyTo', () => {
  it('accepts a well-formed reply target', () => {
    expect(parseReplyTo({ role: 'assistant', text: 'hello there' }))
      .toEqual({ ok: true, replyTo: { role: 'assistant', text: 'hello there' } })
  })

  it('rejects non-objects, unknown roles, and empty text', () => {
    expect(parseReplyTo('hello')).toEqual({ ok: false, error: 'replyTo must be an object with role and text' })
    expect(parseReplyTo(null)).toEqual({ ok: false, error: 'replyTo must be an object with role and text' })
    expect(parseReplyTo([{ role: 'user', text: 'x' }])).toEqual({ ok: false, error: 'replyTo must be an object with role and text' })
    expect(parseReplyTo({ role: 'tool', text: 'x' })).toEqual({ ok: false, error: 'replyTo role must be user or assistant' })
    expect(parseReplyTo({ role: 'user', text: '   ' })).toEqual({ ok: false, error: 'replyTo text must be a non-empty string' })
    expect(parseReplyTo({ role: 'user', text: 7 })).toEqual({ ok: false, error: 'replyTo text must be a non-empty string' })
  })

  it('folds whitespace and clamps the stored quote', () => {
    expect(parseReplyTo({ role: 'user', text: ' first \n line\t\tsecond ' }))
      .toEqual({ ok: true, replyTo: { role: 'user', text: 'first line second' } })
    expect(parseReplyTo({ role: 'assistant', text: 'x'.repeat(500) }))
      .toEqual({ ok: true, replyTo: { role: 'assistant', text: 'x'.repeat(300) } })
  })
})

/** The reply feature rides an extra field on user messages through the
 * message pipeline and the session ledger. These tests pin the two
 * load-bearing assumptions: construction keeps sibling fields, and the
 * ledger read-back snapshot copies them verbatim. */
describe('replyTo persistence assumptions', () => {
  const replyTo = { role: 'assistant' as const, text: 'hello' }

  it('createUserMessage carries a sibling replyTo field verbatim', () => {
    const message = createUserMessage({
      content: [{ type: 'text', text: 'same to you' }],
      source: { kind: 'user' },
      replyTo,
    })
    expect(message.role).toBe('user')
    expect((message as UserMessage & { replyTo?: typeof replyTo }).replyTo).toEqual(replyTo)
  })

  it('snapshotSessionEvent keeps replyTo when the ledger is read back', () => {
    const event = surfaceEvent('user/message', {
      id: 'm1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'same to you' }],
      replyTo,
    })
    const snapshot = snapshotSessionEvent(event)
    const data = snapshot.data as UserMessage & { replyTo?: typeof replyTo }
    expect(data.replyTo).toEqual(replyTo)
    // The snapshot is a detached copy: mutating the source cannot leak in.
    expect((event.data as { replyTo?: typeof replyTo }).replyTo).toEqual(replyTo)
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

describe('isLocalRequest', () => {
  const request = (headers: Record<string, string>): { headers: Record<string, string> } => ({ headers })

  it('accepts every loopback host form, with or without a port', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:3095', 'localhost', 'localhost:3095', '[::1]:3095']) {
      expect(isLocalRequest(request({ host }))).toBe(true)
    }
  })

  it('rejects a non-loopback host before looking at anything else', () => {
    expect(isLocalRequest(request({ host: 'example.com:3095' }))).toBe(false)
    expect(isLocalRequest(request({ host: '192.168.1.5:3095' }))).toBe(false)
    expect(isLocalRequest(request({}))).toBe(false)
  })

  it('accepts loopback origins only — extension origins are not local', () => {
    expect(isLocalRequest(request({ host: '127.0.0.1', origin: 'chrome-extension://jeamfjgfbbpcjdpdmejleaclmhblnolc' }))).toBe(false)
    expect(isLocalRequest(request({ host: '127.0.0.1', origin: 'http://127.0.0.1:5173' }))).toBe(true)
    expect(isLocalRequest(request({ host: '127.0.0.1', origin: 'http://localhost:5173' }))).toBe(true)
    expect(isLocalRequest(request({ host: '127.0.0.1', origin: 'http://[::1]:5173' }))).toBe(false)
  })

  it('rejects remote and malformed origins on an otherwise local host', () => {
    expect(isLocalRequest(request({ host: '127.0.0.1', origin: 'https://evil.example' }))).toBe(false)
    expect(isLocalRequest(request({ host: '127.0.0.1', origin: 'chrome-extension:' }))).toBe(false)
    expect(isLocalRequest(request({ host: '127.0.0.1', origin: '::not a url' }))).toBe(false)
  })
})

describe('isLocalOrBridgeRequest', () => {
  const request = (headers: Record<string, string>, method = 'GET'): { headers: Record<string, string>; method: string } =>
    ({ headers, method })
  const extension = { origin: 'chrome-extension://jeamfjgfbbpcjdpdmejleaclmhblnolc' }

  it('admits an extension origin on exactly the two bridge routes', () => {
    expect(isLocalOrBridgeRequest(request({ host: '127.0.0.1', ...extension }, 'GET'), ['chrome', 'next'])).toBe(true)
    expect(isLocalOrBridgeRequest(request({ host: '127.0.0.1', ...extension }, 'POST'), ['chrome', 'result'])).toBe(true)
    expect(isLocalOrBridgeRequest(request({ host: '127.0.0.1', ...extension }, 'OPTIONS'), ['chrome', 'result'])).toBe(true)
  })

  it('rejects an extension origin everywhere else', () => {
    for (const [method, parts] of [
      ['GET', ['chrome', 'status']] as const,
      ['POST', ['chrome', 'test']] as const,
      ['POST', ['chrome', 'next']] as const,
      ['GET', ['chrome', 'result']] as const,
      ['GET', ['sessions']] as const,
      ['PUT', ['config']] as const,
      ['GET', ['sessions', 'abc', 'messages']] as const,
    ]) {
      expect(isLocalOrBridgeRequest(request({ host: '127.0.0.1', ...extension }, method), [...parts])).toBe(false)
    }
  })

  it('still passes every loopback request regardless of path', () => {
    expect(isLocalOrBridgeRequest(request({ host: '127.0.0.1' }), ['sessions'])).toBe(true)
    expect(isLocalOrBridgeRequest(request({ host: 'example.com', ...extension }), ['chrome', 'next'])).toBe(false)
  })
})

describe('hasSessionCookie', () => {
  it('matches this boot token among other cookies and trims sloppiness', () => {
    expect(hasSessionCookie('dsh-chat-session=abc', 'abc')).toBe(true)
    expect(hasSessionCookie('theme=dark; dsh-chat-session=abc ; lang=en', 'abc')).toBe(true)
    expect(hasSessionCookie('dsh-chat-session=abc', 'other')).toBe(false)
    expect(hasSessionCookie('dsh-chat-session=', 'abc')).toBe(false)
    expect(hasSessionCookie('other=abc', 'abc')).toBe(false)
    expect(hasSessionCookie(undefined, 'abc')).toBe(false)
    expect(hasSessionCookie('dsh-chat-sessionx=abc', 'abc')).toBe(false)
  })
})

describe('activeProfile', () => {
  it('returns the active profile and falls back to the first on a stale id', () => {
    expect(activeProfile(twoProfiles).id).toBe('a')
    const stale: ChatSettings = { ...twoProfiles, activeProfileId: 'gone' }
    expect(activeProfile(stale).id).toBe('a')
  })

  it('answers a synthetic profile for an empty list rather than crashing', () => {
    const empty: ChatSettings = { ...baseSettings, profiles: [], activeProfileId: 'x' }
    expect(activeProfile(empty)).toEqual({ id: 'default', name: 'Default', model: '' })
  })
})

describe('applySettingsPatch — profile list corners', () => {
  const many: ChatSettings = {
    ...baseSettings,
    profiles: Array.from({ length: 20 }, (_, index) => ({ id: `p${String(index)}`, name: `P${String(index)}`, model: 'm' })),
    activeProfileId: 'p0',
  }

  it('refuses a new profile at the cap and truncates oversized file lists to it', () => {
    expect(() => applySettingsPatch(many, { newProfile: {} })).toThrow('at most 20 profiles')
    const oversized = applySettingsPatch(many, {
      profiles: [...many.profiles, { id: 'extra', name: 'Extra', model: 'm' }],
    })
    expect(oversized.profiles).toHaveLength(20)
    expect(oversized.profiles.some(profile => profile.id === 'extra')).toBe(false)
  })

  it('rejects malformed profile operations with pointed errors', () => {
    expect(() => applySettingsPatch(twoProfiles, { switchProfile: 7 as unknown as string })).toThrow('profile id')
    expect(() => applySettingsPatch(twoProfiles, { renameProfile: 'nope' })).toThrow('must be an object')
    expect(() => applySettingsPatch(twoProfiles, { newProfile: { name: 7 as unknown as string } })).toThrow('name must be a string')
    expect(() => applySettingsPatch(twoProfiles, { deleteProfile: null })).toThrow('must be an object')
    expect(() => applySettingsPatch(twoProfiles, { deleteProfile: { id: '' } })).toThrow('needs a profile id')
  })

  it('accepts a profile name at the exact cap and trims before measuring', () => {
    const edge = 'x'.repeat(60)
    expect(applySettingsPatch(twoProfiles, { renameProfile: { id: 'a', name: `  ${edge}  ` } }).profiles[0]?.name).toBe(edge)
  })

  it('does not mutate the current settings while patching', () => {
    const frozen = JSON.parse(JSON.stringify(twoProfiles)) as ChatSettings
    applySettingsPatch(twoProfiles, { model: 'changed', deleteProfile: { id: 'b' } })
    expect(twoProfiles).toEqual(frozen)
  })
})

describe('parseSettingsFile — hostile profile files', () => {
  it('heals an active id that no profile matches', () => {
    const parsed = parseSettingsFile(JSON.stringify({
      profiles: [{ id: 'a', name: 'A', model: 'm' }],
      activeProfileId: 'zz',
    }), baseConfig)
    expect(parsed.activeProfileId).toBe('a')
  })

  it('falls back to defaults on duplicate profile ids', () => {
    const raw = JSON.stringify({ profiles: [{ id: 'a', name: 'A', model: 'm' }, { id: 'a', name: 'B', model: 'm' }] })
    expect(parseSettingsFile(raw, baseConfig)).toEqual(baseSettings)
  })

  it('falls back to defaults when a legacy file is invalid mid-patch', () => {
    const raw = JSON.stringify({ model: 'm2', baseUrl: 'ftp://bad' })
    expect(parseSettingsFile(raw, baseConfig)).toEqual(baseSettings)
  })

  it('drops blank optional fields while keeping valid ones in file profiles', () => {
    const parsed = parseSettingsFile(JSON.stringify({
      profiles: [{ id: 'a', name: ' A ', model: ' m ', baseUrl: '  ', apiKey: '  ' }],
    }), baseConfig)
    expect(parsed.profiles).toEqual([{ id: 'a', name: 'A', model: 'm' }])
  })
})

describe('capability probe helpers', () => {
  it('accepts on any 2xx and rejects only on content-type-worded client errors', () => {
    expect(interpretProbeOutcome(200, '')).toBe('yes')
    expect(interpretProbeOutcome(204, '')).toBe('yes')
    expect(interpretProbeOutcome(400, 'image input is not supported')).toBe('no')
    expect(interpretProbeOutcome(415, 'unsupported media type: video/mp4')).toBe('no')
    expect(interpretProbeOutcome(422, 'multimodal input rejected')).toBe('no')
    expect(interpretProbeOutcome(400, 'max_tokens must be positive')).toBe('unknown')
  })

  it('stays unknown for auth, rate limits, missing models, and server errors', () => {
    for (const status of [401, 403, 404, 429, 500, 502]) {
      expect(interpretProbeOutcome(status, 'anything')).toBe('unknown')
    }
  })

  it('builds the minimal multimodal message with decodable fixtures', () => {
    const image = probeMessages('image')[0]?.content as { type: string; image_url?: { url: string } }[]
    expect(image[0]?.type).toBe('image_url')
    expect(image[1]).toEqual({ type: 'text', text: 'hi' })
    const png = Buffer.from(String(image[0]?.image_url?.url).split(',')[1] ?? '', 'base64')
    expect(png.at(0)).toBe(0x89)
    expect(png.subarray(1, 4).toString()).toBe('PNG')

    const video = probeMessages('video')[0]?.content as { type: string; video_url?: { url: string } }[]
    expect(video[0]?.type).toBe('video_url')
    const mp4 = Buffer.from(String(video[0]?.video_url?.url).split(',')[1] ?? '', 'base64')
    expect(mp4.subarray(4, 8).toString()).toBe('ftyp')
    expect(mp4.byteLength).toBeGreaterThan(0)
  })
})

describe('RateLimiter', () => {
  it('spends the window budget then refuses, resetting on the next window', () => {
    let now = 1_000
    const limiter = new RateLimiter(3, 1_000, () => now)
    expect(limiter.allow()).toBe(true)
    expect(limiter.allow()).toBe(true)
    expect(limiter.allow()).toBe(true)
    expect(limiter.allow()).toBe(false)
    expect(limiter.allow()).toBe(false)
    now += 1_000
    expect(limiter.allow()).toBe(true)
  })

  it('counts within the window, not from construction', () => {
    let now = 0
    const limiter = new RateLimiter(1, 10_000, () => now)
    expect(limiter.allow()).toBe(true)
    now += 9_999
    expect(limiter.allow()).toBe(false)
    now += 1
    expect(limiter.allow()).toBe(true)
  })
})

describe('evictableSessionIds', () => {
  const handles = new Map<string, { lastUsed: number }>([
    ['idle', { lastUsed: 0 }],
    ['fresh', { lastUsed: 9_500 }],
    ['streaming', { lastUsed: 0 }],
    ['boundary', { lastUsed: 9_000 }],
  ])

  it('retires only the idle-and-quiet ones, strictly past the budget', () => {
    expect(evictableSessionIds(handles, new Set(['streaming']), 19_000, 10_000))
      .toEqual(['idle'])
    expect(evictableSessionIds(handles, new Set(), 5_000, 10_000)).toEqual([])
    expect(evictableSessionIds(new Map(), new Set(), 99_999, 10_000)).toEqual([])
  })
})

describe('cachePolicyFor', () => {
  it('caches hashed assets forever and revalidates everything else', () => {
    expect(cachePolicyFor('/assets/index-CJZzaPGD.js'))
      .toEqual({ 'cache-control': 'public, max-age=31536000, immutable' })
    expect(cachePolicyFor('/assets/index-abc123.css'))
      .toEqual({ 'cache-control': 'public, max-age=31536000, immutable' })
    expect(cachePolicyFor('/index.html')).toEqual({ 'cache-control': 'no-cache' })
    expect(cachePolicyFor('/')).toEqual({ 'cache-control': 'no-cache' })
    expect(cachePolicyFor('/avatars/avatar-1.png')).toEqual({ 'cache-control': 'no-cache' })
    expect(cachePolicyFor('/assets-like/page')).toEqual({ 'cache-control': 'no-cache' })
  })
})

describe('parseAttachment', () => {
  const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  it('decodes a valid image upload with a derived name', () => {
    const parsed = parseAttachment({ kind: 'image', dataUrl: `data:image/png;base64,${png1x1}` })
    expect(parsed.kind).toBe('image')
    expect(parsed.mediaType).toBe('image/png')
    expect(parsed.name).toBe('upload.png')
    expect(parsed.data.byteLength).toBeGreaterThan(50)
  })

  it('keeps a provided name, uppercases nothing, and accepts video media types', () => {
    const parsed = parseAttachment({ kind: 'video', name: '  clip.mp4  ', dataUrl: 'data:video/webm;base64,AAAA' })
    expect(parsed.name).toBe('clip.mp4')
    expect(parsed.mediaType).toBe('video/webm')
    expect(parsed.data.byteLength).toBe(3)
  })

  it('rejects malformed payloads with pointed errors', () => {
    expect(() => parseAttachment('nope')).toThrow('must be an object')
    expect(() => parseAttachment({ kind: 'audio', dataUrl: 'data:audio/mp3;base64,AAAA' })).toThrow('image, video, or file')
    expect(() => parseAttachment({ kind: 'image' })).toThrow('dataUrl')
    expect(() => parseAttachment({ kind: 'image', dataUrl: 'https://x/y.png' })).toThrow('base64 data URL')
    expect(() => parseAttachment({ kind: 'image', dataUrl: 'data:image/bmp;base64,AAAA' })).toThrow('png, jpeg, webp')
    expect(() => parseAttachment({ kind: 'video', dataUrl: 'data:video/mp4;base64,AAAA' })).not.toThrow()
    expect(() => parseAttachment({ kind: 'video', dataUrl: 'data:image/png;base64,AAAA' })).toThrow('video/*')
    expect(() => parseAttachment({ kind: 'image', dataUrl: 'data:image/png;base64,§§§§' })).toThrow('valid base64')
    expect(() => parseAttachment({ kind: 'image', dataUrl: 'data:image/png;base64,' })).toThrow('not valid base64')
  })

  it('enforces per-kind size caps on decoded bytes', () => {
    const eightMb = 'A'.repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4)
    expect(() => parseAttachment({ kind: 'image', dataUrl: `data:image/png;base64,${eightMb}AAAA` })).toThrow('at most 8MB')
    const underVideo = 'A'.repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4)
    expect(parseAttachment({ kind: 'video', dataUrl: `data:video/mp4;base64,${underVideo}` }).data.byteLength)
      .toBeGreaterThan(8 * 1024 * 1024 - 10)
  })

  it('admits video and file attachments up to the 64MB transport cap and refuses beyond', () => {
    // 22369621 * 3 = 67108863 bytes: the largest multiple of 3 that fits 64MiB,
    // so an exact-length base64 string sits one byte under the cap.
    const atCap = 'A'.repeat(22369621 * 4)
    expect(parseAttachment({ kind: 'video', dataUrl: `data:video/mp4;base64,${atCap}` }).data.byteLength).toBe(67108863)
    expect(parseAttachment({ kind: 'file', name: 'blob.bin', dataUrl: `data:application/octet-stream;base64,${atCap}` }).data.byteLength).toBe(67108863)
    expect(() => parseAttachment({ kind: 'video', dataUrl: `data:video/mp4;base64,${atCap}AAAA` })).toThrow('at most 64MB')
    expect(() => parseAttachment({ kind: 'file', dataUrl: `data:application/octet-stream;base64,${atCap}AAAA` })).toThrow('at most 64MB')
  })
})

describe('attachmentDescriptors and projection', () => {
  const imageBlock = {
    type: 'image',
    attachment: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 70, width: 1, height: 1 },
  }
  const videoBlock = {
    type: 'video',
    attachment: { attachmentId: 'vid-1', name: 'clip.mp4', bytes: 1690 },
    mediaType: 'video/mp4',
  }

  it('describes image and video blocks with their durable refs', () => {
    expect(attachmentDescriptors([imageBlock, videoBlock] as unknown as ContentBlock[])).toEqual([
      { kind: 'image', attachmentId: 'img-1', mediaType: 'image/png', ref: imageBlock.attachment },
      { kind: 'video', attachmentId: 'vid-1', mediaType: 'video/mp4', ref: videoBlock.attachment },
    ])
    expect(attachmentDescriptors(undefined)).toEqual([])
  })

  it('projects user messages with attachments, including attachment-only ones', () => {
    const both = projectSurfaceEvent(surfaceEvent('user/message', { content: [imageBlock, { type: 'text', text: 'hi' }] }))
    expect(both).toEqual({ role: 'user', text: 'hi', attachments: [{ kind: 'image', attachmentId: 'img-1', mediaType: 'image/png', ref: imageBlock.attachment }] })
    const only = projectSurfaceEvent(surfaceEvent('user/message', { content: [videoBlock] }))
    expect(only).toEqual({ role: 'user', attachments: [{ kind: 'video', attachmentId: 'vid-1', mediaType: 'video/mp4', ref: videoBlock.attachment }] })
    expect(projectSurfaceEvent(surfaceEvent('user/message', { content: [] }))).toBeUndefined()
  })
})

describe('modalityClaim', () => {
  it('claims image input when either modality probed yes', () => {
    expect(modalityClaim({ model: 'm', image: 'yes', video: 'no' })).toBe(true)
    expect(modalityClaim({ model: 'm', image: 'no', video: 'yes' })).toBe(true)
    expect(modalityClaim({ model: 'm', image: 'yes', video: 'yes' })).toBe(true)
  })

  it('stays text-only when both modalities are refused or unknown', () => {
    expect(modalityClaim({ model: 'm', image: 'no', video: 'no' })).toBe(false)
    expect(modalityClaim({ model: 'm', image: 'unknown', video: 'unknown' })).toBe(false)
    expect(modalityClaim({ model: 'm', image: 'no', video: 'unknown' })).toBe(false)
  })
})

describe('parseAttachment — file kind', () => {
  it('accepts any media type for files and keeps the declared name', () => {
    const parsed = parseAttachment({ kind: 'file', name: 'report.pdf', dataUrl: 'data:application/pdf;base64,JVBERiA=' })
    expect(parsed).toEqual({ kind: 'file', name: 'report.pdf', mediaType: 'application/pdf', data: expect.any(Uint8Array) })
    expect(() => parseAttachment({ kind: 'file', name: 'x.zip', dataUrl: 'data:application/zip;base64,AAAA' })).not.toThrow()
  })

  it('still rejects other kinds with mismatched media types', () => {
    expect(() => parseAttachment({ kind: 'file', dataUrl: 'data:application/pdf;base64,' })).toThrow('not valid base64')
  })
})

describe('attachmentDescriptors — file blocks', () => {
  it('describes files with their durable names', () => {
    const fileBlock = { type: 'file', attachment: { attachmentId: 'f-1', name: 'notes.md', bytes: 12 } }
    expect(attachmentDescriptors([fileBlock] as unknown as ContentBlock[])).toEqual([
      { kind: 'file', attachmentId: 'f-1', mediaType: 'application/octet-stream', ref: fileBlock.attachment, name: 'notes.md' },
    ])
    const projected = projectSurfaceEvent(surfaceEvent('user/message', { content: [fileBlock, { type: 'text', text: 'see attached' }] }))
    expect(projected?.attachments?.[0]).toMatchObject({ kind: 'file', name: 'notes.md' })
  })
})

describe('parseSessionToken', () => {
  it('accepts uuid-shaped secrets and rejects everything else', () => {
    const uuid = '40884640-d4c1-4ef3-8bd8-1f6ad48a4312'
    expect(parseSessionToken(`${uuid}\n`)).toBe(uuid)
    expect(parseSessionToken(undefined)).toBeUndefined()
    expect(parseSessionToken('')).toBeUndefined()
    expect(parseSessionToken('short')).toBeUndefined()
    expect(parseSessionToken('has space in it and that is not a token at all')).toBeUndefined()
    expect(parseSessionToken('§§not-ascii§§')).toBeUndefined()
  })
})

describe('collapseRetriedUserTurns', () => {
  const user = (text: string, attachments?: ChatItem['attachments']): ChatItem =>
    ({ role: 'user', ...attachments !== undefined ? { attachments } : {}, ...text !== '' ? { text } : {} })

  it('drops the duplicate question of a failed retry (no answer came)', () => {
    const items: ChatItem[] = [user('hi'), user('hi'), { role: 'assistant', text: 'hello there' }]
    expect(collapseRetriedUserTurns(items)).toEqual([user('hi'), { role: 'assistant', text: 'hello there' }])
  })

  it('folds a regenerate to the latest answer', () => {
    const items: ChatItem[] = [
      user('hi'), { role: 'assistant', text: 'first try' }, user('hi'), { role: 'assistant', text: 'second try' },
    ]
    expect(collapseRetriedUserTurns(items)).toEqual([user('hi'), { role: 'assistant', text: 'second try' }])
  })

  it('keeps every turn of distinct questions, repeats included, when content differs', () => {
    const items: ChatItem[] = [user('hi'), { role: 'assistant', text: 'a' }, user('hi again'), { role: 'assistant', text: 'b' }]
    expect(collapseRetriedUserTurns(items)).toEqual(items)
  })

  it('folds repeated retries to the newest answer', () => {
    const items: ChatItem[] = [
      user('q'), { role: 'assistant', text: 'one' }, user('q'), { role: 'assistant', text: 'two' },
      user('q'), { role: 'assistant', text: 'three' },
    ]
    expect(collapseRetriedUserTurns(items)).toEqual([user('q'), { role: 'assistant', text: 'three' }])
  })

  it('a retry supersedes later distinct exchanges, keeping only the newest tail', () => {
    const items: ChatItem[] = [
      user('a'), { role: 'assistant', text: '1' }, user('b'), { role: 'assistant', text: '2' },
      user('a'), { role: 'assistant', text: 'retry answer' },
    ]
    expect(collapseRetriedUserTurns(items)).toEqual([
      user('a'), { role: 'assistant', text: 'retry answer' },
    ])
  })

  it('compares attachments as part of the question identity', () => {
    const a = [{ attachmentId: 'a', kind: 'image' as const, mediaType: 'image/png', ref: { id: 'a' } }]
    const b = [{ attachmentId: 'b', kind: 'image' as const, mediaType: 'image/png', ref: { id: 'b' } }]
    const items: ChatItem[] = [user('', a), { role: 'assistant', text: 'x' }, user('', b)]
    expect(collapseRetriedUserTurns(items)).toEqual(items)
    expect(collapseRetriedUserTurns([user('', a), user('', a)])).toEqual([user('', a)])
    expect(collapseRetriedUserTurns([])).toEqual([])
  })

  it('ignores the reply quote when identifying a retried question', () => {
    const withQuote = (text: string): ChatItem =>
      ({ role: 'user', text, replyTo: { role: 'assistant', text: 'earlier' } })
    const items: ChatItem[] = [withQuote('hi'), withQuote('hi'), { role: 'assistant', text: 'hello' }]
    expect(collapseRetriedUserTurns(items)).toEqual([withQuote('hi'), { role: 'assistant', text: 'hello' }])
  })

  it('keeps compaction checkpoint rows untouched while folding retries', () => {
    const items: ChatItem[] = [
      { role: 'compaction', text: 'summary of early turns' },
      user('hi'), user('hi'),
      { role: 'assistant', text: 'hello' },
    ]
    expect(collapseRetriedUserTurns(items)).toEqual([
      { role: 'compaction', text: 'summary of early turns' },
      user('hi'),
      { role: 'assistant', text: 'hello' },
    ])
  })
})

describe('TitleSnapshotCache', () => {
  it('serves a set snapshot while fresh and drops it past the ttl', () => {
    const cache = new TitleSnapshotCache(1_000, 8)
    cache.set('s1', { text: 'Hello', updatedAt: 10 }, 0)
    expect(cache.get('s1', 500)).toEqual({ text: 'Hello', updatedAt: 10 })
    expect(cache.get('s1', 1_000)).toBeUndefined()
    expect(cache.get('s1', 1_500)).toBeUndefined()
  })

  it('caches an explicit no-title snapshot distinctly from unknown', () => {
    const cache = new TitleSnapshotCache(1_000, 8)
    expect(cache.get('s1', 0)).toBeUndefined()
    cache.set('s1', { text: undefined, updatedAt: 0 }, 0)
    expect(cache.get('s1', 0)).toEqual({ text: undefined, updatedAt: 0 })
  })

  it('delete() drops a fresh snapshot immediately', () => {
    const cache = new TitleSnapshotCache(60_000, 8)
    cache.set('s1', { text: 't', updatedAt: 1 }, 0)
    cache.delete('s1')
    expect(cache.get('s1', 1)).toBeUndefined()
  })

  it('retires the stalest entry at the cap but refreshes in place', () => {
    const cache = new TitleSnapshotCache(60_000, 3)
    cache.set('a', { text: 'a', updatedAt: 0 }, 0)
    cache.set('b', { text: 'b', updatedAt: 0 }, 0)
    cache.set('c', { text: 'c', updatedAt: 0 }, 0)
    cache.set('a', { text: 'a2', updatedAt: 5 }, 10)
    cache.set('d', { text: 'd', updatedAt: 0 }, 20)
    expect(cache.get('b', 20)).toBeUndefined()
    expect(cache.get('a', 20)).toEqual({ text: 'a2', updatedAt: 5 })
    expect(cache.get('d', 20)).toEqual({ text: 'd', updatedAt: 0 })
  })
})

describe('SessionListingCache', () => {
  it('serves the cached listing until the ttl lapses', () => {
    const cache = new SessionListingCache<number[]>(2_000)
    expect(cache.get(0)).toBeUndefined()
    cache.set([1, 2], 0)
    expect(cache.get(1_999)).toEqual([1, 2])
    expect(cache.get(2_000)).toBeUndefined()
  })

  it('clear() forces a refetch of a fresh listing', () => {
    const cache = new SessionListingCache<number[]>(60_000)
    cache.set([1], 0)
    expect(cache.get(1)).toEqual([1])
    cache.clear()
    expect(cache.get(1)).toBeUndefined()
  })
})

describe('parseAttachmentRef', () => {
  const imageRef = { attachmentId: 'img-1', mediaType: 'image/png', bytes: 70, width: 1, height: 1 }
  const fileRef = { attachmentId: 'abc', name: 'clip.mp4', bytes: 1690 }

  it('accepts a well-formed image reference', () => {
    expect(parseAttachmentRef({ kind: 'image', ref: imageRef })).toEqual({ kind: 'image', ref: imageRef })
  })

  it('accepts video and file references, video with its media type', () => {
    expect(parseAttachmentRef({ kind: 'video', mediaType: 'video/mp4', ref: fileRef }))
      .toEqual({ kind: 'video', mediaType: 'video/mp4', ref: fileRef })
    expect(parseAttachmentRef({ kind: 'file', ref: fileRef })).toEqual({ kind: 'file', ref: fileRef })
  })

  it('rejects malformed payloads with pointed errors', () => {
    expect(() => parseAttachmentRef('nope')).toThrow('must be an object')
    expect(() => parseAttachmentRef({ kind: 'image' })).toThrow('ref must be an object')
    expect(() => parseAttachmentRef({ kind: 'image', ref: { attachmentId: 'x' } })).toThrow('durable storage reference')
    expect(() => parseAttachmentRef({ kind: 'audio', ref: fileRef })).toThrow('image, video, or file')
    expect(() => parseAttachmentRef({ kind: 'image', ref: { attachmentId: 'x', bytes: 1, mediaType: 'image/bmp', width: 1, height: 1 } }))
      .toThrow('png, jpeg, webp')
    expect(() => parseAttachmentRef({ kind: 'image', ref: { attachmentId: 'x', bytes: 1, mediaType: 'image/png' } }))
      .toThrow('incomplete')
    expect(() => parseAttachmentRef({ kind: 'video', ref: { attachmentId: 'x', bytes: 1, name: 'a' } })).toThrow('video/*')
    expect(() => parseAttachmentRef({ kind: 'video', mediaType: 'video/mp4', ref: { attachmentId: 'x', bytes: 1 } }))
      .toThrow('durable file reference')
  })
})

describe('parseAttachment — oversize rejection before decode', () => {
  it('refuses a payload whose base64 length already exceeds the video cap', () => {
    // 100MB of base64 would decode past 64MB; the pre-decode check refuses
    // it by length alone, so no megabyte-scale decode ever runs.
    const huge = 'A'.repeat(100 * 1024 * 1024)
    expect(() => parseAttachment({ kind: 'video', dataUrl: `data:video/mp4;base64,${huge}` })).toThrow('at most 64MB')
  })
})

describe('InFlightDedup', () => {
  it('joins concurrent callers onto one running start', async () => {
    const dedup = new InFlightDedup<number>()
    let starts = 0
    let release: (() => void) | undefined
    const start = (): Promise<number> => {
      starts += 1
      return new Promise((resolve) => { release = () => { resolve(7) } })
    }
    const first = dedup.run('m', start)
    const second = dedup.run('m', start)
    const third = dedup.run('m', start)
    release?.()
    expect(await first).toBe(7)
    expect(await second).toBe(7)
    expect(await third).toBe(7)
    expect(starts).toBe(1)
  })

  it('clears the slot on settle so the next caller starts fresh', async () => {
    const dedup = new InFlightDedup<number>()
    let starts = 0
    const start = (): Promise<number> => { starts += 1; return Promise.resolve(starts) }
    await expect(dedup.run('a', start)).resolves.toBe(1)
    await expect(dedup.run('a', start)).resolves.toBe(2)
    expect(starts).toBe(2)
  })

  it('a rejected start clears the slot and rejects its joiners', async () => {
    const dedup = new InFlightDedup<number>()
    let starts = 0
    const start = (): Promise<number> => { starts += 1; return Promise.reject(new Error('probe down')) }
    await expect(dedup.run('x', start)).rejects.toThrow('probe down')
    await expect(dedup.run('x', start)).rejects.toThrow('probe down')
    expect(starts).toBe(2)
  })
})

describe('requestChunks', () => {
  /** An async iterable standing in for a request body. */
  async function* bodyOf(chunks: Buffer[]): AsyncGenerator<Buffer> {
    for (const chunk of chunks) yield chunk
  }

  it('yields the body in order while the total stays under the cap', async () => {
    const chunks: Uint8Array[] = []
    for await (const chunk of requestChunks(bodyOf([Buffer.from('ab'), Buffer.from('cd')]) as unknown as IncomingMessage, 4)) {
      chunks.push(chunk)
    }
    expect(chunks.map(chunk => Buffer.from(chunk).toString('utf8'))).toEqual(['ab', 'cd'])
  })

  it('refuses past the cap mid-stream, before the tail is read', async () => {
    const mb = 1024 * 1024
    const collected: number[] = []
    await expect(async () => {
      for await (const chunk of requestChunks(
        bodyOf([Buffer.alloc(3 * mb), Buffer.alloc(3 * mb)]) as unknown as IncomingMessage,
        5 * mb,
      )) {
        collected.push(chunk.byteLength)
      }
    }).rejects.toThrow('upload exceeds the 5MB cap')
    // The over-cap chunk never reaches the store.
    expect(collected).toEqual([3 * mb])
  })
})

describe('parseAttachment — charset scan threshold', () => {
  it('validates charset under 16MB of base64 but trusts the store above it', () => {
    // Under the threshold the full-string scan runs and rejects garbage.
    expect(() => parseAttachment({ kind: 'file', dataUrl: 'data:application/octet-stream;base64,§§§§' }))
      .toThrow('not valid base64')
    // Above it (a video-sized payload) the linear scan is deliberately
    // skipped: the store's own sniffing and digest verification are the
    // semantic checks, and the multi-megabyte regex is not worth its cost.
    const huge = `§${'A'.repeat(16 * 1024 * 1024)}`
    const parsed = parseAttachment({ kind: 'video', dataUrl: `data:video/mp4;base64,${huge}` })
    expect(parsed.kind).toBe('video')
  })
})
