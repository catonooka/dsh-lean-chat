/** The model-character switcher, anchored to a click on the bot avatar. */

import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { botAvatarSrc } from './avatar.ts'
import type { ProfileInfo } from './api.ts'

/**
 * Presentational character menu: lists the provider profiles ("characters")
 * with their avatar, name, and model, marks the active one, and offers
 * creating or editing in settings. Positioned at the click, clamped to the
 * viewport, closed by outside press, Escape, or scroll — the same contract
 * as the chat context menu.
 */
export function CharacterMenu({ x, y, characters, activeId, onSwitch, onNew, onManage, onClose }: {
  x: number
  y: number
  characters: readonly ProfileInfo[]
  activeId: string | undefined
  onSwitch: (id: string) => void
  onNew: () => void
  onManage: () => void
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
    <div
      className="character-menu"
      role="menu"
      aria-label="Model characters"
      style={{ left: `${String(at.x)}px`, top: `${String(at.y)}px` }}
      ref={menuRef}
    >
      {characters.map(character => (
        <button
          key={character.id}
          type="button"
          role="menuitem"
          className={character.id === activeId ? 'character-menu-item active' : 'character-menu-item'}
          onClick={() => {
            onClose()
            onSwitch(character.id)
          }}
        >
          <span className="character-menu-avatar" aria-hidden="true">
            <img src={botAvatarSrc(character.avatar)} alt="" draggable={false} />
          </span>
          <span className="character-menu-names">
            <span className="character-menu-name">{character.name}</span>
            <span className="character-menu-model">{character.model}</span>
          </span>
          {character.id === activeId
            ? (
              <svg className="character-menu-check" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )
            : undefined}
        </button>
      ))}
      <div className="user-menu-sep" aria-hidden="true" />
      <button type="button" role="menuitem" className="character-menu-item" onClick={() => { onClose(); onNew() }}>
        New character…
      </button>
      <button type="button" role="menuitem" className="character-menu-item" onClick={() => { onClose(); onManage() }}>
        Edit in settings
      </button>
    </div>
  )
}
