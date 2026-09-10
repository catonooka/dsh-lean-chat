// dsh-lean-chat chrome bridge — the companion extension's service worker.
//
// It long-polls the local chat app for jobs and runs them with this browser's
// own cookies: searches through plain fetches (engines, X's internal API — no
// tab), and browser steps by driving a real tab over the chrome.debugger API,
// so pages render with this profile's logins. Nothing leaves this browser
// except results posted back to the app on loopback.

// The page serializer rides along as a sibling classic script; the guard keeps
// the file loadable outside a worker (unit tests evaluate it directly).
if (typeof importScripts === 'function') importScripts('serializer.js')

const DEFAULT_ORIGIN = 'http://127.0.0.1:3095'
const POLL_WAIT_SECONDS = 25
// The job vocabulary this build speaks. The app gates browser jobs on it:
// a poller without the stamp is a pre-browser search-only build that would
// misread browser steps as searches. v4: debugger commands ride the
// callback form — the promise form never resolves Page.navigate in MV3
// service workers, which left v3 builds unable to navigate. Keep in sync
// with EXTENSION_PROTOCOL in the bridge package.
const PROTOCOL = 4
const SEARCH_FETCH_TIMEOUT_MS = 8000
// Failed-poll backoff: doubling up to half a minute. Past that the idle
// service worker is allowed to die — the 30-second alarm wakes it to retry,
// instead of a fixed 2s loop keeping it alive forever while the app is down.
const BACKOFF_FIRST_MS = 2000
const BACKOFF_MAX_MS = 30000
// Searches may arrive faster than one finishes; run up to this many
// concurrently before the poll loop falls back to running one inline.
const MAX_CONCURRENT_JOBS = 3
// Browser steps wait on real page loads, so they get their own patience.
const PAGE_LOAD_TIMEOUT_MS = 20000
// A hard ceiling on any one browser step: pages can wedge (a navigation
// that never settles, an evaluate that never returns), and a step that
// outlives the app-side timeout is silence. Settling late is worse than
// failing on time, so every step races this deadline and the app's budget
// always stays above it.
const STEP_DEADLINE_MS = 40000
const SNAPSHOT_MAX_LINES = 400
const SNAPSHOT_MAX_CHARS = 12000
const EXTRACT_MAX_CHARS = 8000
// A session tab nobody stepped on for this long gets closed and detached.
const SESSION_IDLE_MS = 10 * 60 * 1000

let origin = DEFAULT_ORIGIN
let clientLabel = ''
// Read-only until this profile's user opts in; the poll advertises the state
// and the bridge only ever routes actuation jobs to opted-in profiles.
let actuationAllowed = false
let polling = false
let runningJobs = 0

/** Flip the actuation opt-in at runtime (settings change, tests). */
function setActuationAllowed(value) {
  actuationAllowed = value === true
}

chrome.storage.local.get({ appOrigin: DEFAULT_ORIGIN, clientLabel: '', actuationAllowed: false }, (stored) => {
  origin = stored.appOrigin
  clientLabel = stored.clientLabel || ''
  actuationAllowed = stored.actuationAllowed === true
  startPolling()
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.appOrigin !== undefined) {
    origin = changes.appOrigin.newValue || DEFAULT_ORIGIN
  }
  if (area === 'local' && changes.clientLabel !== undefined) {
    clientLabel = changes.clientLabel.newValue || ''
  }
  if (area === 'local' && changes.actuationAllowed !== undefined) {
    setActuationAllowed(changes.actuationAllowed.newValue === true)
  }
})

// Chrome parks idle service workers; a 30-second alarm wakes this one so the
// long-poll (and with it the app's "extension connected" heartbeat) resumes —
// and so idle session tabs get reaped.
chrome.alarms.create('dsh-bridge-poll', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => {
  startPolling()
  reapIdleSessions()
})

function startPolling() {
  if (polling) return
  polling = true
  poll()
}

// The profile label this extension runs under, as a query suffix. Unlabeled
// extensions poll as the bridge's default client and serve any read job;
// labeled ones also receive the jobs pinned to their label, the act flag
// says whether this profile's user allows actuation steps at all, and the
// v stamp says which job vocabulary this build speaks.
function clientQuery() {
  const client = clientLabel === '' ? '' : `&client=${encodeURIComponent(clientLabel)}`
  const act = actuationAllowed ? '&act=1' : ''
  return `${client}${act}&v=${String(PROTOCOL)}`
}

