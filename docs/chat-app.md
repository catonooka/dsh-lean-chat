# The chat profile: a chat-only web app with a tiny initial context

`dsh --profile chat` serves a minimal ChatGPT-style chat surface built on the
same harness kernel as every other dsh profile — but composed from a
standalone bundle whose explicit goal is the **smallest useful initial model
context**.

## What it is

- **Chat only.** No shell, filesystem tools, skills, subagents, plans, or
  approvals — just a conversation with one DeepSeek model.
- **One internal tool with a built-in keyless search engine.** `web_search`
  (from `dsh-tool-web-search-tiny`) with a single `query` parameter. Before
  searching, an internal search-question generator rewrites the query into a
  standalone search question (one cheap model call, 64-token cap, 8-second
  budget, raw-query fallback). Results come from the **tiny metasearch**
  (`dsh-web-search-tiny`): a SearXNG-style aggregator that queries
  DuckDuckGo's HTML endpoint and Wikipedia's API concurrently, merges,
  deduplicates, and caps — **no API key and no per-search model call**.
  Wikipedia sources carry their last-revision `publishedAt`, every search
  records a `searchedAt` time. Set `DSH_WEB_SEARCH_PROVIDER=deepseek-official`
  to switch to DeepSeek's native server-side search instead (needs
  `DEEPSEEK_API_KEY`).
- **Tiny initial context.** The system prompt is one persona line
  (`DSH_CHAT_PERSONA`, default `You are a helpful assistant.`) plus two
  app-owned lines — a reply-language anchor ("reply in the language of the
  user's most recent message", which stops Chinese-base models drifting to
  Chinese on Sino-Vietnamese input) and the current date (which stops stale
  years in time-relative searches). The only tool schema is the single-param
  `web_search`. No harness identity, runtime context, workspace, or skill
  sections are mounted at all.
- **A clean, minimal UI** (`apps/chat`): a collapsible sidebar (ChatGPT-style,
  toggle in the top bar, state persisted) with New chat, a full-text **search
  chats** box (FTS over message content, snippet rows, cursor-paginated), and
  a conversation list that lazy-loads 20 chats per page on scroll; a centered
  720px thread with streaming, markdown, and expandable search-result chips;
  and a composer with Enter-to-send and a stop button. No visible scrollbars
  anywhere — every region still scrolls.
- **Parallel conversations**: each turn belongs to its session, so switching
  chats or starting a new one mid-stream never stops the old turn — it keeps
  generating in the background (a live marker in the sidebar), and switching
  back restores the same stream where it left off.
- **A settings panel** on the sidebar's user row (bottom-left): model,
  thinking level, temperature, system prompt, theme, and the whole model
  route — base URL (any OpenAI-compatible gateway), API key (stored
  owner-only under the dsh home), and a model picker that loads the
  endpoint's `/models` list. All live, no restart needed.
- **A selectable search tool**: the built-in keyless metasearch, or **your
  own Chrome** — searches then run in your logged-in browser (personalized
  Google, and X through your account when the query is prefixed `x:` or uses
  `site:x.com`). Two engines sit behind the one setting: the **companion
  extension** (invisible, no debug port — see below) and the **CDP engine**
  (Chrome started with `--remote-debugging-port=9222`) as a fallback when the
  extension is not connected. While "Your Chrome" is selected, the settings
  panel shows a live connection row with a one-click **Test search** and the
  exact install steps.
- **A browser tool that is you**: the `browser` tool drives a real tab in
  your own Chrome — with your logins — for pages no search engine can see
  (your X timeline, GitHub, mail). Reading always works (open, snapshot,
  extract, close); click/type/press/scroll/back run only in profiles whose
  user turned actions on. One compact schema, hard-capped observations, and
  multi-profile routing so the model acts in the right identity (see below).

## Run

```sh
export DEEPSEEK_API_KEY=...        # conversation + search + question generator
pnpm install && pnpm run build     # in the repository checkout
pnpm dsh --profile chat            # http://127.0.0.1:3095 (opens the browser)
```

Flags: `--no-open`, `--port <n>`, `--host <h>` (loopback only).

