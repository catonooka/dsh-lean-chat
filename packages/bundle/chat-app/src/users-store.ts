/**
 * Lightweight app users for the chat surface: one shared login token still
 * guards every route, but named profiles — each with their own avatar, chat
 * list, groups, and preferred Chrome profile — ride on top of it. The store
 * is a single JSON file under the dsh home, parsed defensively (a corrupt
 * file falls back to one default user, never a boot gate) and mutated in
 * place by the helpers, mirroring how the settings object behaves.
 *
 * @module @deepseek-ai/dsh-chat-app
 */

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Name given to the first user on a fresh store (matches the pre-users UI). */
export const DEFAULT_USER_NAME = 'catonooka'

/** Longest accepted user display name. */
export const MAX_USER_NAME_LENGTH = 40

/** Most users worth keeping in one panel. */
export const MAX_USERS = 12

/** Longest accepted group display name. */
export const MAX_GROUP_NAME_LENGTH = 60

/** Most groups worth keeping per user. */
export const MAX_GROUPS_PER_USER = 20

/** User-profile avatar tiles shipped with the frontend
 * (`apps/chat/public/avatars`): the ten cat tiles. The robot tiles
 * (11-30) are model-character avatars and never valid for a user. */
export const AVATAR_COUNT = 10

/** The bridge clamps client labels to 64 chars; match it for saved profiles. */
const MAX_CHROME_PROFILE_LENGTH = 64

/** Chat session ids accepted by the API (`/^[a-zA-Z0-9-]{1,64}$/`). */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/

/** Header every API call may carry to name the acting user profile. */
export const USER_HEADER = 'x-dsh-user'

/** One named chat group a user organizes their chats into. */
export interface ChatGroup {
  /** Stable id; renaming never changes it. */
  id: string
  name: string
}

/** One lightweight user profile. */
export interface ChatUser {
  /** Stable id; renaming never changes it. */
  id: string
  name: string
  /** Avatar tile 1..AVATAR_COUNT; absent = the placeholder silhouette. */
  avatar?: number
  /** Chrome profile label this user's browser steps default to. */
  chromeProfile?: string
  groups: ChatGroup[]
}

/** Per-session bookkeeping: who owns a chat and how it is organized. */
export interface SessionUserMeta {
  owner: string
  /** Epoch ms when the chat was archived; absent = active. */
  archivedAt?: number
  /** Group id within the owner's groups; absent = ungrouped. */
  groupId?: string
}

/** The whole persisted users file. */
export interface ChatUsers {
  users: ChatUser[]
  sessions: Record<string, SessionUserMeta>
}

/** Mint a fresh user id (short, readable, unique within a store). */
export function newUserId(): string {
  return `u_${randomUUID().slice(0, 8)}`
}

/** Mint a fresh group id. */
export function newGroupId(): string {
  return `g_${randomUUID().slice(0, 8)}`
}

/** A one-line name for a user, or `undefined` when the input is unusable. */
export function normalizeUserName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.trim().replace(/\s+/g, ' ')
  if (name.length === 0 || name.length > MAX_USER_NAME_LENGTH) return undefined
  return name
}

/** An avatar tile number, or `undefined` when the input is unusable. */
export function normalizeAvatar(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined
  if (raw < 1 || raw > AVATAR_COUNT) return undefined
  return raw
}

/** A Chrome profile label, or `undefined` when unset/blank/unusable. */
export function normalizeChromeProfile(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') return undefined
  const label = raw.trim()
  if (label.length === 0 || label.length > MAX_CHROME_PROFILE_LENGTH) return undefined
  return label
}

/** A group name, or `undefined` when the input is unusable. */
export function normalizeGroupName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.trim().replace(/\s+/g, ' ')
  if (name.length === 0 || name.length > MAX_GROUP_NAME_LENGTH) return undefined
  return name
}

/** One sanitized group, or `undefined` when the entry is unusable. */
function parseGroup(raw: unknown): ChatGroup | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0) return undefined
  const name = normalizeGroupName(record.name)
  return name === undefined ? undefined : { id: record.id, name }
}

