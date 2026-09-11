/**
 * Unit coverage for the avatar helpers: the fixed set, validation of stored
 * values, and the served image URLs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AVATAR_COUNT, BOT_AVATAR_SRC, avatarSrc, normalizeAvatar, readStoredAvatar, storeAvatar } from '../src/avatar.ts'

describe('normalizeAvatar', () => {
  it('accepts each avatar number as a stored string', () => {
    expect(normalizeAvatar('1')).toBe(1)
    expect(normalizeAvatar(String(AVATAR_COUNT))).toBe(AVATAR_COUNT)
  })

  it('rejects unset, out-of-range, fractional, and garbage values', () => {
    expect(normalizeAvatar(null)).toBeNull()
    expect(normalizeAvatar('0')).toBeNull()
    expect(normalizeAvatar('31')).toBeNull()
    expect(normalizeAvatar('-1')).toBeNull()
    expect(normalizeAvatar('2.5')).toBeNull()
    expect(normalizeAvatar('avatar-3')).toBeNull()
    expect(normalizeAvatar('')).toBeNull()
  })
})

describe('stored avatar', () => {
  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  const storage = () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
      clear: () => { store.clear() },
    })
    return store
  }

  it('round-trips a choice and reads unset as null', () => {
    storage()
    expect(readStoredAvatar()).toBeNull()
    storeAvatar(7)
    expect(readStoredAvatar()).toBe(7)
  })

  it('falls back to unset when the stored value drifted', () => {
    const store = storage()
    store.set('dsh-chat-avatar', '99')
    expect(readStoredAvatar()).toBeNull()
  })
})

describe('bot avatar', () => {
  it('points at the served chat bot image', () => {
    expect(BOT_AVATAR_SRC).toBe('bot-avatar.png')
  })
})

describe('avatarSrc', () => {
  it('points every avatar at its served tile', () => {
    expect(avatarSrc(1)).toBe('avatars/avatar-1.png')
    expect(avatarSrc(10)).toBe('avatars/avatar-10.png')
    expect(avatarSrc(11)).toBe('avatars/avatar-11.png')
    expect(avatarSrc(30)).toBe('avatars/avatar-30.png')
  })

  it('serves thirty tiles: ten people plus twenty robot characters', () => {
    expect(AVATAR_COUNT).toBe(30)
  })
})
