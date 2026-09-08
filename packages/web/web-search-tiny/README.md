# @deepseek-ai/dsh-web-search-tiny

A keyless, SearXNG-style metasearch provider for the DeepSeek Harness web
seam (`ctx.web`), reduced to searching: **DuckDuckGo's HTML results endpoint
merged with Wikipedia's search API** — no API key, no per-search model call,
no result-page fetching.

## How it works

- One DuckDuckGo HTML query (`html.duckduckgo.com/html/`) and one Wikipedia
  API query (`action=query&list=search`) run concurrently, each under its own
  timeout budget (default 10 s).
- DuckDuckGo result anchors are parsed in document order; `uddg` redirect
  hrefs are unwrapped to the real target, ad rows and non-http links are
  dropped, and text fields are entity-decoded.
- Wikipedia hits map to `en.wikipedia.org/wiki/<title>` URLs with
  tag-stripped snippets and the page's last-revision timestamp.
- Results merge — DuckDuckGo order first, Wikipedia appended — deduplicate
  by normalized URL, and cap at the request's `maxResults`.
- One engine failing degrades to the other's results; only a total failure
  raises a structured `WEB_PROVIDER_ERROR`.

## Composition

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: tiny-metasearch
- id: web-search-tiny
  name: '@deepseek-ai/dsh-web-search-tiny'
```

## Config

| Field | Default | Meaning |
|---|---|---|
| `timeoutMs` | `10000` | Per-engine wall-clock budget |
| `wikipedia` | `true` | Query Wikipedia alongside DuckDuckGo |

## Limitations

- Result quality follows the public DuckDuckGo HTML page; it can rate-limit
  or change markup (the parser tolerates misses — Wikipedia keeps results
  flowing).
- DuckDuckGo sources carry no publication date; only Wikipedia sources set
  `publishedAt` (last revision).
- English Wikipedia only; no fetch, no images, no ranking beyond source order.
