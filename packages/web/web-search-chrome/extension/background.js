// dsh-lean-chat chrome bridge — the companion extension's service worker.
//
// It long-polls the local chat app for search jobs and runs them with this
// browser's own cookies: general engines through a plain fetch of the results
// page, X through its internal search API. No tab ever opens, and nothing
// leaves this browser except the search results posted back to the app on
// loopback.

const DEFAULT_ORIGIN = 'http://127.0.0.1:3095'
const POLL_WAIT_SECONDS = 25
const SEARCH_FETCH_TIMEOUT_MS = 8000

let origin = DEFAULT_ORIGIN
let polling = false

chrome.storage.local.get({ appOrigin: DEFAULT_ORIGIN }, (stored) => {
  origin = stored.appOrigin
  startPolling()
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.appOrigin !== undefined) {
    origin = changes.appOrigin.newValue || DEFAULT_ORIGIN
  }
})

// Chrome parks idle service workers; a 30-second alarm wakes this one so the
// long-poll (and with it the app's "extension connected" heartbeat) resumes.
chrome.alarms.create('dsh-bridge-poll', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => { startPolling() })

function startPolling() {
  if (polling) return
  polling = true
  poll()
}

async function poll() {
  for (;;) {
    try {
      const response = await fetch(`${origin}/api/chrome/next?wait=${String(POLL_WAIT_SECONDS)}`, { cache: 'no-store' })
      if (response.ok) {
        const body = await response.json()
        if (body.job !== null && body.job !== undefined) await run(body.job)
        // An empty long-poll just lapsed; reconnect immediately.
        continue
      }
    } catch (error) {
      // The app is down or starting; back off briefly.
    }
    await sleep(2000)
  }
}

async function run(job) {
  let result
  try {
    const sources = job.kind === 'x'
      ? await xSearch(job.query, job.maxResults)
      : await webSearch(job.url, job.maxResults)
    result = { id: job.id, ok: true, sources }
  } catch (error) {
    result = { id: job.id, ok: false, error: messageOf(error) }
  }
  try {
    await fetch(`${origin}/api/chrome/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
    })
  } catch (error) {
    // The app went away mid-job; nothing to deliver to.
  }
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
function parseSerp(html, limit) {
  const hits = []
  const seen = new Set()
  const anchors = []
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g
  for (let match = anchorRe.exec(html); match !== null; match = anchorRe.exec(html)) {
    if (/<h[23][\s>]/.test(match[2])) anchors.push({ attrs: match[1], body: match[2], after: html.slice(anchorRe.lastIndex, anchorRe.lastIndex + 700) })
  }
  const headingRe = /<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/g
  for (let match = headingRe.exec(html); match !== null; match = headingRe.exec(html)) {
    const inner = /<a\b([^>]*)>/.exec(match[2])
    if (inner !== null) anchors.push({ attrs: inner[1], body: match[2], after: html.slice(headingRe.lastIndex, headingRe.lastIndex + 700) })
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
  return decodeEntities(fragment.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ')
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
  const ordered = Object.values(tweets).sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''))
  const hits = []
  for (const tweet of ordered) {
    if (hits.length >= limit) break
    if (tweet.full_text === undefined || tweet.id_str === undefined) continue
    const user = users[tweet.user_id]
    const screenName = user && user.screen_name !== undefined ? user.screen_name : 'i'
    const text = String(tweet.full_text).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const stamp = Date.parse(tweet.created_at || '')
    hits.push({
      title: text.slice(0, 80),
      url: `https://x.com/${screenName}/status/${String(tweet.id_str)}`,
      snippet: text.slice(0, 280),
      ...(Number.isFinite(stamp) ? { publishedAt: new Date(stamp).toISOString().slice(0, 10) } : {}),
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
