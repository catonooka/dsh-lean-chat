/** Reply context: which message a new message answers, as chat apps show it. */

/** What a reply references — enough to render a quote, never the full text. */
export interface ReplyContext {
  role: 'user' | 'assistant'
  text: string
}

/** Longest snippet kept for a reply quote; the rest is cut with an ellipsis. */
export const REPLY_SNIPPET_MAX = 300

/**
 * Fold a message into a one-line reply snippet: whitespace collapses to single
 * spaces and anything past the cap is cut with an ellipsis.
 */
export function clampReplyText(text: string, max: number = REPLY_SNIPPET_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** Who a reply quotes, in the user's own words. */
export function replyLabel(role: 'user' | 'assistant'): string {
  return role === 'user' ? 'You' : 'Sato'
}

/**
 * The reply target one chat row yields, if any: user and assistant messages
 * with text can be answered; tool and compaction rows cannot.
 */
export function replyTargetFor(item: { role: 'user' | 'assistant' | 'tool' | 'compaction'; text?: string }): ReplyContext | undefined {
  if (item.role !== 'user' && item.role !== 'assistant') return undefined
  const text = clampReplyText(item.text ?? '')
  if (text === '') return undefined
  return { role: item.role, text }
}
