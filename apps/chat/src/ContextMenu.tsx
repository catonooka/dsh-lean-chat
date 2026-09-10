/** A small menu anchored to a right-click, viewport-clamped. */

import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'

/** One selectable row; `danger` styles destructive actions red. */
export interface ContextMenuItem {
  label: string
  danger?: boolean
  onSelect: () => void
}

/**
 * Presentational context menu: positioned at the cursor, clamped so it never
 * leaves the viewport, and closed by outside press, Escape, or scroll. The
 * caller owns what the items do.
 */
export function ContextMenu({ x, y, items, onClose }: {
  x: number
  y: number
  items: readonly ContextMenuItem[]
  onClose: () => void
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ x, y })
  useLayoutEffect(() => {
    const node = menuRef.current
    if (node === null) return
    const box = node.getBoundingClientRect()
    const maxX = Math.max(0, window.innerWidth - box.width - 8)
    const maxY = Math.max(0, window.innerHeight - box.height - 8)
    setAt({ x: Math.min(x, maxX), y: Math.min(y, maxY) })
  }, [x, y])
  useEffect(() => {
    const onDown = (event: Event): void => {
      const node = menuRef.current
      if (node !== null && event.target instanceof Node && node.contains(event.target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const onScroll = (): void => { onClose() }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])
  return (
    <div className="context-menu" role="menu" style={{ left: `${String(at.x)}px`, top: `${String(at.y)}px` }} ref={menuRef}>
      {items.map(item => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger === true ? 'context-menu-item danger' : 'context-menu-item'}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