/** One sanitized user, or `undefined` when the entry is unusable. */
function parseUser(raw: unknown): ChatUser | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0) return undefined
  const name = normalizeUserName(record.name) ?? DEFAULT_USER_NAME
  const avatar = normalizeAvatar(record.avatar)
  const chromeProfile = normalizeChromeProfile(record.chromeProfile)
  const groups: ChatGroup[] = []
  if (Array.isArray(record.groups)) {
    for (const entry of record.groups) {
      const group = parseGroup(entry)
      if (group !== undefined && !groups.some(existing => existing.id === group.id)) groups.push(group)
    }
  }
  return {
    id: record.id,
    name,
    ...avatar !== undefined ? { avatar } : {},
    ...chromeProfile !== undefined ? { chromeProfile } : {},
    groups,
  }
}

/**
 * Load the users file over a one-default-user base. A missing or corrupt
 * file falls back to that base — same contract as the settings file, the
 * store is convenience and never a boot gate.
 * @param raw - the file contents, or `undefined` when no file exists yet.
 */
export function parseUsersFile(raw: string | undefined): ChatUsers {
  const users: ChatUser[] = []
  const sessions: Record<string, SessionUserMeta> = {}
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        if (Array.isArray(record.users)) {
          for (const entry of record.users) {
            const user = parseUser(entry)
            if (user !== undefined && !users.some(existing => existing.id === user.id)) users.push(user)
          }
        }
        if (typeof record.sessions === 'object' && record.sessions !== null && !Array.isArray(record.sessions)) {
          for (const [sessionId, metaRaw] of Object.entries(record.sessions as Record<string, unknown>)) {
            if (!SESSION_ID_PATTERN.test(sessionId)) continue
            if (typeof metaRaw !== 'object' || metaRaw === null) continue
            const meta = metaRaw as Record<string, unknown>
            if (typeof meta.owner !== 'string' || meta.owner.length === 0) continue
            const archivedAt = typeof meta.archivedAt === 'number' && Number.isFinite(meta.archivedAt)
              ? meta.archivedAt
              : undefined
            const groupId = typeof meta.groupId === 'string' && meta.groupId.length > 0 ? meta.groupId : undefined
            sessions[sessionId] = {
              owner: meta.owner,
              ...archivedAt !== undefined ? { archivedAt } : {},
              ...groupId !== undefined ? { groupId } : {},
            }
          }
        }
      }
    } catch {
      // Corrupt file: the default user stands.
    }
  }
  if (users.length === 0) users.push({ id: newUserId(), name: DEFAULT_USER_NAME, groups: [] })
  return { users, sessions }
}

/** The user requests act on when the header is absent: always the first. */
export function defaultUser(users: readonly ChatUser[]): ChatUser {
  // parseUsersFile keeps the roster non-empty; the synthetic fallback only
  // satisfies the index-access type for hand-built lists.
  return users[0] ?? { id: 'u_default', name: DEFAULT_USER_NAME, groups: [] }
}

/**
 * Resolve the acting user from the `x-dsh-user` header value.
 * @param header - the raw header value (`undefined`/empty when absent).
 * @param users - the store's users (always at least one).
 * @returns the named user, the default when no header names one, or
 * `undefined` when the header names a user this store does not know — the
 * caller refuses the request so the client can self-heal.
 */
export function activeUserFromHeader(header: unknown, users: readonly ChatUser[]): ChatUser | undefined {
  if (typeof header !== 'string' || header.trim() === '') return defaultUser(users)
  return users.find(user => user.id === header.trim())
}

/** Project the store into the JSON body served by `GET /api/users`. */
export function usersJson(users: readonly ChatUser[]): Record<string, unknown> {
  return {
    users: users.map(user => ({
      id: user.id,
      name: user.name,
      ...user.avatar !== undefined ? { avatar: user.avatar } : {},
      ...user.chromeProfile !== undefined ? { chromeProfile: user.chromeProfile } : {},
      groups: user.groups.map(group => ({ id: group.id, name: group.name })),
    })),
    defaultUserId: defaultUser(users).id,
  }
}

/**
 * Create a user from panel input, mutating the store.
 * @param users - the store to mutate.
 * @param input - `{name, avatar?, chromeProfile?}` raw panel values.
 * @returns the created user.
 * @throws when the store is full or the name is unusable.
 */
