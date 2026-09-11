/** Two fixed avatar sets: cat tiles 1-10 are user-profile avatars, robot
 * tiles 11-30 are model-character avatars — the pools never mix. */

/** How many cat tiles the app offers for user profiles. */
export const AVATAR_COUNT = 10

/** First robot tile; model characters pick from tiles 11-30. */
export const BOT_AVATAR_FIRST = 11

/** How many robot tiles the app offers for model characters. */
export const BOT_AVATAR_COUNT = 20

/** Every robot tile a model character can wear, in grid order. */
export function botAvatarTiles(): number[] {
  return Array.from({ length: BOT_AVATAR_COUNT }, (_, index) => BOT_AVATAR_FIRST + index)
}

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

/** The chat bot's classic avatar, shown when a character has none picked. */
export const BOT_AVATAR_SRC = 'bot-avatar.png'

/** The served image URL of one avatar tile. */
export function avatarSrc(avatar: number): string {
  return `avatars/avatar-${String(avatar)}.png`
}

/** The avatar the active model character answers with: its own robot
 * tile when picked, else the classic bot avatar. */
export function botAvatarSrc(avatar: number | undefined): string {
  return avatar === undefined ? BOT_AVATAR_SRC : avatarSrc(avatar)
}
