/**
 * Unit coverage for the copy helper: async-clipboard preference, the
 * selection-based fallback when that API is missing or denied, and the copy
 * length bound. The DOM surface is stubbed per test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { COPY_MAX_CHARS, copyToClipboard } from '../src/clipboard.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('copyToClipboard', () => {
  it('prefers the async clipboard API and reports success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copyToClipboard('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to a selection copy when the API rejects', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    const area = {
      value: '',
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
      remove: vi.fn(),
    }
    vi.stubGlobal('document', {
      createElement: () => area,
      body: { append: vi.fn() },
      execCommand: vi.fn(() => true),
    })
    await expect(copyToClipboard('hello')).resolves.toBe(true)
    expect(area.value).toBe('hello')
    expect(area.remove).toHaveBeenCalled()
  })

  it('reports failure when both paths fail', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', {
      createElement: () => ({ style: {}, setAttribute: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn(), remove: vi.fn() }),
      body: { append: vi.fn() },
      execCommand: vi.fn(() => false),
    })
    await expect(copyToClipboard('hello')).resolves.toBe(false)
  })

  it('bounds the text it places on the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await copyToClipboard('x'.repeat(COPY_MAX_CHARS + 10))
    expect(writeText.mock.calls[0]?.[0]).toHaveLength(COPY_MAX_CHARS)
  })
})
