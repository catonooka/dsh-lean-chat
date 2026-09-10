/**
 * Unit coverage for the lightweight users store: parsing invariants, header
 * resolution, and the create/update/migration mutations.
 */

import { describe, expect, it } from 'vitest'
import {
  activeUserFromHeader,
  assignUnownedSessions,
  createUser,
  defaultUser,
  ensureSessionOwner,
  normalizeAvatar,
  normalizeChromeProfile,
  normalizeGroupName,
  normalizeUserName,
  parseUsersFile,
  updateUser,
  usersJson,
  type ChatUsers,
} from '../src/users-store.ts'

function storeOf(users: string[], sessions: Record<string, { owner: string }> = {}): ChatUsers {
  return {
    users: users.map(name => ({ id: `u_${name}`, name, groups: [] })),
    sessions,
  }
}

describe('normalizeUserName', () => {
  it('trims and collapses whitespace within the length cap', () => {
    expect(normalizeUserName('  Ada  ')).toBe('Ada')
    expect(normalizeUserName('Ada\n Lovelace')).toBe('Ada Lovelace')
    expect(normalizeUserName('x'.repeat(41))).toBeUndefined()
  })

  it('refuses blank and non-string names', () => {
    expect(normalizeUserName('')).toBeUndefined()
    expect(normalizeUserName('   ')).toBeUndefined()
    expect(normalizeUserName(42)).toBeUndefined()
    expect(normalizeUserName(null)).toBeUndefined()
  })
})

describe('normalizeAvatar / normalizeChromeProfile / normalizeGroupName', () => {
  it('accepts tiles 1-10 and refuses everything else', () => {
    expect(normalizeAvatar(1)).toBe(1)
    expect(normalizeAvatar(10)).toBe(10)
    expect(normalizeAvatar(0)).toBeUndefined()
    expect(normalizeAvatar(11)).toBeUndefined()
    expect(normalizeAvatar(3.5)).toBeUndefined()
    expect(normalizeAvatar('3')).toBeUndefined()
  })

  it('treats a blank chrome profile as unset and caps the label', () => {
    expect(normalizeChromeProfile('work')).toBe('work')
    expect(normalizeChromeProfile('  ')).toBeUndefined()
    expect(normalizeChromeProfile(undefined)).toBeUndefined()
    expect(normalizeChromeProfile('x'.repeat(65))).toBeUndefined()
  })

  it('keeps group names one-line and visible', () => {
    expect(normalizeGroupName(' X research ')).toBe('X research')
    expect(normalizeGroupName('')).toBeUndefined()
    expect(normalizeGroupName('x'.repeat(61))).toBeUndefined()
  })
})

describe('parseUsersFile', () => {
  it('falls back to one default user for a missing or corrupt file', () => {
    for (const raw of [undefined, 'not json', '[]', '{"users":"nope"}', '{"users":[null,42]}']) {
      const users = parseUsersFile(raw)
      expect(users.users).toHaveLength(1)
      expect(users.users[0]?.name).toBe('catonooka')
      expect(users.users[0]?.groups).toEqual([])
      expect(Object.keys(users.sessions)).toHaveLength(0)
    }
  })

  it('sanitizes users and per-session meta, dropping junk', () => {
    const users = parseUsersFile(JSON.stringify({
      users: [
        { id: 'u_a', name: 'Alice', avatar: 3, chromeProfile: 'work', groups: [{ id: 'g1', name: 'X' }, { id: 'g1', name: 'Dup' }, 'junk'] },
        { id: 'u_a', name: 'Duplicate id dropped' },
        { id: '', name: 'No id dropped' },
        { id: 'u_b', name: '', groups: 'junk' },
      ],
      sessions: {
        'sess-1': { owner: 'u_a', archivedAt: 123, groupId: 'g1' },
        'sess-2': { owner: 'u_b' },
        'bad session id!': { owner: 'u_a' },
        'sess-3': { owner: '' },
        'sess-4': 'junk',
      },
    }))
    expect(users.users.map(user => user.id)).toEqual(['u_a', 'u_b'])
    expect(users.users[0]).toEqual({
      id: 'u_a', name: 'Alice', avatar: 3, chromeProfile: 'work', groups: [{ id: 'g1', name: 'X' }],
    })
    // An unusable name keeps the default name rather than dropping the user.
    expect(users.users[1]?.name).toBe('catonooka')
    expect(Object.keys(users.sessions).sort()).toEqual(['sess-1', 'sess-2'])
    expect(users.sessions['sess-1']).toEqual({ owner: 'u_a', archivedAt: 123, groupId: 'g1' })
    expect(users.sessions['sess-2']).toEqual({ owner: 'u_b' })
  })
})