async function poll() {
  let backoffMs = 0
  for (;;) {
    try {
      const response = await fetch(`${origin}/api/chrome/next?wait=${String(POLL_WAIT_SECONDS)}${clientQuery()}`, { cache: 'no-store' })
      if (response.ok) {
        const body = await response.json()
        if (body.job !== null && body.job !== undefined) {
          // The search tool is concurrency-safe; overlapping jobs would
          // otherwise queue behind each other and blow the app-side 9s
          // budget. At capacity the poll runs one inline (serial, like
          // before) rather than dropping it.
          if (runningJobs < MAX_CONCURRENT_JOBS) void run(body.job)
          else await run(body.job)
        }
        // A healthy connection resets the failure backoff.
        backoffMs = 0
        continue
      }
    } catch (error) {
      // The app is down or starting; back off below.
    }
    backoffMs = backoffMs === 0 ? BACKOFF_FIRST_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS)
    await sleep(backoffMs)
  }
}

async function run(job) {
  runningJobs += 1
  try {
    let result
    try {
      // Explicit arms: a job this build does not know settles with a loud
      // refusal instead of being misread as a search — silence or a
      // wrong-shaped settlement is how a stale build wastes the app's
      // whole budget per call.
      if (job.type === 'browser') {
        result = { id: job.id, ok: true, browser: await browserStep(job) }
      } else if (job.type === undefined) {
        const sources = job.kind === 'x'
          ? await xSearch(job.query, job.maxResults)
          : await webSearch(job.url, job.maxResults)
        result = { id: job.id, ok: true, sources }
      } else {
        throw new Error(`this extension build cannot run job type "${String(job.type)}" — reload the extension in chrome://extensions`)
      }
    } catch (error) {
      result = { id: job.id, ok: false, error: messageOf(error) }
    }
    try {
      const suffix = clientLabel === '' ? '' : `?client=${encodeURIComponent(clientLabel)}`
      await fetch(`${origin}/api/chrome/result${suffix}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(result),
      })
    } catch (error) {
      // The app went away mid-job; nothing to deliver to.
    }
  } finally {
    runningJobs -= 1
  }
}

// --- Browser steps: a real tab per named session, driven over CDP ----------

// Session name -> { tabId, at } with `at` the last step's timestamp. The map
// is cached from chrome.storage.session so an MV3 worker restart keeps its
// tabs (and the reaper still knows how old they are).
const sessionTabs = new Map()

async function loadSessionTabs() {
  if (sessionTabs.size > 0) return
  const stored = await chrome.storage.session.get({ browserSessions: {} })
  for (const [name, entry] of Object.entries(stored.browserSessions)) {
    if (typeof entry === 'object' && entry !== null && typeof entry.tabId === 'number') {
      sessionTabs.set(name, { tabId: entry.tabId, at: typeof entry.at === 'number' ? entry.at : 0 })
    }
  }
}

async function persistSessionTabs() {
  await chrome.storage.session.set({ browserSessions: Object.fromEntries(sessionTabs) })
}

function touchSession(name) {
  const entry = sessionTabs.get(name)
  if (entry !== undefined) entry.at = Date.now()
}

/** Race one browser step against the hard deadline: a wedged navigation or
 * evaluate must settle as a failure on time, not hold the session lock and
 * queue-block every later step behind it. */
function withStepDeadline(step) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the browser step did not finish within ${String(Math.round(STEP_DEADLINE_MS / 1000))}s — the page never settled`))
    }, STEP_DEADLINE_MS)
    step.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Browser steps on one session tab run one at a time, in arrival order. The
 * deadline races INSIDE the lock: the stored tail settles even when the step
 * itself wedges, so the next step always gets its turn. */
const sessionLocks = new Map()

function withSessionLock(name, task) {
  // The stored tail never rejects, so the next step always gets to run.
  const previous = sessionLocks.get(name) ?? Promise.resolve()
  const gate = previous.then(() => withStepDeadline(task()))
  sessionLocks.set(name, gate.catch(() => {}))
  return gate
}

