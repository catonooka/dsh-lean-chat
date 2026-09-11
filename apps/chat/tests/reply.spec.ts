/** Unit coverage for the reply snippet helpers: folding, clamping, labels. */

import { describe, expect, it } from 'vitest'
import { REPLY_SNIPPET_MAX, clampReplyText, replyLabel, replyTargetFor } from '../src/reply.ts'

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
    expect(replyLabel('assistant')).toBe('Sato')
  })
})

describe('replyTargetFor', () => {
  it('yields a clamped target for text-bearing user and assistant rows', () => {
    expect(replyTargetFor({ role: 'user', text: '  hello \n world  ' }))
      .toEqual({ role: 'user', text: 'hello world' })
    expect(replyTargetFor({ role: 'assistant', text: 'answer' }))
      .toEqual({ role: 'assistant', text: 'answer' })
  })

  it('clamps long answers to the snippet cap', () => {
    expect(replyTargetFor({ role: 'assistant', text: 'x'.repeat(400) }))
      .toEqual({ role: 'assistant', text: clampReplyText('x'.repeat(400)) })
  })

  it('refuses tool and compaction rows and rows without text', () => {
    expect(replyTargetFor({ role: 'tool', text: 'searched' })).toBeUndefined()
    expect(replyTargetFor({ role: 'compaction', text: 'summary' })).toBeUndefined()
    expect(replyTargetFor({ role: 'user', text: '' })).toBeUndefined()
    expect(replyTargetFor({ role: 'assistant', text: '   \n ' })).toBeUndefined()
    expect(replyTargetFor({ role: 'user' })).toBeUndefined()
  })
})
