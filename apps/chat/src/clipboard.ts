/** Copy text to the system clipboard, with a selection-based fallback. */

/** Longest text the copy button carries; messages can be huge. */
export const COPY_MAX_CHARS = 100_000

/**
 * Copy one text to the clipboard. Prefers the async clipboard API (a
 * secure-context affordance; 127.0.0.1 counts) and falls back to a hidden
 * textarea + `execCommand` for browsers where the API is missing or denied.
 * @param text - the exact text to place on the clipboard.
 * @returns whether the text reached the clipboard.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const bounded = text.slice(0, COPY_MAX_CHARS)
  const nav = navigator as Navigator & { clipboard?: Clipboard }
  if (nav.clipboard !== undefined) {
    try {
      await nav.clipboard.writeText(bounded)
      return true
    } catch {
      // Fall through to the selection path.
    }
  }
  return copyViaSelection(bounded)
}

/**
 * Selection-based copy: mount a textarea, select it, and run the deprecated
 * copy command. Exported for tests; callers use {@link copyToClipboard}.
 */
export function copyViaSelection(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  // Keep it out of the layout and out of screen readers' way.
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  area.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}