/** Only real web pages open; everything else (chrome://, file://, js:) stays out. */
function parseWebUrl(candidate) {
  const parsed = new URL(String(candidate))
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http(s) pages can be opened')
  }
  return parsed.href
}

async function sessionTab(name) {
  await loadSessionTabs()
  const existing = sessionTabs.get(name)
  if (existing !== undefined) {
    try {
      await chrome.tabs.get(existing.tabId)
      return existing.tabId
    } catch (error) {
      // The tab is gone (closed, crashed); fall through and mint a fresh one.
      sessionTabs.delete(name)
    }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false })
  sessionTabs.set(name, { tabId: tab.id, at: Date.now() })
  await persistSessionTabs()
  return tab.id
}

async function closeSession(name) {
  await loadSessionTabs()
  const entry = sessionTabs.get(name)
  if (entry === undefined) return
  sessionTabs.delete(name)
  await persistSessionTabs()
  try { await chrome.debugger.detach({ tabId: entry.tabId }) } catch (error) { /* already detached */ }
  try { await chrome.tabs.remove(entry.tabId) } catch (error) { /* already closed */ }
}

/** Close every session tab idle past the budget; runs on the wake alarm. */
async function reapIdleSessions(now = Date.now()) {
  await loadSessionTabs()
  for (const [name, entry] of [...sessionTabs]) {
    if (entry.at > 0 && now - entry.at > SESSION_IDLE_MS) await closeSession(name)
  }
}

async function ensureAttached(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3')
  } catch (error) {
    if (!/already attached/i.test(messageOf(error))) throw error
  }
}

async function sendCommand(tabId, method, params) {
  // The promise form of chrome.debugger.sendCommand never resolves for some
  // commands — Page.navigate among them — inside MV3 service workers, a
  // long-standing Chromium quirk; the tab just stays where it was. The
  // callback form is the reliable path, so every command goes through it.
  return await new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
      const failure = chrome.runtime.lastError
      if (failure !== undefined) reject(new Error(failure.message))
      else resolve(result)
    })
  })
}

async function evaluate(tabId, expression) {
  const response = await sendCommand(tabId, 'Runtime.evaluate', { expression, returnByValue: true })
  if (response === null || response === undefined) return undefined
  if (response.exceptionDetails !== undefined) {
    throw new Error(`page script failed: ${messageOf(response.exceptionDetails.exception ?? response.exceptionDetails.text)}`)
  }
  return response.result !== undefined ? response.result.value : undefined
}

// Poll readiness the way the app's CDP provider does — no event bookkeeping to
// clean up, and a page that never quiets down still snapshots whatever it has.
async function settleLoad(tabId) {
  const deadline = Date.now() + PAGE_LOAD_TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await evaluate(tabId, 'document.readyState === "complete"')) === true) {
      // One settle beat for late hydration to paint the real content.
      await sleep(400)
      return
    }
    await sleep(300)
  }
}

async function observe(tabId) {
  const expression = `(${String(snapshotPage)})( ${String(SNAPSHOT_MAX_LINES)}, ${String(SNAPSHOT_MAX_CHARS)} )`
  const observed = await evaluate(tabId, expression)
  if (observed === null || typeof observed !== 'object') {
    throw new Error('the page did not answer with an observation')
  }
  return observed
}

async function extract(tabId) {
  const expression = `(${String(extractText)})( ${String(EXTRACT_MAX_CHARS)} )`
  const extracted = await evaluate(tabId, expression)
  if (extracted === null || typeof extracted !== 'object') {
    throw new Error('the page did not answer with an extraction')
  }
  // The outline rides along: one trip answers "read this page" with both the
  // content and the refs any follow-up action needs.
  const observed = await observe(tabId)
  return {
    ...observed,
    text: extracted.text,
    truncated: observed.truncated === true || extracted.truncated === true,
  }
}

async function navigateTo(tabId, url) {
  await ensureAttached(tabId)
  await sendCommand(tabId, 'Page.enable', {})
  await sendCommand(tabId, 'Page.navigate', { url })
  await settleLoad(tabId)
}

