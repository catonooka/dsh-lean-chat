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
  (`DSH_CHAT_PERSONA`, default `You are a helpful assistant.`) and the only
  tool schema is the single-param `web_search`. No harness identity, runtime
  context, workspace, or skill sections are mounted at all.
- **A clean, minimal UI** (`apps/chat`): sidebar with the conversation list,
  a centered 720px thread with streaming, markdown, and expandable
  search-result chips, and a composer with Enter-to-send and a stop button.

## Run

```sh
export DEEPSEEK_API_KEY=...        # conversation + search + question generator
pnpm install && pnpm run build     # in the repository checkout
pnpm dsh --profile chat            # http://127.0.0.1:3095 (opens the browser)
```

Flags: `--no-open`, `--port <n>`, `--host <h>` (loopback only).

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
| `DSH_CHAT_PERSONA` | `You are a helpful assistant.` | The whole system prompt; `''` for none |

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

## Limitations

- Loopback-only; no auth token (the full `web` profile's browser
  authentication is deliberately not pulled in).
- No session deletion, no history full-text search, no attachments.
- Question generation costs one extra small model request per search
  (disable with `generateQuestion: false` on the `tool-web-search-tiny` row).
