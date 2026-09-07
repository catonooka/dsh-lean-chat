# @deepseek-ai/dsh-chat-app

The standalone chat profile bundle: a ChatGPT-style chat-only web surface with
the tiniest useful initial context. Like `dsh-sdk-minimal`, this bundle does
not layer over `dsh-base` — its `cordis.patch.yml` is the complete Cordis tree.

## What it mounts

- One DeepSeek adapter (`dsh-llm-deepseek`, `DEEPSEEK_API_KEY`)
- The minimal agent kernel: `llm`, `session`, `session-projection`,
  `session-title`, `system-prompt`, `tools`, `agent`, `agent-loop`,
  `llm-retry`, and the invariant companions
- JSONL session persistence under `$DSH_HOME/sessions`
- `dsh-session-query-sqlite` with the FTS index closed (`openAt: never`) for
  live-preferred listing, cold history reads, and folded titles
- The web seam plus DeepSeek's native server-side search provider (same
  `DEEPSEEK_API_KEY`)
- Exactly one model-facing tool: `dsh-tool-web-search-tiny`
- The runtime glue (this package): static dist serving, the `/api` routes,
  SSE streaming, the URL line, and the browser handoff

The system prompt is one persona line (`DSH_CHAT_PERSONA`, default
`You are a helpful assistant.`), so the initial model context is that line
plus the single `web_search` tool schema — no tool roster, no workspace
sections, no harness identity, no skills.

## Run

```sh
export DEEPSEEK_API_KEY=...
pnpm run build          # in the repository checkout
pnpm dsh --profile chat [--no-open] [--port 3095]
```

## Config

The glue plugin (`chat-runtime` row) accepts `openBrowser`, `printUrl`,
`provider` (`DSH_CHAT_PROVIDER`, default `deepseek-official`), and `model`
(`DSH_CHAT_MODEL`, default `deepseek-chat`). CLI flags (`--host`, `--port`,
`--no-open`) come from the reused `dsh-web-app/startup` plugin.

## Limitations

- Loopback-only by design; requests with a non-loopback `Host` or `Origin`
  are refused, and there is no token exchange (unlike the full `web` profile).
- No session deletion, no history full-text search, no attachments, no
  settings surface.
