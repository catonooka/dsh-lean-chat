/** The chat surface: sidebar of conversations, streamed thread, composer. */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  fetchConfig,
  fetchMessages,
  listSessions,
  searchSessions,
  sendMessage,
  stopSession,
  SESSION_PAGE_SIZE,
  type AppConfig,
  type ChatItem,
  type SearchHit,
  type SessionSummary,
} from './api.ts'
import { renderMarkdown } from './markdown.ts'
import { SettingsPanel, applyTheme, readStoredTheme, storeTheme, type Theme } from './Settings.tsx'
import { AvatarModal } from './AvatarModal.tsx'
import { BOT_AVATAR_SRC, avatarSrc, readStoredAvatar, storeAvatar } from './avatar.ts'
import { DeltaBatcher } from './delta.ts'

const ACTIVE_KEY = 'dsh-chat-active'
const COLLAPSED_KEY = 'dsh-chat-collapsed'

/** Debounce for the sidebar search box. */
const SEARCH_DEBOUNCE_MS = 300

/** Scroll proximity that triggers loading the next list page. */
const LOAD_MORE_TRIGGER_PX = 60

function newSessionId(): string {
  return randomUUID()
}

function relativeDate(createdAt: number): string {
  const date = new Date(createdAt)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function AssistantText({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div className="assistant-text">
      {/* Safe HTML: renderMarkdown escapes everything and emits a fixed tag vocabulary. */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {streaming ? <span className="caret" aria-label="generating" /> : undefined}
    </div>
  )
}

function ToolChip({ item }: { item: ChatItem }): JSX.Element {
  const [open, setOpen] = useState(false)
  const label = item.searchQuestion ?? item.query ?? item.text ?? 'web search'
  const count = item.sources?.length
  return (
    <div className="tool-chip-wrap">
      <button type="button" className="tool-chip" onClick={() => { setOpen(value => !value) }}>
        <svg className="tool-icon" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="tool-label">
          {item.running === true ? 'Searching' : 'Searched'}
          {' · '}
          {label}
        </span>
        {count !== undefined ? <span className="tool-count">{String(count)} results</span> : undefined}
        {item.searchedAt !== undefined ? <span className="tool-time">{new Date(item.searchedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span> : undefined}
      </button>
      {open && item.sources !== undefined && item.sources.length > 0
        ? (
          <ul className="tool-sources">
            {item.sources.map(source => (
              <li key={source.url}>
                <a href={source.url} target="_blank" rel="noopener noreferrer">
                  {source.title ?? source.url}
                </a>
                {source.publishedAt !== undefined ? <span className="tool-time"> · {source.publishedAt}</span> : undefined}
              </li>
            ))}
          </ul>
        )
        : undefined}
    </div>
  )
}

export default function App(): JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searchCursor, setSearchCursor] = useState<string | undefined>(undefined)
  const [searching, setSearching] = useState(false)
  const [activeId, setActiveId] = useState<string>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(ACTIVE_KEY) : null
    return stored ?? newSessionId()
  })
  const [items, setItems] = useState<ChatItem[]>([])
  const [streaming, setStreaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [config, setConfig] = useState<AppConfig | undefined>(undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(readStoredTheme)
  // The avatar is a required pick: null means the chooser modal is up.
  const [avatar, setAvatar] = useState<number | null>(readStoredAvatar)
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSED_KEY) === '1')
  const [error, setError] = useState<string | undefined>(undefined)
  const threadRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const searchActive = debouncedQuery !== ''

  // The first page fills the sidebar; older pages arrive on scroll.
  useEffect(() => {
    listSessions({ limit: SESSION_PAGE_SIZE })
      .then((body) => {
        setSessions(body.sessions)
        setTotal(body.total)
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
    fetchConfig().then(setConfig).catch(() => { /* the header simply stays generic */ })
  }, [])

  // After a turn, reload from the top without shrinking the loaded pages.
  const refreshSessions = useCallback(() => {
    const limit = Math.max(SESSION_PAGE_SIZE, sessions.length)
    listSessions({ limit })
      .then((body) => {
        setSessions(body.sessions)
        setTotal(body.total)
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }, [sessions.length])

  const loadMoreSessions = useCallback(async (): Promise<void> => {
    if (loadingMore || sessions.length >= total) return
    setLoadingMore(true)
    try {
      const body = await listSessions({ limit: SESSION_PAGE_SIZE, offset: sessions.length })
      setSessions((previous) => {
        const known = new Set(previous.map(session => session.id))
        return [...previous, ...body.sessions.filter(session => !known.has(session.id))]
      })
      setTotal(body.total)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, sessions.length, total])

  // Debounce the search box, then swap the list for full-text hits.
  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedQuery(query.trim()) }, SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [query])

  useEffect(() => {
    if (debouncedQuery === '') {
      setHits([])
      setSearchCursor(undefined)
      setSearching(false)
      return undefined
    }
    const controller = new AbortController()
    setSearching(true)
    searchSessions(debouncedQuery)
      .then((body) => {
        if (controller.signal.aborted) return
        setHits(body.hits)
        setSearchCursor(body.nextCursor)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false)
      })
    return () => { controller.abort() }
  }, [debouncedQuery])

  const loadMoreHits = useCallback(async (): Promise<void> => {
    if (searching || searchCursor === undefined || debouncedQuery === '') return
    setSearching(true)
    try {
      const body = await searchSessions(debouncedQuery, searchCursor)
      setHits((previous) => {
        const known = new Set(previous.map(hit => hit.id))
        return [...previous, ...body.hits.filter(hit => !known.has(hit.id))]
      })
      setSearchCursor(body.nextCursor)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSearching(false)
    }
  }, [debouncedQuery, searchCursor, searching])

  const handleListScroll = useCallback((): void => {
    const node = listRef.current
    if (node === null) return
    if (node.scrollTop + node.clientHeight < node.scrollHeight - LOAD_MORE_TRIGGER_PX) return
    if (searchActive) void loadMoreHits()
    else void loadMoreSessions()
  }, [loadMoreHits, loadMoreSessions, searchActive])

  useEffect(() => {
    localStorage.setItem(ACTIVE_KEY, activeId)
  }, [activeId])

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  useEffect(() => {
    applyTheme(theme)
    storeTheme(theme)
  }, [theme])

  // A persisted session's history loads once the session list (or a search
  // hit) confirms the id; a draft (never-sent) session shows an empty thread
  // until its first message makes it known. The cancelled flag keeps rapid
  // switches from racing an older fetch over a newer one.
  const knownSession = sessions.some(session => session.id === activeId)
    || hits.some(hit => hit.id === activeId)
  useEffect(() => {
    if (knownSession) {
      let cancelled = false
      fetchMessages(activeId)
        .then((items) => { if (!cancelled) setItems(items) })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
      return () => { cancelled = true }
    }
    setItems([])
    return undefined
  }, [activeId, knownSession])

  // Track the assistant text of the streaming turn separately so deltas
  // accumulate without rewriting committed history items.
  const [streamText, setStreamText] = useState('')

  // The conversation whose history has already been landed on the bottom.
  const anchoredSessionRef = useRef('')

  useEffect(() => {
    const thread = threadRef.current
    if (thread === null) return
    if (anchoredSessionRef.current !== activeId) {
      // Opening a conversation loads its history with the view at the top;
      // land on the newest message instead of the oldest.
      if (items.length > 0) {
        anchoredSessionRef.current = activeId
        thread.scrollTop = thread.scrollHeight
      }
      return
    }
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120
    if (nearBottom) thread.scrollTop = thread.scrollHeight
  }, [activeId, items, streamText])

  const startNewChat = useCallback(() => {
    if (streaming) return
    setActiveId(newSessionId())
    setItems([])
    setStreamText('')
    textareaRef.current?.focus()
  }, [streaming])

  const send = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || streaming) return
    setDraft('')
    setStreaming(true)
    setStreamText('')
    setItems(previous => [...previous, { role: 'user', text }])
    let sawAssistant = false
    // Deltas land in coarse batches so the tree and the markdown parser run
    // at frame cadence, not once per token; order-critical events flush first.
    const batcher = new DeltaBatcher((chunk) => { setStreamText(previous => previous + chunk) })
    try {
      await sendMessage(activeId, text, (event) => {
        switch (event.t) {
          case 'user':
            break
          case 'delta':
            sawAssistant = true
            batcher.push(event.text)
            break
          case 'assistant':
            batcher.flushNow()
            sawAssistant = true
            setStreamText(event.text)
            break
          case 'tool-start':
            batcher.flushNow()
            setItems(previous => [...previous, { role: 'tool', name: event.name, query: event.query, running: true }])
            break
          case 'tool-end':
            batcher.flushNow()
            setItems((previous) => {
              const next = [...previous]
              for (let index = next.length - 1; index >= 0; index--) {
                const candidate = next[index]
                if (candidate.role === 'tool' && candidate.running === true) {
                  next[index] = {
                    role: 'tool',
                    name: event.name,
                    query: event.query,
                    searchQuestion: event.searchQuestion,
                    searchedAt: event.searchedAt,
                    sources: event.sources,
                    text: event.text,
                  }
                  break
                }
              }
              return next
            })
            break
          case 'status':
            break
          case 'error':
            setError(event.message)
            break
          case 'turn-end':
            break
        }
      })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      batcher.dispose()
      // Commit the streamed text into the item list, then clear the draft.
      setStreamText((current) => {
        if (sawAssistant && current !== '') {
          setItems(previous => [...previous, { role: 'assistant', text: current }])
        }
        return ''
      })
      setStreaming(false)
      refreshSessions()
    }
  }, [activeId, draft, refreshSessions, streaming])

  const stop = useCallback(() => {
    stopSession(activeId).catch(() => { /* the stream ends on its own */ })
  }, [activeId])

  return (
    <div className={collapsed ? 'app collapsed' : 'app'}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="brand">dsh chat</span>
          <button
            type="button"
            className="icon-btn sidebar-toggle"
            aria-label="Hide sidebar"
            onClick={() => { setCollapsed(true) }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <line x1="5.5" y1="2.5" x2="5.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
        <button type="button" className="new-chat" onClick={startNewChat}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          New chat
        </button>
        <div className="search-box">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={query}
            placeholder="Search chats"
            aria-label="Search chats"
            spellCheck={false}
            onChange={(event) => { setQuery(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('')
            }}
          />
          {query !== ''
            ? (
              <button type="button" className="search-clear" aria-label="Clear search" onClick={() => { setQuery('') }}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            )
            : undefined}
        </div>
        <nav className="session-list" aria-label="Conversations" ref={listRef} onScroll={handleListScroll}>
          {searchActive
            ? (
              hits.length === 0 && !searching
                ? <div className="list-empty">No chats found</div>
                : hits.map(hit => (
                  <button
                    key={hit.id}
                    type="button"
                    className={hit.id === activeId ? 'session-item active' : 'session-item'}
                    onClick={() => { if (!streaming) setActiveId(hit.id) }}
                    title={hit.title}
                    data-id={hit.id}
                  >
                    <span className="session-hit">
                      <span className="session-title">{hit.title}</span>
                      <span className="session-snippet">{hit.snippet}</span>
                    </span>
                    <span className="session-date">{relativeDate(hit.updatedAt)}</span>
                  </button>
                ))
            )
            : (
              sessions.length === 0
                ? <div className="list-empty">No conversations yet</div>
                : sessions.map(session => (
                  <button
                    key={session.id}
                    type="button"
                    className={session.id === activeId ? 'session-item active' : 'session-item'}
                    onClick={() => { if (!streaming) setActiveId(session.id) }}
                    title={session.title}
                    data-id={session.id}
                  >
                    <span className="session-title">{session.title}</span>
                    <span className="session-date">{relativeDate(session.updatedAt)}</span>
                  </button>
                ))
            )}
          {loadingMore || (searchActive && searching) ? <div className="list-status">Loading…</div> : undefined}
        </nav>
        <div className="sidebar-footer">
          <button type="button" className="user-row" onClick={() => { setSettingsOpen(true) }}>
            <span className="user-avatar" aria-hidden="true">
              {avatar !== null
                ? <img className="user-avatar-img" src={avatarSrc(avatar)} alt="" draggable={false} />
                : (
                  <svg viewBox="0 0 16 16">
                    <circle cx="8" cy="5.2" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M3 13.5c.9-2.7 2.8-4.1 5-4.1s4.1 1.4 5 4.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                )}
            </span>
            <span className="user-name">catonooka</span>
            <svg className="user-gear" viewBox="0 0 16 16" aria-hidden="true">
              <line x1="2" y1="4.5" x2="14" y2="4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="6" cy="4.5" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <line x1="2" y1="11.5" x2="14" y2="11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="10" cy="11.5" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
      </aside>
      <main className="main">
        {collapsed
          ? (
            <button
              type="button"
              className="icon-btn open-sidebar-fab"
              aria-label="Open sidebar"
              onClick={() => { setCollapsed(false) }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <line x1="5.5" y1="2.5" x2="5.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          )
          : undefined}
        <div className="thread" ref={threadRef}>
          {items.length === 0 && streamText === ''
            ? (
              <div className="welcome">
                <div className="welcome-mark" aria-hidden="true"><img src={BOT_AVATAR_SRC} alt="" draggable={false} /></div>
                <div className="welcome-title">What can I help with?</div>
              </div>
            )
            : (
              <div className="thread-inner">
                {items.map((item, index) => {
                  if (item.role === 'user') {
                    return (
                      <div key={index} className="row user">
                        <div className="user-bubble">{item.text}</div>
                      </div>
                    )
                  }
                  if (item.role === 'tool') {
                    return (
                      <div key={index} className="row tool">
                        <ToolChip item={item} />
                      </div>
                    )
                  }
                  return (
                    <div key={index} className="row assistant">
                      <div className="assistant-avatar" aria-hidden="true"><img src={BOT_AVATAR_SRC} alt="" draggable={false} /></div>
                      <AssistantText text={item.text ?? ''} streaming={false} />
                    </div>
                  )
                })}
                {streaming && (streamText !== '' || items.every(item => item.role !== 'tool' || item.running !== true))
                  ? (
                    <div className="row assistant">
                      <div className="assistant-avatar" aria-hidden="true"><img src={BOT_AVATAR_SRC} alt="" draggable={false} /></div>
                      {streamText === '' ? <div className="assistant-text thinking">Thinking…</div> : <AssistantText text={streamText} streaming />}
                    </div>
                  )
                  : undefined}
                {streaming && streamText !== ''
                  ? undefined
                  : (streaming && items.some(item => item.role === 'tool' && item.running === true)
                    ? (
                      <div className="row assistant">
                        <div className="assistant-avatar" aria-hidden="true"><img src={BOT_AVATAR_SRC} alt="" draggable={false} /></div>
                        <div className="assistant-text thinking">Searching the web…</div>
                      </div>
                    )
                    : undefined)}
              </div>
            )}
        </div>
        <div className="composer-wrap">
          {error !== undefined
            ? (
              <div className="error-bar" role="alert">
                <span>{error}</span>
                <button type="button" onClick={() => { setError(undefined) }}>dismiss</button>
              </div>
            )
            : undefined}
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            <textarea
              ref={textareaRef}
              value={draft}
              placeholder="Message dsh chat…"
              rows={1}
              onChange={(event) => {
                setDraft(event.target.value)
                const node = event.target
                node.style.height = 'auto'
                node.style.height = `${String(Math.min(node.scrollHeight, 200))}px`
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            {streaming
              ? (
                <button type="button" className="send stop" aria-label="Stop generating" onClick={stop}>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
                  </svg>
                </button>
              )
              : (
                <button type="submit" className="send" aria-label="Send message" disabled={draft.trim() === ''}>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8 13V3.5M8 3.5L3.8 7.7M8 3.5l4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
          </form>
          <div className="composer-note">dsh chat can make mistakes. It searches the web with one internal tool.</div>
        </div>
      </main>
      {avatar === null
        ? <AvatarModal onPick={(picked) => { storeAvatar(picked); setAvatar(picked) }} />
        : undefined}
      {settingsOpen && config !== undefined
        ? (
          <SettingsPanel
            config={config}
            theme={theme}
            onTheme={setTheme}
            avatar={avatar}
            onAvatar={(picked) => { storeAvatar(picked); setAvatar(picked) }}
            onApplied={setConfig}
            onSaved={(next) => {
              setConfig(next)
              setSettingsOpen(false)
            }}
            onClose={() => { setSettingsOpen(false) }}
          />
        )
        : undefined}
    </div>
  )
}
