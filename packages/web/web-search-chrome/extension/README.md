# dsh-lean-chat Chrome bridge

A tiny companion extension that runs the chat app's web searches **inside your
Chrome** — with your cookies, your logins, your personalization — and drives a
real tab for the app's browser steps, so the model can read pages as you.

## Install (once)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `extension/` folder

The chat app prints the path in Settings → Search tool → *How to connect*
while it runs. If the app listens on a port other than the default
`3095`, open the extension's **Details → Extension options** and set the
origin there.

Running the extension in several Chrome profiles? Give each one a **profile
label** in its options page (e.g. `personal`, `work`). The app can then pick
which profile a browser step runs in — the right logins, the right accounts.
Unlabeled extensions answer as the default profile.

## What it does

The service worker long-polls the app on loopback
(`GET /api/chrome/next`). Two kinds of jobs arrive:

**Searches** (the `web_search` tool) run without opening any tab:

- Normal queries fetch the results page of the configured engine
  (Google/Bing/DuckDuckGo) with `credentials: 'include'`, so the page is the
  one your logged-in browser would see, and parse the result anchors.
- Queries the model prefixes with `x:` (or `site:x.com`) call X's internal
  search API using the `auth_token`/`ct0` cookies of your signed-in account —
  the same request the site itself makes. `from:me` and other X operators
  work, so it can search your own posts and timeline.

**Browser steps** (the `browser` tool) open a real tab in this window, attach
the Chrome debugger to it, and navigate it to the requested page — so
JavaScript-rendered sites (your X timeline, GitHub, mail, …) load with this
profile's logins. The page is serialized into a compact outline (interactive
elements get `@eN` refs the later actions will target) and posted back to the
app; nothing is clicked or typed in this build. The tab carries the name of
the session the model asked for and is reused across steps. Chrome shows its
usual "started debugging this tab" banner on such tabs — that is the
debugger permission at work, and closing the tab ends it.

Results are posted back to the app on loopback and cited in the chat like any
other source.

## Privacy

- The extension only ever talks to `127.0.0.1`/`localhost` (your app), the
  search/X hosts above, and — for browser steps — whatever page the model
  asked to open, rendered by your own browser.
- Cookies never leave the browser; only the extracted outline crosses to the
  local app.
- There is no analytics and no remote code; remove the extension and nothing
  remains.

## Troubleshooting

- **Settings shows "not connected"** — check `chrome://extensions` says this
  extension is on, and that its options point at the origin the app printed
  (`http://127.0.0.1:3095` by default).
- **X searches report "not logged in"** — sign in to x.com once in this
  profile; the cookies live in the profile, not the extension.
- **Browser steps report the debugger failed** — the debugger permission must
  stay granted in `chrome://extensions`; a tab that shows the debugging banner
  is the one being driven.
