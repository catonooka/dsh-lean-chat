# Sato

A lean, chat-only web app forked from [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(MIT — see [LICENSE](LICENSE) and [README.upstream.md](README.upstream.md) for the upstream project).
The repo was previously `dsh-lean-chat`; GitHub redirects the old URL.

One chat surface, no agent shell: a minimal system prompt, web search, and an
optional browser tool, in a small ChatGPT-style UI you can point at **any
OpenAI-compatible endpoint** — DeepSeek, an mLLM gateway, or a local
Ollama/vLLM.

## Highlights

- **Model characters** — every provider profile is a character: its own name,
  system prompt, welcome question, and a robot avatar (20 tiles, kept apart
  from the users' cat avatars). Tap the bot's avatar mid-conversation to
  switch characters — the running turn finishes where it is, the next message
  runs on the new one. "New character…" clones the current endpoint, key, and
  model so it starts working immediately.
- **User profiles** — named local profiles with cat avatars keep chat lists,
  groups, and Chrome-profile routing apart on one machine. Identity and
  organization, not an authentication boundary: one session token still gates
  the whole app.
- **Tiny model context** — one persona line plus the tool schemas on the wire;
  nothing else mounts.
- **Search your way** — the keyless built-in metasearch, or *Your Chrome*:
  a tiny [companion extension](packages/web/web-search-chrome/extension/README.md)
  runs searches inside your logged-in browser (no debug port, no tab), with a
  CDP fallback; `x:`-prefixed queries search your own X account.
- **A browser tool that is you** — the `browser` tool drives a real tab in
  your own Chrome, with your logins: your X timeline, GitHub, mail — pages
  no search engine can see. Reading always works (open / snapshot / extract
  / close); clicking, typing, scrolling, and key presses run only in Chrome
  profiles where you turned actions on — off by default, per profile. All
  observations are hard-capped, and multi-profile routing keeps the model
  in the right Chrome identity.
- **Multimodal input** — the probe gates a clip button; attach images and
  videos (≤ 8MB / 64MB). Uploads stream as raw bytes straight into durable
  storage and the message carries only a reference; the composer previews
  from a local blob URL, so no base64 copy ever sits in page memory.
- **Clean UI** — collapsible sidebar (with a new-chat rail when collapsed),
  chat-style replies that quote the answered message, per-message
  copy/reply/try-again actions, full-text chat search, lazy-loaded
  history, streaming that re-renders only the growing row, light/dark theme.
- **Parallel conversations** — turns belong to their session: start a new
  chat or switch mid-stream and the old turn keeps generating in the
  background, marked live in the sidebar; come back and it is still
  streaming where it left off.
- **Efficient conversations** — auto-compaction keeps long chats inside the
  model's context window: older turns become a model-readable summary while
  the recent tail stays verbatim (optional in Settings; the full ledger stays
  on disk). The hot paths stay flat too: cached sidebar titles and listings,
  memoized history rows, bounded agent lifetimes, ETag-revalidated assets,
  and search caches with a tight question-generator budget.
- **Hardened localhost surface** — loopback-only (`--host 0.0.0.0` is
  refused); every non-bridge API route requires a boot-minted session token
  compared in constant time, behind a loopback Host/Origin fence. The API key
  is written atomically, owner-only, and never serialized to the browser;
  static responses carry ETag, `nosniff`, and frame denial; model- and
  search-fed links are http(s)-only; SSE streams send a keepalive and close
  a client whose backlog runs unbounded. Extension trust is scoped to
  exactly two bridge routes, and the probe endpoint is rate-limited.

## Run it

Requires Node `^22.19.0 || >=24.0.0` and pnpm (`corepack enable` sorts it).

> **Heads-up:** the install pulls the full upstream monorepo — expect a few
> minutes and a couple of GB in `node_modules`.

```sh
git clone https://github.com/catonooka/Sato.git
cd Sato
pnpm install && pnpm run build

export DEEPSEEK_API_KEY=...        # or skip this and configure in the UI
pnpm dsh --profile chat            # http://127.0.0.1:3095 (opens the browser)
```

Then open **Settings** (user row, bottom-left) to pick your avatar and set up
a provider profile: base URL, API key, and model all live there — plus the
character's system prompt, welcome question, and avatar. Any
OpenAI-compatible gateway works, e.g. `http://localhost:11434/v1` for Ollama.

Useful flags: `--no-open`, `--port <n>`, `--host <h>` (loopback only).
The full environment-variable table and the access model are in
[docs/chat-app.md](docs/chat-app.md).

### Optional: search with your own Chrome

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → `packages/web/web-search-chrome/extension` in this
   checkout (the app's Settings → Search tool → *How to connect* prints the
   exact path while it runs).
3. Pick **Your Chrome** as the search tool. Queries prefixed `x:` search your
   logged-in X; everything else searches the web with your browser's session.
   Different app port? Set it once in the extension's options.

## Develop

```sh
pnpm vitest run packages/bundle/chat-app packages/web packages/llm/llm-deepseek apps/chat   # the fork's suites
pnpm run build:chat-web        # rebuild the frontend after UI edits
pnpm run build:lib:host        # rebuild server libs after bundle edits
```

## Layout

| Path | What it is |
|---|---|
| `packages/bundle/chat-app/` | the chat profile bundle: API routes, SSE, settings, characters, engines |
| `apps/chat/` | the web frontend (React, no runtime deps beyond it) |
| `packages/web/web-search-chrome/` | the user-Chrome search provider + companion extension |
| `packages/web/web-search-tiny/`, `packages/web/tool-web-search-tiny/` | the built-in search engines and tool |
| `docs/chat-app.md` | the chat surface's own documentation |

Everything else is upstream harness, mounted but untouched — see
[README.upstream.md](README.upstream.md). To take future upstream fixes:
`git fetch upstream && git merge upstream/master`.