**Access model**: every request must be loopback-local, and the API
(beyond the extension's two bridge routes) also requires this boot's
session cookie — index.html hands it out as an HttpOnly SameSite=Strict
cookie, so the served page authenticates transparently while bare
scripts, other origins, and other installed extensions get 403. The
companion extension passes only on `GET /api/chrome/next` and
`POST /api/chrome/result`; the test probe is rate-limited.

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | API key for the model and question generator |
| `DSH_WEB_SEARCH_PROVIDER` | `tiny-metasearch` | Search engine: keyless tiny metasearch, or `deepseek-official` |
| `DEEPSEEK_BASE_URL` | DeepSeek official | OpenAI-compatible base URL for the conversation adapter (any gateway works) |
| `DSH_CHAT_MODEL` | `deepseek-chat` | Conversation model |
| `DSH_CHAT_PROVIDER` | `deepseek-official` | Conversation provider route |
| `DSH_CHAT_REASONING` | model default | Thinking level: `off`, `low`, `high`, or `max` |
| `DSH_CHAT_TEMPERATURE` | model default | Sampling temperature (0–2), applied to every conversation request |
| `DSH_CHAT_PERSONA` | `You are a helpful assistant.` | The whole system prompt |
| `DSH_CHAT_WEB_ENGINE` | `google` | General engine the user-chrome searches use: `google`, `bing`, or `duckduckgo` |

### Image and video input

The composer grows a clip button once the ability probe says the active
model accepts images or video (the accept list filters to the supported
kinds). Attachments upload as their exact raw bytes — `POST
/api/uploads?kind=…&name=…` with the media type in `content-type` — and
the message send echoes the returned durable reference instead of
re-riding the bytes: images up to 8MB (png/jpeg/webp/gif, byte-sniffed
by the durable store under `$DSH_HOME/attachments`), videos and files
up to 64MB (stored verbatim, streamed straight into the store so
nothing large is ever buffered whole; oversized uploads abort before
their tail is read). The composer previews from a local blob URL and
uploads once on send, so no base64 copy of the file ever sits in page
memory. Model context is unrelated to file size — providers price
video by resolution × duration (a 300KB 4K clip can cost 100K+ tokens
while a 23MB 1080p clip costs ~5K), and some models adapt their frame
sampling to self-cap video tokens. The
model receives them as `image_url`/`video_url` parts; reloaded history
renders attachments from digest-verified storage, streamed to the
socket chunk-by-chunk with backpressure. The profile opts into
`uncataloguedImageInput` on the adapter so custom-gateway models take
attachments instead of placeholder text. (The legacy base64-in-JSON
form still works for old tabs.)

Hovering a message shows its actions **under** the bubble: **copy**
(clipboard with a selection-based fallback), **reply**, and **try again**
on the trailing turn (or a Try-again chip when a turn ends without an
answer). Reply works like mainstream chat apps: it pins the message as a
reply target — a chip above the composer shows who and what (Esc or the
chip's ✕ cancels), and the sent bubble renders a short quote of the
answered message. The quote rides the user message as a `replyTo` sibling
of its content blocks (`{ role, text }`, snippet-clamped to 300 chars):
the append-only ledger stores it verbatim, the `/messages` projection
serves it back, retries carry it through, and the model context built
from `content` never sees it. A retry re-sends the trailing user content
with the same `replyTo` — the durable log keeps every attempt while the
history view folds retried exchanges to their latest answer
(`collapseRetriedUserTurns`).

The sidebar collapses to a small rail that keeps both *open sidebar* and
*new chat* one click away.

### Context management (compaction)

Conversations grow until they would not fit the model's context window.
The chat profile mounts the harness's compaction stack: `token-meter`
(one fold per session, anchored on the gateway's own per-turn usage
numbers) and `compaction-basic` (the summarize-and-replace engine), with
the engine's built-in triggers replaced by chat-owned ones gated on the
settings panel's **Auto-compact** toggle (on by default).

How a compaction runs: before each model call the estimated request is
compared against 0.8 × the window; over the line, the engine keeps a
verbatim tail (~0.16 × the window), asks the model to summarize
everything older, and lands the summary as a replacement user message
(`surfaceOp: replace`) — a durable, provenance-checked transaction in
the append-only ledger. The model reads the summary in place of the
trimmed turns; the full history stays on disk. If a request still
overflows (the gateway's rejection wording is recognized), compaction
runs and the request retries — only when the surface actually shrank,
so unrepairable overflows still surface their error.

The UI shows a muted "Earlier conversation compacted" card where the
trimmed turns were: served by `/messages` after a reload, or right after
the turn that compacted (a `compaction` stream frame makes the client
refetch history once the stream ends — never mid-stream). With the
toggle off, none of this happens: conversations grow until the gateway
rejects them. `POST /api/sessions/:id/compact` compacts on demand
either way — `{ compacted: false }` when there is nothing useful to
reduce.

The window itself comes from the `llm-deepseek` row's
`defaultContextWindow` — 262144, the qwen flash gateway's measured
ceiling (probed: it reports "maximum context length is 262144 tokens"
past it). `DSH_CONTEXT_WINDOW` overrides it for other endpoints.

### The companion extension

`packages/web/web-search-chrome/extension/` is a load-unpacked MV3 extension
whose service worker long-polls the app on loopback (`/api/chrome/next`) and
runs each search **in your browser's cookies** — no tab opens, no debug port,
no relaunch. General queries fetch the engine's results page with your
session; `x:` queries call X's internal search API riding your signed-in
`auth_token`/`ct0` cookies, so `from:me` and other operators search your own
account.

The same connection also serves the **browser tool**: browser jobs open a
real tab in your window, attach the Chrome debugger to it, and navigate it,
so JavaScript-rendered pages load with your logins (Chrome shows its usual
"started debugging this tab" banner while a tab is driven). One tab exists
per named session, steps on it serialize, and tabs idle for ten minutes are
closed automatically. **Actions are a per-profile opt-in**: the extension
options carry an "allow actions in this profile" switch, off by default, so
every profile starts read-only — turn it on for a guest or test profile
first, and click/type/press/scroll/back never run anywhere else.

**Chrome profiles**: load the extension in several profiles and give each a
label in its options page. Labels ride the long-poll (with the actions
flag), jobs can pin to one, and `/api/chrome/status` lists who is connected
and who allows actions — the model picks the right identity (right logins,
right accounts) with the tool's `profile` argument.

Install once: `chrome://extensions` → Developer mode → Load unpacked → the
`extension/` folder (the settings panel's *How to connect* prints the exact
path while the app runs). A different app port goes in the extension's
options page. Details and privacy notes: `extension/README.md`.

The bridge is four local-only routes — `GET /api/chrome/next` (the
long-poll/heartbeat, carrying the profile label), `POST /api/chrome/result`,
`GET /api/chrome/status`, and `POST /api/chrome/test` — served by the app and
consumed by the extension. Without the extension, "Your Chrome" falls back
to the CDP engine (`--remote-debugging-port=9222`) — for searches; browser
steps need the extension.

### The browser tool

`browser` (from `dsh-tool-browser-chrome`) is the second model-facing tool:
it drives the user's own Chrome step by step for pages a search engine
cannot see — their X timeline, their GitHub, their mail. One compact schema
(an `action` enum plus optional `url`, `goal`, `profile`, `session`) keeps
the initial context small, and every observation is hard-capped so steps
stay cheap:

- `status` — list connected Chrome profile labels, each marked with whether
  it allows actions (answered server-side, no extension round trip).
- `open` — navigate a session tab, wait for the render, and return the page
  outline: a bracket-format snapshot where interactive elements carry `@eN`
  refs (refs on interactive elements only measured 51–79% cheaper in tokens
  than YAML accessibility trees; snapshots cap at 400 lines / 12k chars).
- `extract` — the one-step read: with a `url` it navigates first, then
  answers with the page's main text AND its outline together in a single
  trip, refs included for any follow-up action (readability-lite: content
  container picked, page chrome stripped, middle elided past the 8k cap).
  Feed-shaped pages — two or more article siblings, so timelines and boards
  — come back as numbered items capped at thirty, each clipped to 280
  characters, which answers "my first five posts" directly.
- `snapshot` — re-serialize the current page (SPA content that changed).
- `close` — release the session tab.
- `click` / `type` / `press` / `scroll` / `back` — **actuation**, and only
  ever inside a Chrome profile whose user turned actions on for it (the
  extension options carry an off-by-default "allow actions in this profile"
  switch; the poll advertises the state, the bridge routes actuation jobs
  only to opted-in profiles, and the extension refuses them again locally).
  click and type target an `@eN` ref from the session's latest snapshot;
  typing focuses the field with a real click, selects all through the
  platform chord, and inserts the text in one input event. Every actuation
  step returns the fresh page outline, and a stale ref fails with a
  take-a-fresh-snapshot error instead of clicking blindly.

Every step's result renders in the chat as a chip (globe icon, action +
URL, excerpt behind the toggle; actuation steps read Acting/Acted), and the
untrusted-content guard the search tool uses prefixes every observation.

### Settings panel

The user row at the bottom of the sidebar opens the settings panel. It edits
the conversation model route (provider profile, model, thinking level,
temperature) and the system prompt at runtime: `PUT /api/config` validates
the patch, persists it to `$DSH_HOME/chat-settings.json`, and applies it from
the next message on — a model change swaps the session's agent while its
durable history keeps the conversation. Temperature and the persona apply
immediately (both are evaluated per request). The env vars above are only
the seed defaults for a fresh home; the persisted file wins afterwards.
Theme (system / light / dark) is a browser preference stored client-side.

**Provider profiles**: the panel's Profile row switches between saved
endpoints, each with a user-chosen name and its own model, base URL, and
API key (rename / new / delete in the row; the rows below edit whichever
profile is selected). All profiles ride the same OpenAI-compatible adapter
route — the fixed `provider` field is registry plumbing, not a choice. A
legacy flat settings file migrates onto one profile named after its
gateway's host.

Any OpenAI-compatible gateway can serve the conversation model this way, e.g.
an mLLM endpoint:

```sh
DEEPSEEK_API_KEY=<gateway-key> \
DEEPSEEK_BASE_URL=https://<gateway>/v1 \
DSH_CHAT_MODEL=qwen3.8-flash-next \
DSH_CHAT_REASONING=high \
DSH_CHAT_TEMPERATURE=0.7 \
pnpm dsh --profile chat
```

## Layout

| Piece | Path |
|---|---|
| Bundle (standalone Cordis tree) | `packages/bundle/chat-app` |
| Glue (static dist, `/api`, SSE, browser handoff) | `packages/bundle/chat-app/src/index.ts` |
| Tiny web-search tool | `packages/web/tool-web-search-tiny` |
| Browser tool (user's Chrome, step by step) | `packages/web/tool-browser-chrome` |
| Companion extension + bridge (searches, browser steps) | `packages/web/web-search-chrome` |
| Front end (Vite + React) | `apps/chat` |
| Profile template registration | `PROFILE_TEMPLATES` in `packages/boot/app-boot/src/profile.ts` |

The bundle follows the `sdk-minimal` pattern: it does not layer over
`dsh-base`, so every service row is explicit and nothing optional is mounted.
Sessions persist as JSONL under `$DSH_HOME/sessions` and reuse the standard
format — a chat session opened here is readable by any other dsh surface.

## Wire protocol

The glue serves the built dist on the webserver fallback seat and one API
prefix. All requests must carry a loopback `Host` (and loopback `Origin` when
present); there is no token exchange.

- `GET /api/config` — provider and model
- `GET /api/sessions` — newest-first conversation list with folded titles
- `GET /api/sessions/:id/messages` — projected surface history
- `POST /api/sessions/:id/messages` `{text}` — SSE stream (`user`, `delta`,
  `assistant`, `tool-start`, `tool-end`, `status`, `turn-end`, `error`)
- `POST /api/sessions/:id/stop` — cancel the active turn
- `POST /api/uploads?kind=image|video|file&name=…` — raw-body attachment
  upload; the response's durable `ref` rides the message send

## Performance model

Where the hot paths spend their budget, and what keeps them flat:

- **Sidebar listing** (`GET /api/sessions`): the corpus listing (a directory
  walk plus one header read per session) caches behind a 2s TTL with
  invalidation at every liveness flip this plugin controls (agent mint,
  eviction, model swap); title snapshots — a whole-JSONL parse per cold
  session — cache per session until a `session/title` event lands (only
  live, in-memory sessions invalidate).
- **Attachments**: raw-body uploads stream into the store (`saveFileStream`)
  so a 64MB video never buffers whole; downloads write store chunks
  straight to the socket with backpressure; the composer holds a `File`
  plus a blob-URL preview, never a base64 string.
- **Streaming UI**: the live text lives in a feed outside React state —
  only the streaming row re-renders per 50ms batch, its markdown re-parses
  at a 200ms throttle, and history rows plus the sidebar are memoized so
  typing and streaming leave them untouched.
- **Lifetime**: one plugin teardown retires every agent (per-agent effect
  closures would pin each conversation's event log for the process life);
  the in-memory activity ledger trims to its persisted 500 entries; blob
  URLs are revoked when their rows leave the view.
- **Search**: generated questions cache per raw query (the generator also
  has a 3s budget and fails fast to the raw query), the keyless metasearch
  caches results for 60s, the extension runs up to three searches
  concurrently, backs off failed polls exponentially (letting its service
  worker park), and stops SERP candidate collection once it has enough.
- **Browser steps**: every observation is capped before the model sees it —
  snapshots at 400 lines / 12k chars with refs on interactive elements only
  (bracket format measured 51–79% cheaper than YAML trees), extractions at
  8k chars with middle elision — and steps on one session tab serialize, so
  a long page never floods the conversation.

Known deferred costs (upstream-owned, deliberate): `GET /messages` deep-
clones history through the session-query corpus on every load (a cursor
API belongs upstream), and the FTS search reconciles the corpus per
request (the client debounces at 300ms and the index build is one-time).

## Limitations

- Loopback-only; no auth token (the full `web` profile's browser
  authentication is deliberately not pulled in).
- No session deletion; history full-text search and attachments both
  exist but attachments are capped at one per message.
- Browser actuation (click/type/press/scroll/back) runs only in Chrome
  profiles whose user opted in via the extension options; every profile is
  read-only until then.
- Question generation costs one extra small model request per uncached
  search (disable with `generateQuestion: false` on the
  `tool-web-search-tiny` row).