async function browserStep(job) {
  const session = typeof job.session === 'string' && job.session !== '' ? job.session : 'main'
  if (job.action === 'close') {
    await withSessionLock(session, async () => { await closeSession(session) })
    return { url: '', title: '', truncated: false }
  }
  return await withSessionLock(session, async () => {
    touchSession(session)
    if (job.action === 'open') {
      const url = parseWebUrl(job.url)
      const tabId = await sessionTab(session)
      await navigateTo(tabId, url)
      return await observe(tabId)
    }
    if (job.action === 'snapshot') {
      const tabId = await sessionTab(session)
      await ensureAttached(tabId)
      return await observe(tabId)
    }
    if (job.action === 'extract') {
      const tabId = await sessionTab(session)
      // A URL makes extract self-sufficient: navigate, wait for the render,
      // then read — one round trip for the open-and-read case.
      if (typeof job.url === 'string' && job.url !== '') await navigateTo(tabId, parseWebUrl(job.url))
      return await extract(tabId)
    }
    const tabId = await sessionTab(session)
    await ensureAttached(tabId)
    return await actuationStep(tabId, job)
  })
}

// --- Actuation: real input events through the debugger ---------------------

const ACTUATION_STEP_ACTIONS = new Set(['click', 'type', 'press', 'scroll', 'back'])

/** Named keys a press step may send; everything else fails loudly. */
const PRESS_KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
}

async function actuationStep(tabId, job) {
  let acted
  if (job.action === 'click') acted = () => clickRef(tabId, job.ref)
  else if (job.action === 'type') acted = () => typeIntoRef(tabId, job.ref, job.text)
  else if (job.action === 'press') acted = () => pressKey(tabId, job.key)
  else if (job.action === 'scroll') acted = () => scrollPage(tabId, job.direction)
  else if (job.action === 'back') acted = () => goBack(tabId)
  else throw new Error(`unsupported browser action: ${String(job.action)}`)
  if (!actuationAllowed) {
    throw new Error('actions are not enabled for this Chrome profile — turn them on in the extension options')
  }
  await acted()
  // Whatever the action changed, the model needs the resulting page state.
  await sleep(400)
  return await observe(tabId)
}

/** Where a snapshot ref currently sits, scrolled into view; null when stale. */
async function refCenter(tabId, ref) {
  if (typeof ref !== 'string' || ref === '') throw new Error('this action needs a ref from a snapshot')
  const expression = `/*dsh-ref*/ (() => { const el = window.__dsh_refs && window.__dsh_refs.get(${JSON.stringify(ref)});`
    + ' if (el === undefined || el === null || !el.isConnected) return null;'
    + ' el.scrollIntoView({ block: \'center\' }); const r = el.getBoundingClientRect();'
    + ' return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()'
  const center = await evaluate(tabId, expression)
  if (center === null || typeof center !== 'object') {
    throw new Error(`ref ${ref} is not on the page — take a fresh snapshot and use its refs`)
  }
  return center
}

async function dispatchClick(tabId, x, y) {
  const base = { x, y, button: 'left', clickCount: 1 }
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

async function clickRef(tabId, ref) {
  const { x, y } = await refCenter(tabId, ref)
  await dispatchClick(tabId, x, y)
}

async function typeIntoRef(tabId, ref, text) {
  if (typeof text !== 'string' || text === '') throw new Error('the type action needs text')
  const { x, y } = await refCenter(tabId, ref)
  // Focus the field with a real click, then replace its content wholesale:
  // select-all through the platform chord, then insert the text in one go
  // (Input.insertText rides the input events every framework listens to).
  await dispatchClick(tabId, x, y)
  const modifier = await evaluate(tabId, '/*dsh-mod*/ (navigator.platform || "").includes("Mac") ? 4 : 2') === 4 ? 4 : 2
  await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: modifier, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: modifier, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await sendCommand(tabId, 'Input.insertText', { text })
}

async function pressKey(tabId, key) {
  const named = PRESS_KEYS[String(key ?? '').toLowerCase()]
  if (named === undefined) throw new Error(`unsupported key "${String(key)}" — use one of: ${Object.keys(PRESS_KEYS).join(', ')}`)
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: named.key, code: named.code, windowsVirtualKeyCode: named.keyCode,
    ...(named.text !== undefined ? { text: named.text } : {}),
  })
  await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: named.key, code: named.code, windowsVirtualKeyCode: named.keyCode })
}

