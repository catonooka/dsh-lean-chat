/** The fixed avatar set: the user picks exactly one of the ten served tiles. */

/** How many avatars the app offers. */
export const AVATAR_COUNT = 10

const AVATAR_KEY = 'dsh-chat-avatar'

/**
 * Validate a stored avatar value: integers 1..AVATAR_COUNT only, so a
 * hand-edited or drifted localStorage entry falls back to "unset".
 * @param value - the raw stored string, or null when never chosen.
 * @returns the chosen avatar number, or null when unset/invalid.
 */
export function normalizeAvatar(value: string | null): number | null {
  if (value === null) return null
  // Number, not parseInt: '2.5' must not quietly become 2.
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= AVATAR_COUNT ? parsed : null
}

/** The stored avatar choice, null when the user has not picked yet. */
export function readStoredAvatar(): number | null {
  return normalizeAvatar(typeof localStorage !== 'undefined' ? localStorage.getItem(AVATAR_KEY) : null)
}

/** Store one avatar choice; like the theme, a client preference. */
export function storeAvatar(avatar: number): void {
  localStorage.setItem(AVATAR_KEY, String(avatar))
}

/** The served image URL of one avatar tile. */
export function avatarSrc(avatar: number): string {
  return `avatars/avatar-${String(avatar)}.png`
}