export function createUser(users: ChatUsers, input: Record<string, unknown>): ChatUser {
  if (users.users.length >= MAX_USERS) throw new Error(`at most ${String(MAX_USERS)} users are supported`)
  const name = normalizeUserName(input.name)
  if (name === undefined) {
    throw new Error(`user name must be 1-${String(MAX_USER_NAME_LENGTH)} visible characters`)
  }
  const avatar = normalizeAvatar(input.avatar)
  const chromeProfile = normalizeChromeProfile(input.chromeProfile)
  const user: ChatUser = {
    id: newUserId(),
    name,
    ...avatar !== undefined ? { avatar } : {},
    ...chromeProfile !== undefined ? { chromeProfile } : {},
    groups: [],
  }
  users.users.push(user)
  return user
}

/**
 * Apply panel edits to one user, mutating the store in place.
 * @param users - the store to mutate.
 * @param userId - the user being edited.
 * @param patch - `{name?, avatar?, chromeProfile?}` raw panel values; a
 * blank `chromeProfile` unsets it.
 * @returns the updated user.
 * @throws when the user is unknown or a provided value is unusable.
 */
export function updateUser(
  users: ChatUsers,
  userId: string,
  patch: Record<string, unknown>,
): ChatUser {
  const user = users.users.find(entry => entry.id === userId)
  if (user === undefined) throw new Error(`unknown user "${userId}"`)
  if (patch.name !== undefined) {
    const name = normalizeUserName(patch.name)
    if (name === undefined) {
      throw new Error(`user name must be 1-${String(MAX_USER_NAME_LENGTH)} visible characters`)
    }
    user.name = name
  }
  if (patch.avatar !== undefined) {
    const avatar = normalizeAvatar(patch.avatar)
    if (avatar === undefined) throw new Error(`avatar must be an integer 1-${String(AVATAR_COUNT)}`)
    user.avatar = avatar
  }
  if (patch.chromeProfile !== undefined) {
    // Blank unsets: "any connected profile" again.
    const chromeProfile = normalizeChromeProfile(patch.chromeProfile)
    if (chromeProfile === undefined) delete user.chromeProfile
    else user.chromeProfile = chromeProfile
  }
  return user
}

/**
 * Claim every session id that no owner has yet for one user — the one-time
 * migration that keeps existing chats visible when the store first appears.
 * @param users - the store to mutate.
 * @param sessionIds - every known chat session id.
 * @param userId - the user the unclaimed chats belong to.
 * @returns whether anything changed (the caller persists when it did).
 */
export function assignUnownedSessions(
  users: ChatUsers,
  sessionIds: readonly string[],
  userId: string,
): boolean {
  let changed = false
  for (const sessionId of sessionIds) {
    if (users.sessions[sessionId] !== undefined) continue
    users.sessions[sessionId] = { owner: userId }
    changed = true
  }
  return changed
}

/**
 * Claim one chat for a user — the first message wins and ownership never
 * moves, so a chat stays with the profile that started it across switches.
 * @param users - the store to mutate.
 * @param sessionId - the chat being claimed.
 * @param userId - the user claiming it.
 * @returns whether the store changed (the caller persists when it did).
 */
export function ensureSessionOwner(users: ChatUsers, sessionId: string, userId: string): boolean {
  if (users.sessions[sessionId] !== undefined) return false
  users.sessions[sessionId] = { owner: userId }
  return true
}

/**
 * Replace one user's groups wholesale: entries keep their id when they carry
 * one (a rename) and get a fresh id when they do not (a new group).
 * @param users - the store to mutate.
 * @param userId - the user whose groups are being replaced.
 * @param raw - the raw panel value (an array of `{id?, name}`).
 * @returns the updated user.
 * @throws when the user is unknown, the value is not an array, or a name is
 * unusable or the roster of groups exceeds its cap.
 */
