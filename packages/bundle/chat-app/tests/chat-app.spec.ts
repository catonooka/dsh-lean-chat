/**
 * Unit coverage for the chat glue's pure history projection.
 */

import { describe, expect, it } from 'vitest'
import { projectSurfaceEvent } from '../src/index.ts'
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
