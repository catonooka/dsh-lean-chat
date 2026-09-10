// dsh-lean-chat chrome bridge — the page serializer injected into session tabs.
//
// One self-contained function per operation: the service worker ships it into
// the page as '(' + fn.toString() + ')(args)', so a function must not reach
// for anything outside its own scope. The snapshot is a bracket-style outline
// with refs on interactive elements only — that shape measured 51-79% cheaper
// in tokens than full YAML accessibility trees, which is the whole point: the
// observation the model reads back stays small on every step.

// Serialize the current page into a compact outline. Interactive elements get
// `@eN` refs (stashed on the page for the later actuation actions); headings,
// text blocks, and table rows compress to single lines. Output stops at the
// line or character cap and says so.
function snapshotPage(maxLines, maxChars) {
  maxLines = maxLines || 400
  maxChars = maxChars || 12000
  var doc = document
  var refs = new Map()
  var lines = []
  var chars = 0
  var truncated = false
  var refCounter = 0

  function clip(text, cap) {
    var flat = String(text).replace(/\s+/g, ' ').trim()
    return flat.length > cap ? flat.slice(0, cap - 1) + '…' : flat
  }

  function visible(el) {
    if (el.hidden) return false
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false
    if (el.style && el.style.display === 'none') return false
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false
    return true
  }

  var SKIP_TAGS = { script: 1, style: 1, noscript: 1, template: 1, svg: 1, iframe: 1, canvas: 1, link: 1, meta: 1 }

  function roleOf(el) {
    var explicit = el.getAttribute('role')
    if (explicit !== null && explicit !== '') return explicit
    var name = el.tagName.toLowerCase()
    if (name === 'a') return el.getAttribute('href') !== null ? 'link' : null
    if (name === 'button') return 'button'
    if (name === 'select') return 'combobox'
    if (name === 'textarea') return 'textbox'
    if (name === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      return 'textbox'
    }
    if (el.isContentEditable === true || el.getAttribute('contenteditable') === 'true') return 'textbox'
    return null
  }

  function accessibleName(el) {
    var labelledby = el.getAttribute('aria-labelledby')
    if (labelledby !== null && labelledby !== '') {
      var labelled = labelledby.split(/\s+/).map(function (id) { return doc.getElementById(id) })
        .filter(function (node) { return node !== null })
        .map(function (node) { return clip(node.textContent || '', 80) })
        .join(' ')
      if (labelled !== '') return labelled
    }
    var label = el.getAttribute('aria-label')
    if (label !== null && label.trim() !== '') return clip(label, 80)
    if (el.placeholder !== undefined && el.placeholder !== '') return clip(el.placeholder, 80)
    // A submit-style input's value is its whole label.
    if (el.tagName.toLowerCase() === 'input') {
      var inputType = (el.getAttribute('type') || 'text').toLowerCase()
      if ((inputType === 'submit' || inputType === 'button' || inputType === 'reset') && el.value !== undefined && String(el.value) !== '') {
        return clip(String(el.value), 80)
      }
    }
    var id = el.id !== undefined ? String(el.id) : ''
    if (id !== '') {
      try {
        var labeller = doc.querySelector('label[for="' + id.replace(/"/g, '\\"') + '"]')
        if (labeller !== null) return clip(labeller.textContent || '', 80)
      } catch (error) { /* a hostile id is not worth failing the snapshot over */ }
    }
    var text = clip(el.textContent || '', 80)
    if (text !== '') return text
    var title = el.getAttribute('title')
    if (title !== null && title.trim() !== '') return clip(title, 80)
    return ''
  }

  function linkTarget(el) {
    if (el.tagName.toLowerCase() !== 'a') return ''
    var href = el.getAttribute('href') || ''
    if (href === '' || href.charAt(0) === '#') return ''
    try { return new URL(href, doc.baseURI || 'https://x.invalid').href } catch (error) { return '' }
  }

  function emit(line) {
    if (lines.length >= maxLines || chars >= maxChars) {
      truncated = true
      return
    }
    if (lines.length > 0 && lines[lines.length - 1] === line) return
    lines.push(line)
    chars += line.length + 1
  }

  function ownTextOf(el) {
    var parts = []
    for (var index = 0; index < el.childNodes.length; index += 1) {
      var node = el.childNodes[index]
      if (node.nodeType === 3) parts.push(node.nodeValue || '')
    }
    return clip(parts.join(' '), 160)
  }

  function emitTable(table) {
    var rows = table.querySelectorAll('tr')
    for (var r = 0; r < rows.length; r += 1) {
      if (truncated) return
      var cells = []
      var cellEls = rows[r].querySelectorAll('th,td')
      for (var c = 0; c < cellEls.length; c += 1) cells.push(clip(cellEls[c].textContent || '', 60))
      var line = clip(cells.join(' | '), 160)
      if (line !== '') emit('tr: ' + line)
    }
  }

  function walk(el, level) {
    if (truncated) return
    if (!visible(el)) return
    var name = el.tagName.toLowerCase()
    if (SKIP_TAGS[name] === 1) return
    var role = roleOf(el)
    if (role !== null) {
      refCounter += 1
      var ref = '@e' + refCounter
      refs.set(ref, el)
      var named = accessibleName(el)
      var target = linkTarget(el)
      emit('[' + ref + ' ' + role + (named !== '' ? ' "' + named + '"' : '') + ']' + (target !== '' ? ' ' + target : ''))
      // The name already summarizes the element's content; descending would
      // print it twice.
      return
    }
    var levelMatch = /^h([1-6])$/.exec(name)
    if (levelMatch !== null) {
      emit(new Array(Number(levelMatch[1]) + 1).join('#') + ' ' + clip(el.textContent || '', 120))
      return
    }
    if (name === 'table') {
      emitTable(el)
      return
    }
    if (name === 'img') {
      var alt = el.getAttribute('alt')
      if (alt !== null && alt.trim() !== '') emit('img "' + clip(alt, 80) + '"')
      return
    }
    // A label's text is its control's accessible name, already printed with
    // the control — repeating it as a text block is pure duplication.
    if (name === 'label') return
    if (name === 'nav' || name === 'aside' || name === 'footer' || name === 'main') emit(name + ':')
    var own = ownTextOf(el)
    if (own !== '') emit('- ' + own)
    for (var index = 0; index < el.children.length; index += 1) {
      if (truncated) return
      walk(el.children[index], level + 1)
    }
  }

  var body = doc.body
  if (body !== null) walk(body, 0)
  // The marker rides past the line cap on purpose — one line is cheap, and
  // the model needs to know the page continued.
  if (truncated) lines.push('… (+more — narrow the view with extract)')
  var snapshot = lines.join('\n')
  if (snapshot.length > maxChars) {
    snapshot = snapshot.slice(0, maxChars)
    truncated = true
  }
  var scope = typeof window !== 'undefined' ? window : globalThis
  scope.__dsh_refs = refs
  return {
    url: doc.location ? doc.location.href : '',
    title: clip(doc.title || '', 120),
    snapshot: snapshot,
    truncated: truncated,
  }
}

// Pull the page's main readable text. A readability-lite pass: pick the
// content-bearing container, strip the chrome around it, and emit headings
// and text blocks as plain lines. Oversize text keeps its head and tail with
// the middle elided — the model needs the ends far more than the middle.
function extractText(maxChars) {
  maxChars = maxChars || 8000
  var doc = document

  function flat(text) {
    return String(text).replace(/\s+/g, ' ').trim()
  }

  // The container with the most text wins; article/main-role roots get a
  // head start so a nav-heavy shell doesn't beat the real content.
  var best = null
  var bestScore = 0
  var roots = doc.querySelectorAll('article, main, [role="main"], [itemprop="articleBody"], body')
  for (var r = 0; r < roots.length; r += 1) {
    var root = roots[r]
    var text = flat(root.textContent || '')
    var score = text.length * (root.tagName.toLowerCase() === 'body' ? 1 : 3)
    if (score > bestScore) {
      bestScore = score
      best = root
    }
  }
  if (best === null) {
    return { url: doc.location ? doc.location.href : '', title: flat(doc.title || '').slice(0, 120), text: '', truncated: false }
  }

  var clone = best.cloneNode(true)
  var strip = clone.querySelectorAll('script, style, noscript, template, svg, iframe, canvas, nav, aside, footer, header, form, button')
  for (var s = 0; s < strip.length; s += 1) strip[s].remove()

  var lines = []
  var blocks = clone.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, figcaption, td')
  for (var b = 0; b < blocks.length; b += 1) {
    var block = blocks[b]
    var name = block.tagName.toLowerCase()
    // A block that is its parent's whole content (li > p, blockquote > p)
    // would repeat the parent's line; the parent already said it.
    var parent = block.parentElement
    var parentName = parent !== null ? parent.tagName.toLowerCase() : ''
    if ((parentName === 'li' || parentName === 'blockquote' || parentName === 'td') && flat(parent.textContent || '') === flat(block.textContent || '')) continue
    if (name === 'h1' || name === 'h2' || name === 'h3' || name === 'h4' || name === 'h5' || name === 'h6') {
      var level = Number(name.slice(1, 2))
      var line = new Array(level + 1).join('#') + ' ' + flat(block.textContent || '')
      if (line.trim() !== '#') lines.push(line)
    } else if (name === 'li') {
      var item = flat(block.textContent || '')
      if (item !== '') lines.push('- ' + item)
    } else if (name === 'pre') {
      var code = flat(block.textContent || '')
      if (code !== '') lines.push('`' + code.slice(0, 400) + (code.length > 400 ? '…`' : '`'))
    } else {
      var plain = flat(block.textContent || '')
      if (plain !== '') lines.push(plain)
    }
  }
  // Nested blocks (a p inside a li, a heading inside a blockquote) repeat;
  // collapse exact duplicates next to each other.
  var deduped = []
  for (var d = 0; d < lines.length; d += 1) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== lines[d]) deduped.push(lines[d])
  }
  var text = deduped.join('\n')
  var truncated = false
  if (text.length > maxChars) {
    truncated = true
    var head = Math.floor(maxChars * 0.75)
    var tail = Math.floor(maxChars * 0.2)
    text = `${text.slice(0, head)}\n\n[… content elided …]\n\n${text.slice(text.length - tail)}`
  }
  return {
    url: doc.location ? doc.location.href : '',
    title: flat(doc.title || '').slice(0, 120),
    text: text,
    truncated: truncated,
  }
}
