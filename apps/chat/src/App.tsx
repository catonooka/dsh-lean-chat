/** The chat surface: sidebar of conversations, streamed thread, composer. */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  fetchConfig,
  fetchMessages,
  listSessions,
  sendMessage,
  stopSession,
  type AppConfig,
  type ChatItem,
  type SessionSummary,
} from './api.ts'
import { renderMarkdown } from './markdown.ts'

const ACTIVE_KEY = 'dsh-chat-active'

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
  const [activeId, setActiveId] = useState<string>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(ACTIVE_KEY) : null
    return stored ?? newSessionId()
  })
  const [items, setItems] = useState<ChatItem[]>([])
  const [streaming, setStreaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [config, setConfig] = useState<AppConfig | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const threadRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const refreshSessions = useCallback(() => {
    listSessions()
      .then(setSessions)
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }, [])

  useEffect(() => {
    refreshSessions()
    fetchConfig().then(setConfig).catch(() => { /* the header simply stays generic */ })
  }, [refreshSessions])

  useEffect(() => {
    localStorage.setItem(ACTIVE_KEY, activeId)
  }, [activeId])

  // A persisted session's history loads once the session list confirms the
  // id; a draft (never-sent) session shows an empty thread until its first
  // message makes it known. The cancelled flag keeps rapid switches from
  // racing an older fetch over a newer one.
  const knownSession = sessions.some(session => session.id === activeId)
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

  useEffect(() => {
    const thread = threadRef.current
    if (thread === null) return
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120
    if (nearBottom) thread.scrollTop = thread.scrollHeight
  }, [items, streamText])

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
    try {
      await sendMessage(activeId, text, (event) => {
        switch (event.t) {
          case 'user':
            break
          case 'delta':
            sawAssistant = true
            setStreamText(previous => previous + event.text)
            break
          case 'assistant':
            sawAssistant = true
            setStreamText(event.text)
            break
          case 'tool-start':
            setItems(previous => [...previous, { role: 'tool', name: event.name, query: event.query, running: true }])
            break
          case 'tool-end':
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

  const modelLabel = config === undefined
    ? 'dsh chat'
    : config.model
      + (config.reasoningEffort !== undefined ? ` · thinking ${config.reasoningEffort}` : '')
      + (config.temperature !== undefined ? ` · temp ${String(config.temperature)}` : '')

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="brand">dsh chat</span>
        </div>
        <button type="button" className="new-chat" onClick={startNewChat}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          New chat
        </button>
        <nav className="session-list" aria-label="Conversations">
          {sessions.map(session => (
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
          ))}
        </nav>
      </aside>
      <main className="main">
        <header className="topbar">
          <span className="model-label">{modelLabel}</span>
        </header>
        <div className="thread" ref={threadRef}>
          {items.length === 0 && streamText === ''
            ? (
              <div className="welcome">
                <div className="welcome-mark">dsh</div>
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
                      <div className="assistant-avatar" aria-hidden="true">dsh</div>
                      <AssistantText text={item.text ?? ''} streaming={false} />
                    </div>
                  )
                })}
                {streaming && (streamText !== '' || items.every(item => item.role !== 'tool' || item.running !== true))
                  ? (
                    <div className="row assistant">
                      <div className="assistant-avatar" aria-hidden="true">dsh</div>
                      {streamText === '' ? <div className="assistant-text thinking">Thinking…</div> : <AssistantText text={streamText} streaming />}
                    </div>
                  )
                  : undefined}
                {streaming && streamText !== ''
                  ? undefined
                  : (streaming && items.some(item => item.role === 'tool' && item.running === true)
                    ? (
                      <div className="row assistant">
                        <div className="assistant-avatar" aria-hidden="true">dsh</div>
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
    </div>
  )
}
