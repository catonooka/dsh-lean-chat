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
import { chmod, mkdir, writeFile } from 'node:fs/promises'
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

/** Avatar tiles shipped with the frontend (`apps/chat/public/avatars`). */
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
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, { mode: 0o600, flag: 'w' })
  // `mode` only applies at creation; re-assert it for pre-existing files.
  await chmod(path, 0o600)
}
