/**
 * Tiny, dependency-free, safe markdown renderer for assistant messages.
 * Everything is HTML-escaped first; the transforms then emit a fixed tag
 * vocabulary (no raw HTML ever passes through). Covers the chat essentials:
 * fenced code blocks, inline code, bold, italic, links, headings, lists,
 * blockquotes, and paragraphs.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

/** Whether a URL may be navigated to: http(s) only, so tool- and model-fed
 * links can never smuggle `javascript:` or other schemes into the page. */
export function isSafeHref(url: string): boolean {
  return /^https?:\/\//iu.test(url.trim())
}

/** Validate a markdown link URL for placement in an href. The input arrives
 * already HTML-escaped (renderMarkdown escapes first), so no further escaping
 * happens — re-escaping would corrupt `&` into `&amp;amp;` in the href. */
function safeHref(url: string): string | undefined {
  return isSafeHref(url) ? url.trim() : undefined
}

/** Inline transforms over one already-escaped line. */
function renderInline(escaped: string): string {
  // Inline code first: its content must not receive further transforms.
  let out = ''
  let rest = escaped
  for (;;) {
    const match = rest.match(/`([^`]+)`/u)
    if (match === null || match.index === undefined) break
    out += transformRest(rest.slice(0, match.index))
    out += `<code>${match[1] ?? ''}</code>`
    rest = rest.slice(match.index + match[0].length)
  }
  return out + transformRest(rest)
}

/** Bold, italic, and links over code-free escaped text. */
function transformRest(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu, (whole, label: string, url: string) => {
      const href = safeHref(url)
      return href === undefined ? whole : `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
    })
    .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?:;]|$)/gu, '$1<em>$2</em>')
}

/** Whether one line is a GFM table delimiter row (`|---|:--:|` and friends). */
function isDelimiterRow(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}\s*:?(\s*\|\s*:?-{1,}\s*?:?)*\|?\s*$/u.test(line)
}

/** Split one table row into trimmed cells; `\|` stays one cell. */
function splitRow(line: string): string[] {
  return line
    .replace(/\\\|/gu, '\u0000')
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map(cell => cell.replace(/\u0000/gu, '|').trim())
}

/** Column alignment read from one delimiter cell (`:--` left, `--:` right, `:-:` center). */
function alignOf(delimiterCell: string): 'left' | 'center' | 'right' {
  const left = delimiterCell.startsWith(':')
  const right = delimiterCell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  return 'left'
}

/** Render one GFM table as a safe, horizontally scrollable HTML table. */
function renderTable(header: string[], delimiters: string[], rows: string[][]): string {
  const head = header
    .map((cell, index) => `<th style="text-align:${alignOf(delimiters[index] ?? '')}">${renderInline(cell)}</th>`)
    .join('')
  const body = rows
    .map(row => `<tr>${row.map((cell, index) => `<td style="text-align:${alignOf(delimiters[index] ?? '')}">${renderInline(cell)}</td>`).join('')}</tr>`)
    .join('')
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}

/** Whether a table starts at `index`: a pipe line whose next line is a delimiter row. */
function startsTable(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? ''
  return line.includes('|') && isDelimiterRow(lines[index + 1] ?? '')
}

/** Render one fenced-block-split segment of block-level markdown. */
function renderBlocks(segment: string): string {
  const lines = segment.split('\n')
  const html: string[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | undefined

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    html.push(`<p>${renderInline(paragraph.join('\n')).replace(/\n/gu, '<br>')}</p>`)
    paragraph = []
  }
  const flushList = (): void => {
    if (list === undefined) return
    const tag = list.ordered ? 'ol' : 'ul'
    html.push(`<${tag}>${list.items.map(item => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`)
    list = undefined
  }

  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] ?? '').replace(/\s+$/u, '')
    if (line === '') {
      flushParagraph()
      flushList()
      continue
    }
    if (startsTable(lines, index)) {
      flushParagraph()
      flushList()
      const header = splitRow(line)
      const delimiters = splitRow(lines[index + 1] ?? '')
      index += 2
      const rows: string[][] = []
      while (index < lines.length) {
        const row = lines[index] ?? ''
        if (row.trim() === '' || !row.includes('|')) break
        rows.push(splitRow(row))
        index += 1
      }
      index -= 1
      html.push(renderTable(header, delimiters, rows))
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/u)
    if (heading !== null && heading.index === 0) {
      flushParagraph()
      flushList()
      const level = Math.min((heading[1] ?? '').length + 1, 5)
      html.push(`<h${String(level)}>${renderInline(heading[2] ?? '')}</h${String(level)}>`)
      continue
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/u)
    if (bullet !== null) {
      flushParagraph()
      if (list?.ordered === true) flushList()
      list ??= { ordered: false, items: [] }
      list.items.push(bullet[1] ?? '')
      continue
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/u)
    if (ordered !== null) {
      flushParagraph()
      if (list?.ordered === false) flushList()
      list ??= { ordered: true, items: [] }
      list.items.push(ordered[1] ?? '')
      continue
    }
    const quote = line.match(/^&gt;\s?(.*)$/u)
    if (quote !== null) {
      flushParagraph()
      flushList()
      html.push(`<blockquote><p>${renderInline(quote[1] ?? '')}</p></blockquote>`)
      continue
    }
    if (/^\s*(?:---|\*\*\*|___)\s*$/u.test(line)) {
      flushParagraph()
      flushList()
      html.push('<hr>')
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  return html.join('')
}

/** Render a markdown source string to a safe HTML fragment. */
export function renderMarkdown(source: string): string {
  const escaped = escapeHtml(source.replace(/\r\n?/gu, '\n'))
  const html: string[] = []
  let rest = escaped
  for (;;) {
    const fence = rest.match(/^```[^\n]*\n([\s\S]*?)(?:^```|$)/mu)
    if (fence === null || fence.index === undefined) break
    if (fence.index > 0) html.push(renderBlocks(rest.slice(0, fence.index)))
    html.push(`<pre><code>${fence[1] ?? ''}</code></pre>`)
    rest = rest.slice(fence.index + fence[0].length)
  }
  html.push(renderBlocks(rest))
  return html.join('')
}
