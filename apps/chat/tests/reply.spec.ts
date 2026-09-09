/** Unit coverage for the reply snippet helpers: folding, clamping, labels. */

import { describe, expect, it } from 'vitest'
import { REPLY_SNIPPET_MAX, clampReplyText, replyLabel } from '../src/reply.ts'

describe('clampReplyText', () => {
  it('keeps short text as-is', () => {
    expect(clampReplyText('hello there')).toBe('hello there')
  })

  it('collapses newlines and repeated whitespace into single spaces', () => {
    expect(clampReplyText('first line\n> second   line\n\n\tthird ')).toBe('first line > second line third')
  })

  it('trims to nothing for whitespace-only text', () => {
    expect(clampReplyText('  \n\t ')).toBe('')
  })

  it('clamps long text to the cap with a trailing ellipsis', () => {
    const text = 'x'.repeat(REPLY_SNIPPET_MAX + 50)
    const clamped = clampReplyText(text)
    expect(clamped.length).toBe(REPLY_SNIPPET_MAX)
    expect(clamped.endsWith('…')).toBe(true)
  })

  it('honors a custom cap', () => {
    expect(clampReplyText('abcdefghij', 5)).toBe('abcd…')
  })

  it('leaves text exactly at the cap untouched', () => {
    const text = 'y'.repeat(REPLY_SNIPPET_MAX)
    expect(clampReplyText(text)).toBe(text)
  })
})

describe('replyLabel', () => {
  it('names the two roles', () => {
    expect(replyLabel('user')).toBe('You')
    expect(replyLabel('assistant')).toBe('dsh chat')
  })
})
