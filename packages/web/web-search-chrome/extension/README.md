# dsh-lean-chat Chrome bridge

A tiny companion extension that runs the chat app's web searches **inside your
Chrome** — with your cookies, your logins, your personalization — without a
debug port and without ever opening a tab.

## Install (once)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `extension/` folder

The chat app prints the path in Settings → Search tool → *How to connect*
while it runs. If the app listens on a port other than the default
`3095`, open the extension's **Details → Extension options** and set the
origin there.

## What it does

The service worker long-polls the app on loopback
(`GET /api/chrome/next`). When the model runs a `web_search`:

- Normal queries fetch the results page of the configured engine
  (Google/Bing/DuckDuckGo) with `credentials: 'include'`, so the page is the
  one your logged-in browser would see, and parse the result anchors.
- Queries the model prefixes with `x:` (or `site:x.com`) call X's internal
  search API using the `auth_token`/`ct0` cookies of your signed-in account —
  the same request the site itself makes. `from:me` and other X operators
  work, so it can search your own posts and timeline.

Results are posted back to the app on loopback and cited in the chat like any
other source.

## Privacy

- The extension only ever talks to `127.0.0.1`/`localhost` (your app) and the
  search/X hosts above.
- Search queries go to the engine you configured; cookies never leave the
  browser — only extracted result titles/URLs/snippets cross to the local app.
- There is no analytics, no remote code, and no content-script access to your
  pages; remove the extension and nothing remains.

## Troubleshooting

- **Settings shows "not connected"** — check `chrome://extensions` says this
  extension is on, and that its options point at the origin the app printed
  (`http://127.0.0.1:3095` by default).
- **X searches report "not logged in"** — sign in to x.com once in this
  profile; the cookies live in the profile, not the extension.
