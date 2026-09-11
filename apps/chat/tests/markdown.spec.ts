import { describe, expect, it } from 'vitest'
import { isSafeHref, renderMarkdown } from '../src/markdown.ts'

describe('isSafeHref', () => {
  it('accepts only http and https URLs, however cased and padded', () => {
    expect(isSafeHref('https://example.com/a?b=1')).toBe(true)
    expect(isSafeHref('http://example.com')).toBe(true)
    expect(isSafeHref('HTTPS://EXAMPLE.COM/PATH')).toBe(true)
    expect(isSafeHref('  https://example.com  ')).toBe(true)
  })

  it('rejects every other scheme and shape', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    expect(isSafeHref('  javascript:alert(1)')).toBe(false)
    expect(isSafeHref('JaVaScRiPt:alert(1)')).toBe(false)
    expect(isSafeHref('data:text/html,<script>')).toBe(false)
    expect(isSafeHref('file:///etc/passwd')).toBe(false)
    expect(isSafeHref('vbscript:msgbox')).toBe(false)
    expect(isSafeHref('/relative/path')).toBe(false)
    expect(isSafeHref('example.com/no-scheme')).toBe(false)
    expect(isSafeHref('')).toBe(false)
    expect(isSafeHref('https:/missing-slash.example.com')).toBe(false)
  })
})

describe('renderMarkdown link safety', () => {
  it('links http(s) URLs and escapes hostile query characters', () => {
    expect(renderMarkdown('[site](https://e.com/a?x=1&y=2)'))
      .toBe('<p><a href="https://e.com/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">site</a></p>')
  })

  it('keeps non-http link targets as literal text', () => {
    expect(renderMarkdown('[click](javascript:alert(1))'))
      .toBe('<p>[click](javascript:alert(1))</p>')
  })

  it('escapes raw HTML instead of passing it through', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>'))
      .toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>')
  })
})
