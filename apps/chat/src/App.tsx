/** The chat surface: sidebar of conversations, streamed thread, composer. */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  checkModelAbilities,
  createUser,
  deleteSession,
  fetchConfig,
  fetchMessages,
  listSessions,
  listUsers,
  patchSession,
  readStoredUserId,
  retrySession,
  searchSessions,
  sendMessage,
  setActingUser,
  stopSession,
  updateConfig,
  updateUser,
  SESSION_PAGE_SIZE,
  fetchAttachmentBlob,
  uploadAttachment,
  type AppConfig,
  type ChatAttachment,
  type ChatItem,
  type OutgoingAttachment,
  type SearchHit,
  type SessionSummary,
  type StreamEvent,
  type UploadedAttachment,
  type UserInfo,
} from './api.ts'
import { renderMarkdown } from './markdown.ts'
import { SettingsPanel, applyTheme, readStoredTheme, storeTheme, type Theme } from './Settings.tsx'
import { AvatarModal } from './AvatarModal.tsx'
import { AddUserModal } from './AddUserModal.tsx'
import { ConfirmDeleteDialog, MoveGroupDialog, NewGroupDialog } from './SessionDialogs.tsx'
import { ContextMenu, type ContextMenuItem } from './ContextMenu.tsx'
import { CharacterMenu, RenameCharacterDialog } from './CharacterMenu.tsx'
import { NewCharacterModal } from './NewCharacterModal.tsx'
import { UserMenu } from './UserMenu.tsx'
import { botAvatarSrc, avatarSrc, readStoredAvatar, storeAvatar } from './avatar.ts'
import { StreamFeed } from './delta.ts'
import { copyToClipboard } from './clipboard.ts'
import { replyLabel, replyTargetFor, type ReplyContext } from './reply.ts'

const ACTIVE_KEY = 'dsh-chat-active'
const COLLAPSED_KEY = 'dsh-chat-collapsed'

/** Each profile remembers its own open chat under its own storage key. */
function activeChatKey(userId: string): string {
  return userId === '' ? ACTIVE_KEY : `${ACTIVE_KEY}:${userId}`
}

/** Debounce for the sidebar search box. */
const SEARCH_DEBOUNCE_MS = 300

/** Scroll proximity that triggers loading the next list page. */
const LOAD_MORE_TRIGGER_PX = 60

/** While streaming, markdown re-parses at most this often; the committed
 * row parses in full once the turn lands. */
const STREAM_PARSE_THROTTLE_MS = 200

function newSessionId(): string {
  return randomUUID()
}

// Allocated once: date formatting shows up per sidebar row and per tool
// chip, so the formatters themselves must not be per-call.
const clockFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const dayFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

function relativeDate(createdAt: number): string {
  const date = new Date(createdAt)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay ? clockFormatter.format(date) : dayFormatter.format(date)
}

/** One attachment inside a user bubble: local preview while live, fetched
 * bytes for history. */
/** What the composer does with one picked, pasted, or dropped file. */
export type PastedKind = 'image' | 'video' | 'text' | 'file'

/** Extensions whose contents ride the message as text (models read them). */
const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'log', 'yml', 'yaml', 'toml', 'ini',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java',
  'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'html', 'css',
])

/**
 * Route one file by what it is: images and videos attach for multimodal
 * models, text-shaped files inline their contents into the message, and
 * anything else attaches as a durable file the model references by name.
 * @param file - the picked/pasted/dropped file (name and type only).
 * @returns how the composer handles it.
 */
export function classifyPastedFile(file: { type: string; name: string }): PastedKind {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('text/') || file.type === 'application/json') return 'text'
  const dot = file.name.lastIndexOf('.')
  const extension = dot === -1 ? '' : file.name.slice(dot + 1).toLowerCase()
  if (TEXT_FILE_EXTENSIONS.has(extension)) return 'text'
  return 'file'
}

/** Hover actions under one message: copy its text, make it the reply target,
 * and on the trailing turn run the turn again. Memoized: unrelated state
 * changes (typing, streaming batches) must not re-run its copy timer. */
const MessageActions = memo(function MessageActions(
  { text, onReply, onRetry }: { text: string; onReply: () => void; onRetry?: () => void },
): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    if (await copyToClipboard(text)) {
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1400)
    }
  }
  return (
    <div className="msg-actions">
      <button type="button" aria-label="Copy message" title="Copy" onClick={() => { void copy() }}>
        {copied
          ? (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )
          : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1" fill="none" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          )}
      </button>
      <button type="button" aria-label="Reply to this message" title="Reply" onClick={onReply}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M14 7.5c0 3-2.7 4.5-6 4.5-.7 0-1.4-.1-2-.2L3 14l.9-2.7C2.7 10.5 2 9.5 2 7.5 2 4.5 4.7 3 8 3s6 1.5 6 4.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </button>
      {onRetry !== undefined
        ? (
          <button type="button" aria-label="Try again" title="Try again" onClick={onRetry}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M13.7 1.8v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )
        : undefined}
    </div>
  )
})

const BubbleAttachment = memo(function BubbleAttachment({ attachment }: { attachment: ChatAttachment }): JSX.Element {
  // Which bytes the rendered URL points at: the composer's local preview, or
  // the object URL minted from the fetched bytes for one attachment id.
  // History refetches (compaction) replace item objects wholesale — the same
  // attachment id must keep its URL and not refetch, while a genuinely
  // different attachment swaps it. Minted URLs are revoked only when a newer
  // URL has taken their place or the row unmounts — never the instant they
  // are handed to the DOM.
  const sourceKey = attachment.localUrl ?? attachment.attachmentId
  const urlRef = useRef<string | undefined>(attachment.localUrl)
  const sourceRef = useRef(sourceKey)
  const mintedRef = useRef<string | undefined>(undefined)
  const [, setVersion] = useState(0)
  useEffect(() => {
    if (attachment.localUrl !== undefined) {
      urlRef.current = attachment.localUrl
      sourceRef.current = sourceKey
      setVersion(version => version + 1)
      return undefined
    }
    // Same attachment id, URL already in hand: a refetched history row.
    if (urlRef.current !== undefined && sourceRef.current === sourceKey) return undefined
    let cancelled = false
    fetchAttachmentBlob(attachment)
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob)
        if (cancelled) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        const stale = mintedRef.current
        mintedRef.current = objectUrl
        urlRef.current = objectUrl
        sourceRef.current = sourceKey
        setVersion(version => version + 1)
        if (stale !== undefined) URL.revokeObjectURL(stale)
      })
      .catch(() => { /* the bubble falls back to a placeholder */ })
    return () => { cancelled = true }
  }, [sourceKey, attachment.localUrl])
  // Unmount releases what this row minted; the composer owns its previews.
  useEffect(() => () => {
    if (mintedRef.current !== undefined) URL.revokeObjectURL(mintedRef.current)
  }, [])
  const url = urlRef.current
  if (attachment.kind === 'image') {
    return <img className="bubble-attachment" src={url} alt={attachment.mediaType} />
  }
  if (attachment.kind === 'file') {
    return (
      <a
        className={url === undefined ? 'bubble-attachment file pending' : 'bubble-attachment file'}
        href={url}
        download={attachment.name ?? 'attachment'}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 1.5h5L12.5 5v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M9 1.5V5h3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
        <span>{attachment.name ?? 'file'}</span>
      </a>
    )
  }
  return <video className="bubble-attachment" src={url} muted controls playsInline />
})