async function scrollPage(tabId, direction) {
  const center = await evaluate(tabId, '/*dsh-viewport*/ ({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) })')
  const distance = 600
  const deltas = {
    up: { deltaX: 0, deltaY: -distance },
    down: { deltaX: 0, deltaY: distance },
    left: { deltaX: -distance, deltaY: 0 },
    right: { deltaX: distance, deltaY: 0 },
  }
  const delta = deltas[String(direction ?? 'down')]
  if (delta === undefined) throw new Error('the scroll action needs a direction: up, down, left, or right')
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, ...delta })
}

async function goBack(tabId) {
  await evaluate(tabId, '/*dsh-back*/ history.back()')
  await sleep(400)
}

function fetchWithTimeout(url, options) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(SEARCH_FETCH_TIMEOUT_MS) })
}

async function webSearch(url, maxResults) {
  const response = await fetchWithTimeout(url, { credentials: 'include', headers: { accept: 'text/html' } })
  if (!response.ok) throw new Error(`the results page answered ${String(response.status)}`)
  const html = await response.text()
  return parseSerp(html, maxResults * 2)
}

// Results-page parsing without a DOM: engines put each result's link next to
// an <h2>/<h3> heading — either the heading sits inside the anchor (Google,
// DuckDuckGo) or the anchor inside the heading (Bing). Both shapes are
// collected, snippets come from the text that follows the heading block.
// Collection stops once enough candidates are in hand: a megabyte SERP keeps
// its results in the first fraction of the page, and scanning the rest is
// pure service-worker CPU.
function parseSerp(html, limit) {
  const hits = []
  const seen = new Set()
  const anchors = []
  const wanted = limit * 3
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g
  for (let match = anchorRe.exec(html); match !== null; match = anchorRe.exec(html)) {
    if (/<h[23][\s>]/.test(match[2])) anchors.push({ attrs: match[1], body: match[2], after: html.slice(anchorRe.lastIndex, anchorRe.lastIndex + 700) })
    if (anchors.length >= wanted) break
  }
  const headingRe = /<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/g
  for (let match = headingRe.exec(html); match !== null; match = headingRe.exec(html)) {
    const inner = /<a\b([^>]*)>/.exec(match[2])
    if (inner !== null) anchors.push({ attrs: inner[1], body: match[2], after: html.slice(headingRe.lastIndex, headingRe.lastIndex + 700) })
    if (anchors.length >= wanted) break
  }
  for (const anchor of anchors) {
    if (hits.length >= limit) break
    const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(anchor.attrs)
    if (href === null) continue
    const url = unwrap(decodeEntities(href[1] ?? href[2] ?? ''))
    if (!/^https?:/.test(url)) continue
    let host = ''
    try { host = new URL(url).hostname.replace(/^www\./, '') } catch (error) { continue }
    if (host === '' || host.includes('google.') || host === 'bing.com' || host === 'duckduckgo.com') continue
    if (seen.has(url)) continue
    seen.add(url)
    const title = textify(anchor.body).trim()
    if (title === '') continue
    const snippet = textify(anchor.after).trim().slice(0, 240)
    hits.push({ title: title.slice(0, 120), url, ...(snippet !== '' ? { snippet } : {}) })
  }
  return hits
}

