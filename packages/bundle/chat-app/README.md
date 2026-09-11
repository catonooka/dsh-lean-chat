---
description: "The chat profile bundle behind Sato: a lean, chat-only web app with user profiles, model characters, and durable sessions, for users running the dsh chat surface."
kind: "package-bundle"
---

# @deepseek-ai/dsh-chat-app

## Summary

Run `dsh --profile chat` and a ChatGPT-style chat surface opens on loopback: streamed
conversations with tool chips, a searchable session sidebar, attachments, user profiles,
and switchable model characters — each with their own persona, greeting, and avatar —
backed by the same DeepSeek adapter seam as the rest of dsh. Like `dsh-sdk-minimal`,
this bundle does not layer over `dsh-base`: its `cordis.patch.yml` is the complete
Cordis tree, so the initial model context stays tiny. Every API route sits behind a
boot-minted session cookie (loopback Host/Origin fence, constant-time compare), the
API key never leaves the server, and all secrets-bearing files persist atomically
owner-only under `$DSH_HOME`.

## Table of Contents

- [Use this package](#use-this-package)
- [What it mounts](#what-it-mounts)
- [Security posture](#security-posture)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

```sh
export DEEPSEEK_API_KEY=...
pnpm run build          # in the repository checkout
pnpm dsh --profile chat [--no-open] [--port 3095]
```

Settings live in `$DSH_HOME/chat-settings.json` and are edited from the in-app panel:
provider profiles (the "model characters"), model, base URL, API key, thinking level,
temperature, system prompt, welcome question, avatars, search tool, and auto-compact.
Everything applies on the next message without a restart.

## What it mounts

- One DeepSeek adapter (`dsh-llm-deepseek`, `DEEPSEEK_API_KEY`)
- The minimal agent kernel: `llm`, `session`, `session-projection`, `session-title`,
  `system-prompt`, `tools`, `agent`, `agent-loop`, `llm-retry`, and the invariant
  companions
- JSONL session persistence under `$DSH_HOME/sessions`
- `dsh-session-query-sqlite` with the FTS index closed (`openAt: never`) for
  live-preferred listing, cold history reads, folded titles, and sidebar search
- The web seam, the tiny built-in metasearch, and the user's-Chrome search provider
  (companion extension preferred, CDP fallback)
- Model-facing tools: web search plus the Chrome browser tool
- The runtime glue (this package): static dist serving with ETag revalidation,
  the `/api` routes, SSE streaming with keepalive and bounded backpressure, the
  URL line, and the browser handoff

## Security posture

- Loopback-only by design; requests with a non-loopback `Host` or `Origin` are
  refused, and `--host 0.0.0.0` is rejected at startup.
- One boot-minted session token (persisted `0600`, compared in constant time)
  guards every non-bridge API route; `index.html` hands it out as an `HttpOnly`,
  `SameSite=Strict` cookie. The two chrome-bridge routes are the deliberate
  exception — any installed extension can observe search jobs and settle them,
  but nothing else.
- The API key is stored only in `$DSH_HOME/chat-settings.json` (written atomically,
  owner-only) and is never serialized to the browser — the panel sees `apiKeySet`.
  The server does send the key to whichever `baseUrl` the active profile names,
  including plain `http://` (the panel warns); that is the app's trust model for
  self-hosted gateways.
- Assistant markdown is rendered by an escape-first, fixed-vocabulary renderer;
  tool- and search-fed links are gated on http(s)-only schemes; static responses
  carry `nosniff` and frame denial.

## Known Limitations and Deferred Work

- Thinking "off" depends on the gateway: this app sends the DeepSeek
  `thinking: {type: "disabled"}` dialect, and a gateway that ignores it (or forces
  always-on reasoning) keeps thinking behind the "Thinking…" placeholder.
- No multi-device story: one shared token, one acting-user header, advisory user
  profiles.

<a id="dev-note"></a>
## Dev Note

The frontend is `@deepseek-ai/dsh-chat-frontend` (React, vite); build it with
`pnpm run build:chat-web` before launching from a checkout, or the served dist is
stale. Tests: `pnpm vitest run packages/bundle/chat-app` (server units) and
`pnpm vitest run apps/chat` (component specs). The two `writeFileAtomic`/
`persistUsers` round-trip suites pin the on-disk secrets format; the avatar
byte-budget spec in `apps/chat/tests/avatar.spec.ts` guards the tile set against
regrowing past 512 KB total.
