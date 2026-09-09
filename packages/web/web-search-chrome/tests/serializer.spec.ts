// @vitest-environment jsdom
/**
 * Unit coverage for the page serializer injected into session tabs. The real
 * serializer.js is evaluated and run against a jsdom document, pinning the
 * exact outline format the model reads: bracket lines, refs on interactive
 * elements only, compressed text blocks and table rows, hard caps.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

interface SerializedPage {
  url: string
  title: string
  snapshot: string
  truncated: boolean
}

interface ExtractedPage {
  url: string
  title: string
  text: string
  truncated: boolean
}

interface SerializerBundle {
  snapshotPage: (maxLines?: number, maxChars?: number) => SerializedPage
  extractText: (maxChars?: number) => ExtractedPage
}

// The jsdom environment replaces the global URL, so the extension directory
// resolves from the repo root the suite always runs from.
function loadSerializer(): SerializerBundle {
  const source = readFileSync(join(process.cwd(), 'packages/web/web-search-chrome/extension/serializer.js'), 'utf8')
  return new Function(`${source}\nreturn { snapshotPage, extractText }`)() as SerializerBundle
}

const { snapshotPage, extractText } = loadSerializer()

beforeEach(() => {
  document.body.innerHTML = ''
  document.title = ''
})

describe('serializer snapshotPage', () => {
  it('emits the page header, landmarks, headings, and ref-carrying interactive elements', () => {
    document.title = 'Docs — test'
    document.body.innerHTML = [
      '<h1>Docs</h1>',
      '<nav><a href="/guide">Guide</a><a href="https://ext.example/x">External</a></nav>',
      '<main>',
      '<button aria-label="Sign in">…</button>',
      '<input id="q" placeholder="Search site"><label for="q">Search site</label>',
      '</main>',
    ].join('')
    const page = snapshotPage()
    expect(page.title).toBe('Docs — test')
    expect(page.url).toBe(window.location.href)
    expect(page.truncated).toBe(false)
    expect(page.snapshot).toBe([
      '# Docs',
      'nav:',
      '[@e1 link "Guide"] http://localhost:3000/guide',
      '[@e2 link "External"] https://ext.example/x',
      'main:',
      '[@e3 button "Sign in"]',
      '[@e4 textbox "Search site"]',
    ].join('\n'))
    // The refs are stashed on the page for the later actuation actions.
    const refs = (window as unknown as { __dsh_refs: Map<string, Element> }).__dsh_refs
    expect(refs.get('@e1')).toBe(document.querySelector('a[href="/guide"]'))
    expect(refs.get('@e3')).toBe(document.querySelector('button'))
  })

  it('names elements by aria-label first, then labelled label, then placeholder, then content', () => {
    document.body.innerHTML = [
      '<a href="https://a.example/1" aria-label="Open the guide">click here</a>',
      '<input id="named"><label for="named">Your email</label>',
      '<input placeholder="Type a city">',
      '<a href="https://a.example/2">Plain anchor text</a>',
    ].join('')
    const page = snapshotPage()
    expect(page.snapshot).toBe([
      '[@e1 link "Open the guide"] https://a.example/1',
      '[@e2 textbox "Your email"]',
      '[@e3 textbox "Type a city"]',
      '[@e4 link "Plain anchor text"] https://a.example/2',
    ].join('\n'))
  })

  it('emits text blocks and clips them, skipping hidden and non-visual nodes', () => {
    document.body.innerHTML = [
      '<p>First paragraph.</p>',
      `<p>${'long text '.repeat(40)}</p>`,
      '<p hidden>hidden paragraph</p>',
      '<p style="display: none">css hidden</p>',
      '<p aria-hidden="true">aria hidden</p>',
      '<script>fetch("https://evil.example")</script>',
      '<style>p { color: red }</style>',
      '<img alt="A chart of tokens">',
    ].join('')
    const page = snapshotPage()
    expect(page.snapshot).toBe([
      '- First paragraph.',
      `- ${'long text '.repeat(40).replace(/\s+/g, ' ').trim().slice(0, 159)}…`,
      'img "A chart of tokens"',
    ].join('\n'))
  })

  it('compresses table rows to one line each', () => {
    document.body.innerHTML = [
      '<table><tr><th>Tool</th><th>Tokens</th></tr>',
      '<tr><td>YAML tree</td><td>16044</td></tr>',
      '<tr><td>Bracket lines</td><td>7860</td></tr></table>',
    ].join('')
    const page = snapshotPage()
    expect(page.snapshot).toBe([
      'tr: Tool | Tokens',
      'tr: YAML tree | 16044',
      'tr: Bracket lines | 7860',
    ].join('\n'))
  })

  it('stops at the line cap, marks truncation, and lands the marker line', () => {
    document.body.innerHTML = Array.from({ length: 600 }, (_, index) => `<p>Paragraph ${String(index)}</p>`).join('')
    const page = snapshotPage(50, 12_000)
    expect(page.truncated).toBe(true)
    const lines = page.snapshot.split('\n')
    expect(lines.length).toBeLessThanOrEqual(51)
    expect(lines[lines.length - 1]).toBe('… (+more — narrow the view with extract)')
    expect(lines[0]).toBe('- Paragraph 0')
  })

  it('stops at the character cap and marks truncation', () => {
    document.body.innerHTML = Array.from({ length: 100 }, (_, index) => `<p>Paragraph number ${String(index)} with some words</p>`).join('')
    const page = snapshotPage(400, 300)
    expect(page.truncated).toBe(true)
    expect(page.snapshot.length).toBeLessThanOrEqual(300)
  })

  it('collapses consecutive duplicate lines', () => {
    document.body.innerHTML = '<p>same</p><p>same</p><p>same</p><p>different</p>'
    const page = snapshotPage()
    expect(page.snapshot).toBe('- same\n- different')
  })

  it('leaves bare anchors as plain text and gives no refs to non-interactive spans', () => {
    document.body.innerHTML = '<a id="anchor">Jump target</a><span>just words</span>'
    const page = snapshotPage()
    expect(page.snapshot).toBe('- Jump target\n- just words')
    expect(page.snapshot.includes('@e')).toBe(false)
  })
})

describe('serializer extractText', () => {
  it('keeps the article content and drops the page chrome around it', () => {
    document.title = 'A post'
    document.body.innerHTML = [
      '<nav>Home Search Menu</nav>',
      '<article>',
      '<h2>The finding</h2>',
      '<p>Bracket outlines measured 51-79% cheaper in tokens.</p>',
      '<ul><li>refs on interactive elements only</li><li>minimal attributes</li></ul>',
      '<blockquote><p>Format choices matter.</p></blockquote>',
      '</article>',
      '<footer>© 2026 footer links</footer>',
    ].join('')
    const page = extractText()
    expect(page.title).toBe('A post')
    expect(page.truncated).toBe(false)
    expect(page.text).toBe([
      '## The finding',
      'Bracket outlines measured 51-79% cheaper in tokens.',
      '- refs on interactive elements only',
      '- minimal attributes',
      'Format choices matter.',
    ].join('\n'))
    expect(page.text.includes('Home Search Menu')).toBe(false)
    expect(page.text.includes('footer')).toBe(false)
  })

  it('elides the middle and marks truncation past the cap', () => {
    document.body.innerHTML = `<article>${Array.from({ length: 500 }, (_, index) => `<p>Sentence number ${String(index)} of the long article.</p>`).join('')}</article>`
    const page = extractText(1000)
    expect(page.truncated).toBe(true)
    expect(page.text).toContain('[… content elided …]')
    expect(page.text.length).toBeLessThanOrEqual(1000 + '\n\n[… content elided …]\n\n'.length)
    expect(page.text.startsWith('Sentence number 0')).toBe(true)
    expect(page.text.includes('Sentence number 499')).toBe(true)
    expect(page.text.includes('Sentence number 250')).toBe(false)
  })

  it('fences pre blocks and clips them', () => {
    document.body.innerHTML = '<article><p>Intro.</p><pre>const a = 1\nconst b = 2</pre></article>'
    const page = extractText()
    expect(page.text).toBe('Intro.\n`const a = 1 const b = 2`')
  })

  it('answers empty text for an empty page instead of failing', () => {
    document.body.innerHTML = ''
    const page = extractText()
    expect(page.text).toBe('')
    expect(page.truncated).toBe(false)
  })
})