export function applyUserGroups(users: ChatUsers, userId: string, raw: unknown): ChatUser {
  const user = users.users.find(entry => entry.id === userId)
  if (user === undefined) throw new Error(`unknown user "${userId}"`)
  if (!Array.isArray(raw)) throw new Error('groups must be an array of {id?, name}')
  if (raw.length > MAX_GROUPS_PER_USER) {
    throw new Error(`at most ${String(MAX_GROUPS_PER_USER)} groups are supported per user`)
  }
  const groups: ChatGroup[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) throw new Error('groups must be an array of {id?, name}')
    const record = entry as Record<string, unknown>
    const name = normalizeGroupName(record.name)
    if (name === undefined) {
      throw new Error(`group names must be 1-${String(MAX_GROUP_NAME_LENGTH)} visible characters`)
    }
    const id = typeof record.id === 'string' && record.id.length > 0 && !seen.has(record.id)
      ? record.id
      : newGroupId()
    seen.add(id)
    groups.push({ id, name })
  }
  user.groups = groups
  return user
}

/**
 * Drop group references that no longer resolve after a group edit — a
 * deleted group's chats simply fall back to ungrouped.
 * @param users - the store to mutate.
 * @param userId - the user whose sessions are being pruned.
 * @returns whether anything changed (the caller persists when it did).
 */
export function pruneSessionGroups(users: ChatUsers, userId: string): boolean {
  const user = users.users.find(entry => entry.id === userId)
  if (user === undefined) return false
  const valid = new Set(user.groups.map(group => group.id))
  let changed = false
  for (const meta of Object.values(users.sessions)) {
    if (meta.owner !== userId || meta.groupId === undefined) continue
    if (valid.has(meta.groupId)) continue
    delete meta.groupId
    changed = true
  }
  return changed
}

/**
 * Stamp or clear one chat's archive mark. Archiving again keeps the original
 * stamp (the shelf sorts by it).
 * @returns whether the store changed (the caller persists when it did).
 */
export function setSessionArchived(
  users: ChatUsers,
  sessionId: string,
  archived: boolean,
  now: number,
): boolean {
  const meta = users.sessions[sessionId]
  if (meta === undefined) return false
  if (archived) {
    if (meta.archivedAt !== undefined) return false
    meta.archivedAt = now
    return true
  }
  if (meta.archivedAt === undefined) return false
  delete meta.archivedAt
  return true
}

/**
 * Point one chat at a group, or ungroup it with `null`.
 * @returns whether the store changed (the caller persists when it did).
 */
export function setSessionGroup(users: ChatUsers, sessionId: string, groupId: string | null): boolean {
  const meta = users.sessions[sessionId]
  if (meta === undefined) return false
  if (groupId === null) {
    if (meta.groupId === undefined) return false
    delete meta.groupId
    return true
  }
  if (meta.groupId === groupId) return false
  meta.groupId = groupId
  return true
}

/**
 * Forget one chat's bookkeeping after the chat itself is deleted.
 * @returns whether anything was there to drop.
 */
export function removeSessionMeta(users: ChatUsers, sessionId: string): boolean {
  if (users.sessions[sessionId] === undefined) return false
  // Rebuild rather than a dynamic delete: chat deletions are rare, and the
  // store's JSON shape stays a plain record either way.
  const next: Record<string, SessionUserMeta> = {}
  for (const [id, meta] of Object.entries(users.sessions)) {
    if (id !== sessionId) next[id] = meta
  }
  users.sessions = next
  return true
}

/**
 * Write a secrets-bearing file atomically: the body lands in a uniquely named
 * sibling temp file first and a rename then swaps it into place, so a crash
 * mid-write can never truncate what is already stored. The directory is
 * created owner-only and the mode is re-asserted because `mode` on write only
 * applies at file creation.
 */
export async function writeFileAtomic(path: string, body: string, mode = 0o600): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(temp, body, { mode, flag: 'w' })
  await chmod(temp, mode)
  try {
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** Persist the users file; failures log but never break the request. */
export async function persistUsers(path: string, users: ChatUsers): Promise<void> {
  const body = `${JSON.stringify({
    users: users.users.map(user => ({
      id: user.id,
      name: user.name,
      ...user.avatar !== undefined ? { avatar: user.avatar } : {},
      ...user.chromeProfile !== undefined ? { chromeProfile: user.chromeProfile } : {},
      groups: user.groups.map(group => ({ id: group.id, name: group.name })),
    })),
    sessions: users.sessions,
  }, null, 2)}\n`
  await writeFileAtomic(path, body)
}