// Bing wraps outbound links in /ck/a?u=a1<base64url>; unwrap to the real target.
function unwrap(href) {
  try {
    const parsed = new URL(href, 'https://www.bing.com')
    if (parsed.hostname.replace(/^www\./, '') !== 'bing.com' || parsed.pathname !== '/ck/a') return href
    const wrapped = parsed.searchParams.get('u') ?? ''
    if (!wrapped.startsWith('a1')) return href
    const b64 = wrapped.slice(2).replace(/-/g, '+').replace(/_/g, '/')
    const decoded = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    return /^https?:/.test(decoded) ? decoded : href
  } catch (error) {
    return href
  }
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

function decodeEntities(text) {
  return text.replace(/&([a-z0-9#]+);/gi, (whole, name) => {
    const lower = String(name).toLowerCase()
    if (NAMED_ENTITIES[lower] !== undefined) return NAMED_ENTITIES[lower]
    const numeric = /^#x([0-9a-f]+)$/i.exec(lower)
    if (numeric !== null) {
      const code = Number.parseInt(numeric[1], 16)
      if (code > 0 && code <= 0x10ffff) return String.fromCodePoint(code)
    }
    return whole
  })
}

function textify(fragment) {
  // Drop a tag the window cut in half, blank script/style bodies, turn block
  // boundaries into spaces, and remove the rest without wedging words apart.
  return decodeEntities(
    fragment
      .replace(/<[^>]*$/, '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(?:a|h[1-6]|li|p|div|td|tr)\b[^>]*>|<br\b[^>]*>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  ).replace(/\s+/g, ' ')
}

async function xSearch(query, maxResults) {
  const cookies = [...await chrome.cookies.getAll({ domain: 'x.com' }), ...await chrome.cookies.getAll({ domain: 'twitter.com' })]
  const authToken = cookies.find(cookie => cookie.name === 'auth_token')
  const ct0 = cookies.find(cookie => cookie.name === 'ct0')
  if (authToken === undefined) throw new Error('not logged in to x.com — sign in once in this Chrome profile')
  const bearer = await xBearer()
  const url = 'https://x.com/i/api/2/search/adaptive.json'
    + `?q=${encodeURIComponent(query)}&query_source=typed_query&count=20`
    + '&spelling_corrections=0&tweet_search_mode=live'
  const response = await fetchWithTimeout(url, {
    credentials: 'include',
    headers: {
      authorization: `Bearer ${bearer}`,
      'x-csrf-token': ct0 === undefined ? '' : ct0.value,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
    },
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error('X rejected the search with stale credentials — open x.com once, then retry')
  }
  if (!response.ok) throw new Error(`X search answered ${String(response.status)}`)
  return parseAdaptive(await response.json(), maxResults)
}

function parseAdaptive(body, limit) {
  const tweets = (body && body.globalObjects && body.globalObjects.tweets) || {}
  const users = (body && body.globalObjects && body.globalObjects.users) || {}
  // An unparsable date sorts as the oldest instead of poisoning the comparator with NaN.
  const stamp = tweet => {
    const parsed = Date.parse(tweet.created_at || '')
    return Number.isFinite(parsed) ? parsed : 0
  }
  const ordered = Object.values(tweets).sort((a, b) => stamp(b) - stamp(a))
  const hits = []
  for (const tweet of ordered) {
    if (hits.length >= limit) break
    if (tweet.full_text === undefined || tweet.id_str === undefined) continue
    const user = users[tweet.user_id]
    const screenName = user && user.screen_name !== undefined ? user.screen_name : 'i'
    const text = String(tweet.full_text).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const parsed = stamp(tweet)
    hits.push({
      title: text.slice(0, 80),
      url: `https://x.com/${screenName}/status/${String(tweet.id_str)}`,
      snippet: text.slice(0, 280),
      ...(parsed > 0 ? { publishedAt: new Date(parsed).toISOString().slice(0, 10) } : {}),
    })
  }
  return hits
}

// X's internal API wants the public web-client bearer token. It is baked into
// the site's main bundle, so pull it from there once per browser session
// instead of hardcoding a copy that X rotates.
async function xBearer() {
  const cached = (await chrome.storage.session.get({ xBearer: '' })).xBearer
  if (cached !== '') return cached
  const shell = await fetchWithTimeout('https://x.com/', { credentials: 'include' }).then(response => response.text())
  const script = /(?:src|href)="(https:\/\/abs\.twimg\.com\/res\/web-client\/main\.[a-z0-9]+\.js)"/.exec(shell)
  if (script === null) throw new Error('could not locate X web client script')
  const bundle = await fetchWithTimeout(script[1]).then(response => response.text())
  const bearer = /AAAAAAAA[A-Za-z0-9%]{40,}/.exec(bundle)
  if (bearer === null) throw new Error('could not find X web client token')
  await chrome.storage.session.set({ xBearer: bearer[0] })
  return bearer[0]
}

function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
