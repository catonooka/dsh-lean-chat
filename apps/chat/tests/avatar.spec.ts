/**
 * Unit coverage for the avatar helpers: the fixed set, validation of stored
 * values, and the served image URLs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  AVATAR_COUNT, BOT_AVATAR_COUNT, BOT_AVATAR_FIRST, BOT_AVATAR_SRC, avatarSrc, botAvatarSrc,
  botAvatarTiles, normalizeAvatar, readStoredAvatar, storeAvatar,
} from '../src/avatar.ts'

describe('normalizeAvatar', () => {
  it('accepts each cat tile number as a stored string', () => {
    expect(normalizeAvatar('1')).toBe(1)
    expect(normalizeAvatar(String(AVATAR_COUNT))).toBe(AVATAR_COUNT)
  })

  it('rejects unset, out-of-range, robot, fractional, and garbage values', () => {
    expect(normalizeAvatar(null)).toBeNull()
    expect(normalizeAvatar('0')).toBeNull()
    expect(normalizeAvatar('11')).toBeNull()
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

describe('botAvatarSrc', () => {
  it('falls back to the classic bot avatar when the character has no tile', () => {
    expect(botAvatarSrc(undefined)).toBe('bot-avatar.png')
  })

  it('serves the character robot tile once picked', () => {
    expect(botAvatarSrc(11)).toBe('avatars/avatar-11.png')
    expect(botAvatarSrc(22)).toBe('avatars/avatar-22.png')
    expect(botAvatarSrc(30)).toBe('avatars/avatar-30.png')
  })
})

describe('avatar pools', () => {
  it('keeps the pools apart: ten cats for users, twenty robots for characters', () => {
    expect(AVATAR_COUNT).toBe(10)
    expect(BOT_AVATAR_FIRST).toBe(11)
    expect(BOT_AVATAR_COUNT).toBe(20)
    expect(botAvatarTiles()).toEqual(Array.from({ length: 20 }, (_, index) => index + 11))
  })
})

describe('avatarSrc', () => {
  it('points every avatar at its served tile', () => {
    expect(avatarSrc(1)).toBe('avatars/avatar-1.png')
    expect(avatarSrc(10)).toBe('avatars/avatar-10.png')
    expect(avatarSrc(11)).toBe('avatars/avatar-11.png')
    expect(avatarSrc(30)).toBe('avatars/avatar-30.png')
  })
})

describe('avatar tile weight', () => {
  it('keeps every tile small enough to serve cold on a hard cache', async () => {
    const sizeOf = async (relative: string): Promise<number> =>
      (await stat(fileURLToPath(new URL(relative, import.meta.url)))).size
    let total = await sizeOf('../public/bot-avatar.png')
    expect(total).toBeLessThan(32 * 1024)
    for (let index = 1; index <= AVATAR_COUNT + BOT_AVATAR_COUNT; index += 1) {
      const size = await sizeOf(`../public/avatars/avatar-${String(index)}.png`)
      // Tiles render at <=64 CSS px (128 device px); a 256-color 128px PNG
      // lands around 14 KB. This cap catches a regression to full-color
      // 256px sources, which once totaled 3.5 MB across the set.
      expect(size).toBeLessThan(32 * 1024)
      total += size
    }
    expect(total).toBeLessThan(512 * 1024)
  })
})