describe('activeUserFromHeader', () => {
  const users = storeOf(['alice', 'bob']).users

  it('uses the first user when the header is absent or blank', () => {
    expect(activeUserFromHeader(undefined, users)?.id).toBe('u_alice')
    expect(activeUserFromHeader('', users)?.id).toBe('u_alice')
    expect(activeUserFromHeader('  ', users)?.id).toBe('u_alice')
  })

  it('resolves the named user and trims the header', () => {
    expect(activeUserFromHeader('u_bob', users)?.id).toBe('u_bob')
    expect(activeUserFromHeader(' u_bob ', users)?.id).toBe('u_bob')
  })

  it('refuses a header naming an unknown user so the client can self-heal', () => {
    expect(activeUserFromHeader('u_nobody', users)).toBeUndefined()
    expect(activeUserFromHeader(42, users)?.id).toBe('u_alice')
  })
})

describe('createUser / updateUser', () => {
  it('creates a user from panel input and reports it in usersJson', () => {
    const users = parseUsersFile(undefined)
    const created = createUser(users, { name: 'Bob', avatar: 2, chromeProfile: 'work' })
    expect(created.name).toBe('Bob')
    expect(users.users).toHaveLength(2)
    const body = usersJson(users.users) as { users: { id: string; name: string }[]; defaultUserId: string }
    expect(body.users.map(user => user.name)).toEqual(['catonooka', 'Bob'])
    expect(body.defaultUserId).toBe(users.users[0]?.id)
  })

  it('refuses unusable names and caps the roster', () => {
    const users = parseUsersFile(undefined)
    expect(() => createUser(users, { name: '   ' })).toThrow(/user name/)
    for (let index = 0; index < 11; index += 1) createUser(users, { name: `u${String(index)}` })
    expect(() => createUser(users, { name: 'one too many' })).toThrow(/at most/)
  })

  it('updates only the provided fields and unsets chromeProfile on blank', () => {
    const users = parseUsersFile(undefined)
    const first = users.users[0]
    if (first === undefined) throw new Error('test setup: parse produced no default user')
    updateUser(users, first.id, { name: 'Renamed', avatar: 7, chromeProfile: 'work' })
    expect(first).toEqual({ id: first.id, name: 'Renamed', avatar: 7, chromeProfile: 'work', groups: [] })
    updateUser(users, first.id, { chromeProfile: '' })
    expect(first.chromeProfile).toBeUndefined()
    expect(first.name).toBe('Renamed')
    expect(() => updateUser(users, first.id, { avatar: 99 })).toThrow(/avatar/)
    expect(() => updateUser(users, 'u_ghost', { name: 'Nope' })).toThrow(/unknown user/)
  })
})

describe('assignUnownedSessions', () => {
  it('claims only unowned sessions and reports whether it changed anything', () => {
    const users = storeOf(['alice'], { 'kept-1': { owner: 'u_bob' } })
    expect(assignUnownedSessions(users, ['kept-1', 'fresh-1', 'fresh-2'], 'u_alice')).toBe(true)
    expect(users.sessions).toEqual({
      'kept-1': { owner: 'u_bob' },
      'fresh-1': { owner: 'u_alice' },
      'fresh-2': { owner: 'u_alice' },
    })
    expect(assignUnownedSessions(users, ['fresh-1'], 'u_alice')).toBe(false)
  })
})

describe('ensureSessionOwner', () => {
  it('claims on first message and never moves an existing owner', () => {
    const users = storeOf(['alice', 'bob'])
    expect(ensureSessionOwner(users, 'sess-1', 'u_alice')).toBe(true)
    expect(users.sessions['sess-1']).toEqual({ owner: 'u_alice' })
    expect(ensureSessionOwner(users, 'sess-1', 'u_bob')).toBe(false)
    expect(users.sessions['sess-1']).toEqual({ owner: 'u_alice' })
  })
})

describe('defaultUser', () => {
  it('always answers the first user (parse keeps the roster non-empty)', () => {
    expect(defaultUser(storeOf(['alice', 'bob']).users).name).toBe('alice')
  })
})