const AssistantText = memo(function AssistantText({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div className="assistant-text">
      {/* Safe HTML: renderMarkdown escapes everything and emits a fixed tag vocabulary. */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {streaming ? <span className="caret" aria-label="generating" /> : undefined}
    </div>
  )
})

/** Steps that act on the page rather than read it; their chips say Acting. */
const ACTING_ACTIONS = new Set(['click', 'type', 'press', 'scroll', 'back'])

const ToolChip = memo(function ToolChip({ item }: { item: ChatItem }): JSX.Element {
  const [open, setOpen] = useState(false)
  const count = item.sources?.length
  // Browser steps get their own face: a globe, the action and page instead of
  // a search question, and the page excerpt behind the toggle.
  if (item.action !== undefined || item.name === 'browser') {
    const label = [item.action, item.url ?? item.title ?? ''].filter(part => part !== '').join(' ')
    const acting = item.action !== undefined && ACTING_ACTIONS.has(item.action)
    const failed = item.error === true && item.running !== true
    return (
      <div className="tool-chip-wrap">
        <button type="button" className={`tool-chip${failed ? ' failed' : ''}`} onClick={() => { setOpen(value => !value) }}>
          <svg className="tool-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <ellipse cx="8" cy="8" rx="3" ry="6.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <line x1="1.5" y1="8" x2="14.5" y2="8" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          <span className="tool-label">
            {item.running === true ? (acting ? 'Acting' : 'Browsing') : (acting ? 'Acted' : 'Browsed')}
            {label === '' ? '' : ` · ${label}`}
            {failed ? ' · failed' : ''}
          </span>
        </button>
        {open && item.excerpt !== undefined
          ? (
            <div className="tool-sources">
              <div className="tool-excerpt">{item.excerpt}</div>
              {item.url !== undefined
                ? <a href={item.url} target="_blank" rel="noopener noreferrer">{item.url}</a>
                : undefined}
            </div>
          )
          : undefined}
      </div>
    )
  }
  const label = item.searchQuestion ?? item.query ?? item.text ?? 'web search'
  return (
    <div className="tool-chip-wrap">
      <button
        type="button"
        className={`tool-chip${item.error === true && item.running !== true ? ' failed' : ''}`}
        onClick={() => { setOpen(value => !value) }}
      >
        <svg className="tool-icon" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="tool-label">
          {item.running === true ? 'Searching' : 'Searched'}
          {' · '}
          {label}
          {item.error === true && item.running !== true ? ' · failed' : ''}
        </span>
        {count !== undefined ? <span className="tool-count">{String(count)} results</span> : undefined}
        {item.searchedAt !== undefined ? <span className="tool-time">{clockFormatter.format(new Date(item.searchedAt))}</span> : undefined}
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
})

/**
 * The streaming turn's row — the only component that re-renders per delta
 * batch. It subscribes to the turn's feed directly (the accumulated text
 * never enters app-level state), re-parses markdown on a coarse throttle,
 * and keeps the thread pinned to the bottom through a direct scroll write.
 */
function StreamTurn({ feed, searching, follow }: { feed: StreamFeed; searching: boolean; follow: () => void }): JSX.Element {
  const [html, setHtml] = useState<string | undefined>(undefined)
  const parsedRef = useRef({ at: 0, length: 0 })
  useEffect(() => {
    return feed.subscribe((text) => {
      const parsed = parsedRef.current
      const now = Date.now()
      // A replacement (setFull) shows as non-growing text: parse it now, it
      // is a fresh message rather than the incremental tail.
      if (text.length <= parsed.length || now - parsed.at >= STREAM_PARSE_THROTTLE_MS) {
        parsedRef.current = { at: now, length: text.length }
        setHtml(renderMarkdown(text))
      }
      follow()
    })
  }, [feed, follow])
  if (feed.text === '') {
    return <div className="assistant-text thinking">{searching ? 'Searching the web…' : 'Thinking…'}</div>
  }
  return (
    <div className="assistant-text">
      {/* Safe HTML: renderMarkdown escapes everything and emits a fixed tag vocabulary. */}
      <div dangerouslySetInnerHTML={{ __html: html ?? renderMarkdown(feed.text) }} />
      <span className="caret" aria-label="generating" />
    </div>
  )
}

/** One compaction checkpoint row: a muted summary card. Memoized so
 * unrelated app state changes never re-render history rows. */
const CompactionRow = memo(function CompactionRow({ item }: { item: ChatItem }): JSX.Element {
  return (
    <div className="row compaction">
      <div className="compaction-card">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2" y="3.5" width="12" height="4" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3.5 7.5v4.3a1.2 1.2 0 0 0 1.2 1.2h6.6a1.2 1.2 0 0 0 1.2-1.2V7.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <line x1="6.4" y1="10.2" x2="9.6" y2="10.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <div className="compaction-body">
          <span className="compaction-label">Earlier conversation compacted</span>
          <span className="compaction-text">{item.text}</span>
        </div>
      </div>
    </div>
  )
})

interface RowActions {
  /** Whether this row is the thread's last (retry actions appear on it). */
  trailing: boolean
  streaming: boolean
  onReply: (item: ChatItem) => void
  onRetry: () => void
}

/** The active character's avatar image source shared by every bot slot. */
interface BotAvatarProps {
  avatar: string
  onAvatarClick: (event: ReactMouseEvent<HTMLButtonElement>) => void
}

/** One user bubble with its reply quote, attachments, and hover actions. */
const UserRow = memo(function UserRow({ item, trailing, streaming, onReply, onRetry }: RowActions & { item: ChatItem }): JSX.Element {
  return (
    <div className="row user">
      <div className="user-col">
        <div className="user-bubble">
          {item.replyTo !== undefined
            ? (
              <div className="reply-quote">
                <span className="reply-quote-label">{replyLabel(item.replyTo.role)}</span>
                <span className="reply-quote-text">{item.replyTo.text}</span>
              </div>
            )
            : undefined}
          {(item.attachments ?? []).map((one, at) => <BubbleAttachment key={at} attachment={one} />)}
          {item.text}
        </div>
        {item.text !== undefined && item.text !== ''
          ? (
            <MessageActions
              text={item.text}
              onReply={() => { onReply(item) }}
              {...!streaming && trailing ? { onRetry } : {}}
            />
          )
          : undefined}
      </div>
    </div>
  )
})

/** One assistant bubble: avatar, markdown text, and hover actions. */
const AssistantRow = memo(function AssistantRow(
  { item, trailing, streaming, onReply, onRetry, avatar, onAvatarClick }:
    RowActions & { item: ChatItem } & BotAvatarProps,
): JSX.Element {
  return (
    <div className="row assistant">
      <button type="button" className="assistant-avatar" aria-label="Switch model character" onClick={onAvatarClick}>
        <img src={avatar} alt="" draggable={false} />
      </button>
      <div className="assistant-col">
        <AssistantText text={item.text ?? ''} streaming={false} />
        {!streaming && trailing && item.text !== undefined && item.text !== ''
          ? (
            <MessageActions
              text={item.text}
              onReply={() => { onReply(item) }}
              onRetry={onRetry}
            />
          )
          : undefined}
      </div>
    </div>
  )
})

/** The sidebar's list body — conversations or search hits, grouped chats in
 * their group sections. Memoized so composer typing and streaming batches
 * never re-render the loaded rows. */
const SessionListBody = memo(function SessionListBody({
  searchActive, hits, sessions, activeId, searching, loadingMore, runningIds, onSelect,
  groups, renamingId, onRenameSubmit, onRenameCancel, onContext, grouped,
}: {
  searchActive: boolean
  hits: readonly SearchHit[]
  sessions: readonly SessionSummary[]
  activeId: string
  searching: boolean
  loadingMore: boolean
  runningIds: readonly string[]
  onSelect: (id: string) => void
  groups: readonly { id: string; name: string }[]
  renamingId: string | undefined
  onRenameSubmit: (id: string, title: string) => void
  onRenameCancel: () => void
  onContext: (id: string, clientX: number, clientY: number) => void
  grouped: boolean
}): JSX.Element {
  const row = (session: SessionSummary): JSX.Element => (
    <button
      key={session.id}
      type="button"
      className={session.id === activeId ? 'session-item active' : 'session-item'}
      onClick={() => { onSelect(session.id) }}
      onContextMenu={(event) => {
        event.preventDefault()
        onContext(session.id, event.clientX, event.clientY)
      }}
      title={session.title}
      data-id={session.id}
    >
      {renamingId === session.id
        ? (
          <input
            className="session-rename"
            aria-label="Rename chat"
            defaultValue={session.title}
            autoFocus
            spellCheck={false}
            onClick={(event) => { event.stopPropagation() }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                onRenameSubmit(session.id, event.currentTarget.value)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                onRenameCancel()
              }
            }}
            onBlur={onRenameCancel}
          />
        )
        : (
          <>
            <span className="session-title">{session.title}</span>
            {runningIds.includes(session.id) ? <span className="session-live" aria-label="generating" /> : undefined}
            <span className="session-date">{relativeDate(session.updatedAt)}</span>
          </>
        )}
    </button>
  )
  const body = searchActive
    ? (
      hits.length === 0 && !searching
        ? <div className="list-empty">No chats found</div>
        : hits.map(hit => (
          <button
            key={hit.id}
            type="button"
            className={hit.id === activeId ? 'session-item active' : 'session-item'}
            onClick={() => { onSelect(hit.id) }}
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
    : grouped
      ? (
        <>
          {groups.map(group => (
            <div className="session-group" key={group.id}>
              <div className="session-group-head">{group.name}</div>
              {sessions.filter(session => session.groupId === group.id).map(row)}
            </div>
          ))}
          {sessions.filter(session => session.groupId === null || session.groupId === undefined
            || !groups.some(group => group.id === session.groupId)).map(row)}
          {sessions.length === 0 ? <div className="list-empty">No conversations yet</div> : undefined}
        </>
      )
      : (
        sessions.length === 0
          ? <div className="list-empty">No conversations yet</div>
          : sessions.map(row)
      )
  return (
    <>
      {body}
      {loadingMore || (searchActive && searching) ? <div className="list-status">Loading…</div> : undefined}
    </>
  )
})

/**
 * Merge one refreshed first page into the loaded sidebar rows: page rows
 * update or prepend in their fresh order, deeper pages keep their rows, and
 * anything the page already covers drops out of the tail. A turn therefore
 * refreshes 20 rows, not every row ever scrolled past.
 */
export function mergeSessionPage<T extends { id: string }>(previous: readonly T[], page: readonly T[]): T[] {
  if (previous.length <= page.length) return [...page]
  const headIds = new Set(page.map(session => session.id))
  const tail = previous.filter(session => !headIds.has(session.id))
  return [...page, ...tail]
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
  // Sessions with a turn in flight; the composer only guards the ACTIVE one,
  // so conversations run in parallel and each keeps its own stream.
  const [runningIds, setRunningIds] = useState<string[]>([])
  const streaming = runningIds.includes(activeId)
  const activeIdRef = useRef(activeId)
  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  // Which profile the sidebar's in-flight list fetch belongs to; a fast
  // switch back and forth must not let the slower response win.
  const listOwnerRef = useRef('')
  // One registry of live turns: the feed keeps receiving deltas while its
  // session is out of view, and the entry's item list replays exactly when
  // the user switches back. Finished turns hand the session back to the
  // normal fetch flow — the server's history is the authority once a turn
  // has fully persisted.
  interface TurnEntry {
    feed: StreamFeed
    items: ChatItem[]
    sawAssistant: boolean
    sawCompaction: boolean
  }
  const turnsRef = useRef<Map<string, TurnEntry>>(new Map())
  const [feed, setFeed] = useState<StreamFeed | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [config, setConfig] = useState<AppConfig | undefined>(undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(readStoredTheme)
  // User profiles: the roster loads once, and the acting profile is pure
  // client state (the x-dsh-user header) — switching never reloads and never
  // disturbs running turns. '' means the roster has not resolved yet.
  const [users, setUsers] = useState<UserInfo[] | undefined>(undefined)
  const [activeUserId, setActiveUserId] = useState<string>('')
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [addUserOpen, setAddUserOpen] = useState(false)
  const activeUserInfo = users?.find(user => user.id === activeUserId)
  // The avatar is a required pick per profile: null means the chooser is up.
  const avatar = activeUserInfo?.avatar ?? null
  // Chat management: the right-click menu, its rename target, its dialogs,
  // and the archived shelf view.
  const [chatMenu, setChatMenu] = useState<{ id: string; x: number; y: number } | undefined>(undefined)
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined)
  const [newGroupFor, setNewGroupFor] = useState<string | undefined>(undefined)
  const [moveFor, setMoveFor] = useState<string | undefined>(undefined)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | undefined>(undefined)
  const [archivedView, setArchivedView] = useState(false)
  const [archivedSessions, setArchivedSessions] = useState<SessionSummary[]>([])
  // The model character switcher, opened by clicking the bot avatar.
  const [characterMenu, setCharacterMenu] = useState<{ x: number; y: number } | undefined>(undefined)
  const [newCharacterOpen, setNewCharacterOpen] = useState(false)
  const [renameCharacterOpen, setRenameCharacterOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSED_KEY) === '1')
  const [error, setError] = useState<string | undefined>(undefined)
  const threadRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const searchActive = debouncedQuery !== ''

  // Resolve who this tab acts as before the first data loads, so every fetch
  // carries the right profile header from the start. A stored id the server
  // no longer knows heals to the default profile; the default profile seeds
  // its avatar from this browser's legacy local pick; each profile resumes
  // its own remembered chat.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const body = await listUsers()
        if (cancelled) return
        const stored = readStoredUserId()
        const known = stored !== undefined && body.users.some(user => user.id === stored)
        const resolved = known ? stored : body.defaultUserId
        if (resolved !== stored) setActingUser(resolved)
        setActiveUserId(resolved)
        listOwnerRef.current = resolved
        setUsers(body.users)
        const fallback = body.users.find(user => user.id === body.defaultUserId)
        if (fallback !== undefined && fallback.avatar === undefined) {
          const legacy = readStoredAvatar()
          if (legacy !== null) {
            void updateUser(body.defaultUserId, { avatar: legacy })
              .then((updated) => { if (!cancelled) setUsers(updated.users) })
              .catch(() => { /* the profile keeps the placeholder avatar */ })
          }
        }
        const remembered = typeof localStorage !== 'undefined'
          ? localStorage.getItem(activeChatKey(resolved))
          : null
        if (remembered !== null) {
          if (remembered !== activeIdRef.current) selectSession(remembered)
        } else if (resolved !== body.defaultUserId) {
          selectSession(newSessionId())
        }
        const page = await listSessions({ limit: SESSION_PAGE_SIZE })
        if (cancelled || listOwnerRef.current !== resolved) return
        setSessions(page.sessions)
        setTotal(page.total)
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    fetchConfig().then(setConfig).catch(() => { /* the header simply stays generic */ })
    return () => { cancelled = true }
  }, [])

  // After a turn, refresh the first page only and merge it into the loaded
  // rows — deep sidebars do not refetch everything they ever scrolled past.
  const refreshSessions = useCallback(() => {
    listSessions({ limit: SESSION_PAGE_SIZE })
      .then((body) => {
        setSessions(previous => mergeSessionPage(previous, body.sessions))
        setTotal(body.total)
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }, [])

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

  /** Switching conversations never blocks: a turn in flight keeps streaming
   * in the background, and switching back restores its live feed and rows. */
  const selectSession = useCallback((id: string): void => {
    if (id === activeIdRef.current) return
    setActiveId(id)
    const entry = turnsRef.current.get(id)
    if (entry !== undefined) {
      setItems(entry.items)
      setFeed(entry.feed)
      return
    }
    setFeed(undefined)
  }, [])

  useEffect(() => {
    // '' = roster unresolved; the bootstrap resolves the profile first.
    if (activeUserId !== '') localStorage.setItem(activeChatKey(activeUserId), activeId)
  }, [activeId, activeUserId])

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  useEffect(() => {
    applyTheme(theme)
    storeTheme(theme)
  }, [theme])

  // A persisted session's history loads once the session list (or a search
  // hit) confirms the id; a draft (never-sent) session shows an empty thread
  // until its first message makes it known. A session whose turn is still
  // live was restored by the switch itself — fetching would race it away.
  // The cancelled flag keeps rapid switches from racing an older fetch over
  // a newer one.
  const knownSession = sessions.some(session => session.id === activeId)
    || hits.some(hit => hit.id === activeId)
  useEffect(() => {
    if (turnsRef.current.get(activeId) !== undefined) return undefined
    if (knownSession) {
      let cancelled = false
      fetchMessages(activeId)
        .then((items) => {
          // A fetch that started before a turn began must not clobber the
          // turn's rows when it lands mid-stream: the entry owns the view.
          if (!cancelled && turnsRef.current.get(activeId) === undefined) setItems(items)
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
      return () => { cancelled = true }
    }
    setItems([])
    return undefined
  }, [activeId, knownSession])

  // The streaming turn's text lives in the feed (outside React state): only
  // the subscribed streaming row re-renders as deltas land, never the app.

  // The conversation whose history has already been landed on the bottom.
  const anchoredSessionRef = useRef('')

  // Which input modalities the active model accepts (server probes, cached).
  const [abilities, setAbilities] = useState<{ image: 'yes' | 'no' | 'unknown'; video: 'yes' | 'no' | 'unknown' } | undefined>(undefined)
  const [attachment, setAttachment] = useState<OutgoingAttachment | undefined>(undefined)
  // The message the next send answers, shown as a chip above the composer.
  const [replyTarget, setReplyTarget] = useState<ReplyContext | undefined>(undefined)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Blob URLs preview composer attachments in the chip and the sent bubble.
  // They stay alive while their row is on screen and are revoked when the
  // composer drops the file or the conversation switches (its rows leave).
  const objectUrlsRef = useRef<string[]>([])
  const trackObjectUrl = (url: string): void => { objectUrlsRef.current = [...objectUrlsRef.current, url] }
  const revokeObjectUrl = (url: string): void => {
    URL.revokeObjectURL(url)
    objectUrlsRef.current = objectUrlsRef.current.filter(one => one !== url)
  }

  // A reply target belongs to the conversation it was picked in; the same
  // switch retires the previous conversation's blob previews.
  useEffect(() => {
    setReplyTarget(undefined)
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url)
    objectUrlsRef.current = []
  }, [activeId])

  useEffect(() => {
    if (config === undefined) return
    let cancelled = false
    checkModelAbilities(config.model)
      .then((probe) => { if (!cancelled) setAbilities({ image: probe.image, video: probe.video }) })
      .catch(() => { /* no attach button until a probe answers */ })
    return () => { cancelled = true }
  }, [config?.model])

  // Structural scroll behavior: land on the newest message when a
  // conversation opens, and follow new rows while pinned near the bottom.
  // Per-batch following during streaming is StreamTurn's direct write.
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
  }, [activeId, items])

  /** Follow the stream: pin the thread to the bottom while the user is
   * already near it (a direct DOM write — no re-render, no layout effect). */
  const followStream = useCallback((): void => {
    const thread = threadRef.current
    if (thread === null) return
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120
    if (nearBottom) thread.scrollTop = thread.scrollHeight
  }, [])

  const acceptsImages = abilities?.image === 'yes'
  const acceptsVideos = abilities?.video === 'yes'
  const attachAccept = [acceptsImages ? 'image/png,image/jpeg,image/webp,image/gif' : '', acceptsVideos ? 'video/*' : '']
    .filter(value => value !== '').join(',')

  const pickAttachment = (file: File | undefined): void => {
    if (file === undefined) return
    const isImage = file.type.startsWith('image/')
    const cap = isImage ? 8 * 1024 * 1024 : 64 * 1024 * 1024
    // Refuse only a definitive no: while the probe is still in flight the
    // file flows, and the server's own awaited probe delivers the verdict.
    if ((isImage ? abilities?.image : abilities?.video) === 'no') {
      setError(`this model does not accept ${isImage ? 'images' : 'videos'}`)
      return
    }
    if (file.size > cap) {
      setError(`that ${isImage ? 'image' : 'video'} is over the ${String(Math.round(cap / 1024 / 1024))}MB limit`)
      return
    }
    if (file.size === 0) {
      setError('that file is empty')
      return
    }
    // The composer holds the raw file plus a local blob preview; the bytes
    // upload as-is on send — never through a base64 string.
    const localUrl = URL.createObjectURL(file)
    trackObjectUrl(localUrl)
    if (attachment !== undefined) revokeObjectUrl(attachment.localUrl)
    setError(undefined)
    setAttachment({
      kind: isImage ? 'image' : 'video',
      name: file.name,
      mediaType: file.type !== '' ? file.type : 'application/octet-stream',
      file,
      localUrl,
    })
  }

  /** Take one picked, pasted, or dropped file into the composer. */
  const ingestFile = (file: File): void => {
    const kind = classifyPastedFile(file)
    if (kind === 'image' || kind === 'video') {
      if (!(kind === 'image' ? acceptsImages : acceptsVideos)) {
        setError(`this model does not accept ${kind}s`)
        return
      }
      pickAttachment(file)
      return
    }
    if (kind === 'text') {
      if (file.size > 100 * 1024) {
        setError('text files paste up to 100KB')
        return
      }
      const reader = new FileReader()
      reader.onerror = () => { setError('could not read that file') }
      reader.onload = () => {
        const text = typeof reader.result === 'string' ? reader.result : ''
        if (text === '') {
          setError('could not read that file')
          return
        }
        const dot = file.name.lastIndexOf('.')
        const extension = dot === -1 ? '' : file.name.slice(dot + 1)
        setDraft(previous => `${previous}${previous === '' ? '' : '\n\n'}`
          + `\`\`\`${extension}\n# ${file.name}\n${text}\n\`\`\`\n`)
      }
      reader.readAsText(file)
      return
    }
    if (file.size > 64 * 1024 * 1024) {
      setError('files paste up to 64MB')
      return
    }
    if (file.size === 0) {
      setError('that file is empty')
      return
    }
    const localUrl = URL.createObjectURL(file)
    trackObjectUrl(localUrl)
    if (attachment !== undefined) revokeObjectUrl(attachment.localUrl)
    setError(undefined)
    setAttachment({
      kind: 'file',
      name: file.name,
      mediaType: file.type !== '' ? file.type : 'application/octet-stream',
      file,
      localUrl,
    })
  }

  /** Paste and drop share one ingestion path. */
  const handleComposerPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.files]
    if (files.length === 0) return
    event.preventDefault()
    ingestFile(files[0] as File)
    if (files.length > 1) setError('one file at a time — the rest were ignored')
  }

  const handleComposerDrop = (event: ReactDragEvent<HTMLTextAreaElement>): void => {
    const files = [...event.dataTransfer.files]
    if (files.length === 0) return
    event.preventDefault()
    ingestFile(files[0] as File)
  }

  const startNewChat = useCallback(() => {
    // Never blocked: any running conversation keeps streaming in the
    // background while this fresh draft takes the composer.
    setActiveId(newSessionId())
    setItems([])
    setFeed(undefined)
    textareaRef.current?.focus()
  }, [])

  /**
   * Switch the acting profile: pure client state. The header (and with it
   * ownership of new chats) moves at once, the sidebar reloads for the new
   * profile, and each profile resumes its own remembered chat. Running
   * turns of the previous profile keep streaming untouched — their sessions,
   * feeds, and rows live in the turn registry, not in the acting profile.
   */
  const switchUser = useCallback((id: string): void => {
    setUserMenuOpen(false)
    if (id === activeUserId) return
    if (activeUserId !== '') localStorage.setItem(activeChatKey(activeUserId), activeIdRef.current)
    setActingUser(id)
    setActiveUserId(id)
    listOwnerRef.current = id
    setSessions([])
    setTotal(0)
    setHits([])
    setSearchCursor(undefined)
    setQuery('')
    setDebouncedQuery('')
    setArchivedView(false)
    setArchivedSessions([])
    setChatMenu(undefined)
    setRenamingId(undefined)
    void listSessions({ limit: SESSION_PAGE_SIZE })
      .then((body) => {
        if (listOwnerRef.current !== id) return
        setSessions(body.sessions)
        setTotal(body.total)
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
    const remembered = typeof localStorage !== 'undefined' ? localStorage.getItem(activeChatKey(id)) : null
    selectSession(remembered ?? newSessionId())
  }, [activeUserId, selectSession])

  /** Apply an avatar pick to the acting profile (and keep the legacy seed). */
  const applyAvatar = useCallback((picked: number): void => {
    storeAvatar(picked)
    if (activeUserId === '') return
    void updateUser(activeUserId, { avatar: picked })
      .then((body) => { setUsers(body.users) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }, [activeUserId])

  /** Create a profile from the dialog and switch straight to it. */
  const addUser = useCallback((input: { name: string; avatar: number; chromeProfile?: string }): void => {
    void createUser(input)
      .then((body) => {
        setUsers(body.users)
        setAddUserOpen(false)
        if (body.createdId !== undefined) switchUser(body.createdId)
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }, [switchUser])

  // ── model characters (the provider profiles the bot avatar switches) ──────

  /** The active character: the profile the server routes requests through. */
  const activeCharacter = config?.profiles?.find(profile => profile.id === config.activeProfileId)
  const botAvatar = botAvatarSrc(activeCharacter?.avatar)

  /** Open the character switcher at a click on any bot avatar slot. */
  const openCharacterMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>): void => {
    setCharacterMenu({ x: event.clientX, y: event.clientY })
  }, [])

  /** Switch the model character; the running turn finishes on the old route. */
  const switchCharacter = useCallback((id: string): void => {
    if (id === activeCharacter?.id) return
    updateConfig({ switchProfile: id })
      .then(setConfig)
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }, [activeCharacter?.id])

  /** Create a character from the dialog and switch straight to it. */
  const createCharacter = useCallback((input: { name: string; avatar?: number; persona?: string }): void => {
    updateConfig({ newProfile: input })
      .then((next) => {
        setConfig(next)
        setNewCharacterOpen(false)
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }, [])

  /** Rename the active character in place. */
  const renameCharacter = useCallback((name: string): void => {
    const id = activeCharacter?.id
    if (id === undefined) return
    updateConfig({ renameProfile: { id, name } })
      .then((next) => {
        setConfig(next)
        setRenameCharacterOpen(false)
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }, [activeCharacter?.id])

  // ── chat management (context-menu actions) ────────────────────────────────

  const openArchived = useCallback((): void => {
    setArchivedView(true)
    listSessions({ limit: 50, archived: true })
      .then((body) => { setArchivedSessions(body.sessions) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }, [])

  const archiveChat = useCallback((id: string): void => {
    void patchSession(id, { archived: true })
      .then(() => {
        setSessions(previous => previous.filter(session => session.id !== id))
        setTotal(previous => Math.max(0, previous - 1))
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }, [])

  const unarchiveChat = useCallback((id: string): void => {
    void patchSession(id, { archived: false })
      .then(() => { setArchivedSessions(previous => previous.filter(session => session.id !== id)) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }, [])

  /** Rename through the inline row editor; the row updates optimistically. */
  const renameChat = useCallback((id: string, title: string): void => {
    setRenamingId(undefined)
    const trimmed = title.trim()
    if (trimmed === '') return
    const apply = (list: SessionSummary[]): SessionSummary[] =>
      list.map(session => session.id === id ? { ...session, title: trimmed } : session)
    setSessions(apply)
    setArchivedSessions(apply)
    void patchSession(id, { title: trimmed })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        refreshSessions()
      })
  }, [refreshSessions])

  const deleteChat = useCallback((id: string): void => {
    setConfirmDeleteId(undefined)
    void deleteSession(id)
      .then(() => {
        setSessions(previous => previous.filter(session => session.id !== id))
        setTotal(previous => Math.max(0, previous - 1))
        setArchivedSessions(previous => previous.filter(session => session.id !== id))
        // The deleted chat's in-flight turn, if any, dies with its stream;
        // retire its registry entry so nothing replays into the view.
        turnsRef.current.delete(id)
        setRunningIds(previous => previous.filter(one => one !== id))
        if (activeIdRef.current === id) startNewChat()
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }, [startNewChat])

  /** Create a group for the acting profile and move one chat into it. */
  const createGroupAndMove = useCallback((sessionId: string, name: string): void => {
    setNewGroupFor(undefined)
    if (activeUserId === '') return
    // The client mints the id so the follow-up move can name it.
    const groupId = `g_${randomUUID().slice(0, 8)}`
    void updateUser(activeUserId, { groups: [
      ...(users?.find(user => user.id === activeUserId)?.groups ?? []),
      { id: groupId, name },
    ] })
      .then(async (body) => {
        setUsers(body.users)
        await patchSession(sessionId, { groupId })
        setSessions(previous => previous.map(session => session.id === sessionId ? { ...session, groupId } : session))
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }, [activeUserId, users])

  const moveChat = useCallback((sessionId: string, groupId: string | null): void => {
    setMoveFor(undefined)
    void patchSession(sessionId, { groupId })
      .then(() => {
        setSessions(previous => previous.map(session => session.id === sessionId ? { ...session, groupId } : session))
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }, [])

  const openChatMenu = useCallback((id: string, clientX: number, clientY: number): void => {
    setChatMenu({ id, x: clientX, y: clientY })
  }, [])

  /**
   * Drive one model turn and stream it into the view. Both sends and retries
   * share this: `drive` performs the fetch and pumps SSE events back. Deltas
   * land in the feed at a coarse cadence — only the streaming row hears
   * them; order-critical events flush first. The turn belongs to one session:
   * its entry tracks the rows it produced, so it can finish out of view and
   * replay exactly when the user returns. `base` is the session's full row
   * list at turn start (including the just-appended user bubble for sends).
   */
  const runTurn = useCallback(async (
    drive: (onEvent: (event: StreamEvent) => void) => Promise<void>,
    sessionId: string,
    base: ChatItem[],
  ): Promise<void> => {
    const feed = new StreamFeed()
    const entry: TurnEntry = { feed, items: base, sawAssistant: false, sawCompaction: false }
    turnsRef.current.set(sessionId, entry)
    setRunningIds(previous => [...previous, sessionId])
    if (activeIdRef.current === sessionId) setFeed(feed)
    /** Row changes land in the entry always, and in the view when watched. */
    const apply = (next: ChatItem[]): void => {
      entry.items = next
      if (activeIdRef.current === sessionId) setItems(next)
    }
    const onEvent = (event: StreamEvent): void => {
      switch (event.t) {
        case 'user':
          break
        case 'delta':
          entry.sawAssistant = true
          feed.push(event.text)
          break
        case 'assistant':
          feed.flushNow()
          entry.sawAssistant = true
          feed.setFull(event.text)
          break
        case 'tool-start':
          feed.flushNow()
          apply([...entry.items, {
            role: 'tool',
            name: event.name,
            ...event.query !== undefined ? { query: event.query } : {},
            ...event.action !== undefined ? { action: event.action } : {},
            ...event.url !== undefined ? { url: event.url } : {},
            running: true,
          }])
          break
        case 'tool-end':
          feed.flushNow()
          {
            const next = [...entry.items]
            for (let index = next.length - 1; index >= 0; index--) {
              const candidate = next[index]
              if (candidate !== undefined && candidate.role === 'tool' && candidate.running === true) {
                next[index] = {
                  role: 'tool',
                  ...event.name !== undefined ? { name: event.name } : {},
                  ...event.query !== undefined ? { query: event.query } : {},
                  ...event.searchQuestion !== undefined ? { searchQuestion: event.searchQuestion } : {},
                  ...event.searchedAt !== undefined ? { searchedAt: event.searchedAt } : {},
                  ...event.sources !== undefined ? { sources: event.sources } : {},
                  ...event.action !== undefined ? { action: event.action } : {},
                  ...event.url !== undefined ? { url: event.url } : {},
                  ...event.title !== undefined ? { title: event.title } : {},
                  ...event.excerpt !== undefined ? { excerpt: event.excerpt } : {},
                  ...event.text !== undefined ? { text: event.text } : {},
                  ...event.isError === true ? { error: true } : {},
                }
                break
              }
            }
            apply(next)
          }
          break
        case 'status':
          break
        case 'compaction':
          // Old turns were replaced by a checkpoint mid-turn; the post-turn
          // refetch below lands the compacted view once the stream ends.
          entry.sawCompaction = true
          break
        case 'error':
          setError(event.message)
          break
        case 'turn-end':
          break
      }
    }
    try {
      await drive(onEvent)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      // Commit the streamed text into the row list, then retire the turn.
      const finalText = feed.reset()
      if (entry.sawAssistant && finalText !== '') {
        apply([...entry.items, { role: 'assistant', text: finalText }])
      }
      const wasActive = activeIdRef.current === sessionId
      setRunningIds(previous => previous.filter(id => id !== sessionId))
      turnsRef.current.delete(sessionId)
      if (wasActive) setFeed(undefined)
      refreshSessions()
      if (entry.sawCompaction && wasActive) {
        fetchMessages(sessionId)
          .then((fetched) => {
            if (activeIdRef.current === sessionId && turnsRef.current.get(sessionId) === undefined) setItems(fetched)
          })
          .catch(() => { /* the committed rows stay as rendered */ })
      }
    }
  }, [refreshSessions])

  const send = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    const outgoing = attachment
    const reply = replyTarget
    if ((text === '' && outgoing === undefined) || streaming) return
    // The bytes upload once, raw; only the durable reference rides the
    // message. A failed upload leaves the attachment in the composer.
    let uploaded: UploadedAttachment | undefined
    if (outgoing !== undefined) {
      try {
        uploaded = await uploadAttachment(outgoing)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err))
        return
      }
    }
    setDraft('')
    // A programmatic value change never fires onChange, so the inline height
    // the typing grew the textarea to would stick after sending; reset it.
    const node = textareaRef.current
    if (node !== null) node.style.height = 'auto'
    setAttachment(undefined)
    setReplyTarget(undefined)
    const userItem: ChatItem = {
      role: 'user',
      ...text !== '' ? { text } : {},
      ...reply !== undefined ? { replyTo: reply } : {},
      ...outgoing !== undefined
        ? {
          attachments: [{
            kind: outgoing.kind,
            name: outgoing.name,
            mediaType: outgoing.mediaType,
            ...outgoing.kind !== 'file' ? { localUrl: outgoing.localUrl } : {},
          }],
        }
        : {},
    }
    const base = [...items, userItem]
    setItems(base)
    await runTurn(onEvent => sendMessage(activeId, text, uploaded, reply, onEvent), activeId, base)
  }, [activeId, attachment, draft, items, replyTarget, runTurn, streaming])

  /** Drop the pending attachment, releasing its preview URL. */
  const removeAttachment = useCallback((): void => {
    setAttachment((current) => {
      if (current !== undefined) revokeObjectUrl(current.localUrl)
      return undefined
    })
  }, [])

  /** Re-run the trailing user turn: after a failure, or to regenerate. */
  const retry = useCallback(async (): Promise<void> => {
    if (streaming || items.length === 0) return
    // Drop the stale answer rows: everything after the last user row goes.
    let cut = items.length
    while (cut > 0 && items[cut - 1]?.role !== 'user') cut--
    const base = cut === items.length ? items : items.slice(0, cut)
    if (base !== items) setItems(base)
    await runTurn(onEvent => retrySession(activeId, onEvent), activeId, base)
  }, [activeId, items, runTurn, streaming])

  /** Make one message the reply target: the composer answers it with a
   * context chip, instead of pasting its text into the draft. */
  const beginReply = useCallback((item: ChatItem): void => {
    const target = replyTargetFor(item)
    if (target === undefined) return
    setReplyTarget(target)
    textareaRef.current?.focus()
  }, [])

  const stop = useCallback(() => {
    stopSession(activeId).catch(() => { /* the stream ends on its own */ })
  }, [activeId])

  // The context menu for one chat row: which items show depends on the
  // shelf (archived chats unarchive; grouping lives on the active shelf).
  const menuSession = (archivedView ? archivedSessions : sessions)
    .find(session => session.id === chatMenu?.id)
  const chatMenuItems: ContextMenuItem[] = menuSession === undefined || chatMenu === undefined
    ? []
    : [
      { label: 'Rename', onSelect: () => { setRenamingId(menuSession.id) } },
      menuSession.archived === true || archivedView
        ? { label: 'Unarchive', onSelect: () => { unarchiveChat(menuSession.id) } }
        : { label: 'Archive', onSelect: () => { archiveChat(menuSession.id) } },
      ...!archivedView && (activeUserInfo?.groups?.length ?? 0) > 0
        ? [{ label: 'Move to group…', onSelect: () => { setMoveFor(menuSession.id) } } satisfies ContextMenuItem]
        : [],
      ...!archivedView
        ? [{ label: 'New group…', onSelect: () => { setNewGroupFor(menuSession.id) } } satisfies ContextMenuItem]
        : [],
      { label: 'Delete', danger: true, onSelect: () => { setConfirmDeleteId(menuSession.id) } },
    ]

  // Thread-shape flags and rows, derived once per structural change (items,
  // streaming) instead of per render pass: with the rows memoized, typing
  // and streaming no longer re-render the history.
  const toolRunning = useMemo(
    () => items.some(item => item.role === 'tool' && item.running === true),
    [items],
  )
  const threadRows = useMemo(() => items.map((item, index) => {
    const trailing = index === items.length - 1
    if (item.role === 'compaction') return <CompactionRow key={index} item={item} />
    if (item.role === 'user') {
      return <UserRow key={index} item={item} trailing={trailing} streaming={streaming} onReply={beginReply} onRetry={retry} />
    }
    if (item.role === 'tool') {
      return (
        <div key={index} className="row tool">
          <ToolChip item={item} />
        </div>
      )
    }
    return <AssistantRow
      key={index}
      item={item}
      trailing={trailing}
      streaming={streaming}
      onReply={beginReply}
      onRetry={retry}
      avatar={botAvatar}
      onAvatarClick={openCharacterMenu}
    />
  }), [items, streaming, beginReply, retry, botAvatar, openCharacterMenu])

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
        {archivedView
          ? (
            <button type="button" className="new-chat" onClick={() => { setArchivedView(false) }}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M10 3.5L5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              All chats
            </button>
          )
          : (
            <button type="button" className="new-chat" onClick={startNewChat}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              New chat
            </button>
          )}
        {!archivedView
          ? (
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
          )
          : undefined}
        <nav className="session-list" aria-label="Conversations" ref={listRef} onScroll={handleListScroll}>
          <SessionListBody
            searchActive={searchActive}
            hits={hits}
            sessions={archivedView ? archivedSessions : sessions}
            activeId={activeId}
            searching={searching}
            loadingMore={loadingMore}
            runningIds={runningIds}
            onSelect={selectSession}
            groups={archivedView ? [] : (activeUserInfo?.groups ?? [])}
            grouped={!searchActive && !archivedView}
            renamingId={renamingId}
            onRenameSubmit={renameChat}
            onRenameCancel={() => { setRenamingId(undefined) }}
            onContext={openChatMenu}
          />
        </nav>
        <div className="sidebar-footer">
          {!archivedView
            ? <button type="button" className="archived-toggle" onClick={openArchived}>Archived</button>
            : undefined}
          <div className="user-row">
            <button
              type="button"
              className="user-avatar-btn"
              aria-label="Switch user"
              title="Switch user"
              onClick={() => { setUserMenuOpen(!userMenuOpen) }}
              onContextMenu={(event) => {
                event.preventDefault()
                setUserMenuOpen(true)
              }}
            >
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
            </button>
            <button type="button" className="user-main" onClick={() => { setSettingsOpen(true) }}>
              <span className="user-name">{activeUserInfo?.name ?? 'catonooka'}</span>
              <svg className="user-gear" viewBox="0 0 16 16" aria-hidden="true">
                <line x1="2" y1="4.5" x2="14" y2="4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="6" cy="4.5" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <line x1="2" y1="11.5" x2="14" y2="11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="10" cy="11.5" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          </div>
          {userMenuOpen && users !== undefined
            ? (
              <UserMenu
                users={users}
                activeUserId={activeUserId}
                onSwitch={switchUser}
                onAdd={() => {
                  setUserMenuOpen(false)
                  setAddUserOpen(true)
                }}
                onManage={() => {
                  setUserMenuOpen(false)
                  setSettingsOpen(true)
                }}
                onClose={() => { setUserMenuOpen(false) }}
              />
            )
            : undefined}
        </div>
      </aside>
      <main className="main">
        {collapsed
          ? (
            <div className="collapsed-bar">
              <button
                type="button"
                className="icon-btn open-sidebar-btn"
                aria-label="Open sidebar"
                onClick={() => { setCollapsed(false) }}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <line x1="5.5" y1="2.5" x2="5.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
              <button type="button" className="icon-btn new-chat-btn" aria-label="New chat" title="New chat" onClick={startNewChat}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )
          : undefined}
        <div className="thread" ref={threadRef}>
          {items.length === 0 && feed === undefined
            ? (
              <div className="welcome">
                <button
                  type="button"
                  className="welcome-mark"
                  aria-label="Switch model character"
                  onClick={openCharacterMenu}
                >
                  <img src={botAvatar} alt="" draggable={false} />
                </button>
                <div className="welcome-title">{config?.greeting ?? 'What can I help with?'}</div>
                {activeCharacter !== undefined
                  ? <div className="welcome-sub">{activeCharacter.name}</div>
                  : undefined}
              </div>
            )
            : (
              <div className="thread-inner">
                {threadRows}
                {streaming
                  ? (
                    <div className="row assistant">
                      <button
                        type="button"
                        className="assistant-avatar"
                        aria-label="Switch model character"
                        onClick={openCharacterMenu}
                      >
                        <img src={botAvatar} alt="" draggable={false} />
                      </button>
                      <StreamTurn feed={feed ?? new StreamFeed()} searching={toolRunning} follow={followStream} />
                    </div>
                  )
                  : undefined}
                {!streaming && items.length > 0 && items[items.length - 1]?.role !== 'assistant'
                  ? (
                    <div className="retry-hint">
                      <button type="button" onClick={() => { void retry() }}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          <path d="M13.7 1.8v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        Try again
                      </button>
                    </div>
                  )
                  : undefined}
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
          {attachment !== undefined
            ? (
              <div className="attachment-chip">
                {attachment.kind === 'image'
                  ? <img src={attachment.localUrl} alt="" />
                  : attachment.kind === 'video'
                    ? <video src={attachment.localUrl} muted playsInline />
                    : (
                      <svg className="attachment-doc" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M4 1.5h5L12.5 5v9.5a1.2 1.2 0 0 1-1 1H4a1.2 1.2 0 0 1-1-1v-12a1.2 1.2 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                        <path d="M9 1.5V5h3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                      </svg>
                    )}
                <span className="attachment-name">{attachment.name}</span>
                <button type="button" aria-label="Remove attachment" onClick={removeAttachment}>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            )
            : undefined}
          {replyTarget !== undefined
            ? (
              <div className="reply-chip">
                <svg className="reply-chip-icon" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M14 7.5c0 3-2.7 4.5-6 4.5-.7 0-1.4-.1-2-.2L3 14l.9-2.7C2.7 10.5 2 9.5 2 7.5 2 4.5 4.7 3 8 3s6 1.5 6 4.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                </svg>
                <span className="reply-chip-body">
                  <span className="reply-chip-label">{replyLabel(replyTarget.role)}</span>
                  <span className="reply-chip-text">{replyTarget.text}</span>
                </span>
                <button type="button" aria-label="Cancel reply" onClick={() => { setReplyTarget(undefined) }}>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
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
            {(acceptsImages || acceptsVideos)
              ? (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={attachAccept}
                    className="attach-input"
                    onChange={(event) => {
                      pickAttachment(event.target.files?.[0])
                      event.target.value = ''
                    }}
                  />
                  <button
                    type="button"
                    className="icon-btn attach-btn"
                    aria-label="Attach image or video"
                    onClick={() => { fileInputRef.current?.click() }}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M13.5 6.5l-6 6a3 3 0 0 1-4.2-4.2l6.4-6.4a2 2 0 0 1 2.8 2.8l-6.3 6.4a1 1 0 0 1-1.4-1.4l5.7-5.7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                </>
              )
              : undefined}
            <textarea
              ref={textareaRef}
              value={draft}
              placeholder="Message dsh chat…"
              rows={1}
              onPaste={handleComposerPaste}
              onDrop={handleComposerDrop}
              onChange={(event) => {
                setDraft(event.target.value)
                const node = event.target
                node.style.height = 'auto'
                node.style.height = `${String(Math.min(node.scrollHeight, 200))}px`
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && replyTarget !== undefined) {
                  setReplyTarget(undefined)
                  return
                }
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
                <button type="submit" className="send" aria-label="Send message" disabled={draft.trim() === '' && attachment === undefined}>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8 13V3.5M8 3.5L3.8 7.7M8 3.5l4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
          </form>
          <div className="composer-note">dsh chat can make mistakes. It searches the web with one internal tool.</div>
        </div>
      </main>
      {users !== undefined && avatar === null && !addUserOpen && !userMenuOpen
        ? <AvatarModal onPick={applyAvatar} />
        : undefined}
      {addUserOpen
        ? <AddUserModal onCreate={addUser} onClose={() => { setAddUserOpen(false) }} />
        : undefined}
      {newCharacterOpen
        ? <NewCharacterModal onCreate={createCharacter} onClose={() => { setNewCharacterOpen(false) }} />
        : undefined}
      {renameCharacterOpen && activeCharacter !== undefined
        ? (
          <RenameCharacterDialog
            current={activeCharacter.name}
            onRename={renameCharacter}
            onClose={() => { setRenameCharacterOpen(false) }}
          />
        )
        : undefined}
      {chatMenu !== undefined
        ? (
          <ContextMenu
            x={chatMenu.x}
            y={chatMenu.y}
            items={chatMenuItems}
            onClose={() => { setChatMenu(undefined) }}
          />
        )
        : undefined}
      {characterMenu !== undefined && config?.profiles !== undefined
        ? (
          <CharacterMenu
            x={characterMenu.x}
            y={characterMenu.y}
            characters={config.profiles}
            activeId={config.activeProfileId}
            onSwitch={switchCharacter}
            onRename={() => { setRenameCharacterOpen(true) }}
            onNew={() => { setNewCharacterOpen(true) }}
            onManage={() => { setSettingsOpen(true) }}
            onClose={() => { setCharacterMenu(undefined) }}
          />
        )
        : undefined}
      {newGroupFor !== undefined
        ? (
          <NewGroupDialog
            chatTitle={(archivedView ? archivedSessions : sessions).find(session => session.id === newGroupFor)?.title ?? 'This chat'}
            onCreate={(name) => { createGroupAndMove(newGroupFor, name) }}
            onClose={() => { setNewGroupFor(undefined) }}
          />
        )
        : undefined}
      {moveFor !== undefined
        ? (
          <MoveGroupDialog
            groups={activeUserInfo?.groups ?? []}
            current={sessions.find(session => session.id === moveFor)?.groupId ?? null}
            onMove={(groupId) => { moveChat(moveFor, groupId) }}
            onClose={() => { setMoveFor(undefined) }}
          />
        )
        : undefined}
      {confirmDeleteId !== undefined
        ? (
          <ConfirmDeleteDialog
            chatTitle={(archivedView ? archivedSessions : sessions).find(session => session.id === confirmDeleteId)?.title ?? 'This chat'}
            onConfirm={() => { deleteChat(confirmDeleteId) }}
            onClose={() => { setConfirmDeleteId(undefined) }}
          />
        )
        : undefined}
      {settingsOpen && config !== undefined
        ? (
          <SettingsPanel
            config={config}
            theme={theme}
            onTheme={setTheme}
            avatar={avatar}
            onAvatar={applyAvatar}
            users={users}
            activeUserId={activeUserId}
            onSwitchUser={switchUser}
            onUsersUpdated={setUsers}
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
