/** The profile switcher popover anchored to the sidebar's avatar. */

import { useEffect, useRef, type JSX } from 'react'
import { avatarSrc } from './avatar.ts'
import type { UserInfo } from './api.ts'

/**
 * One row per user profile plus the add/manage affordances. Purely present:
 * App owns who is acting. Closes on outside press or Escape; switching is a
 * client-side header change, so nothing here touches the network.
 */
export function UserMenu({ users, activeUserId, onSwitch, onAdd, onManage, onClose }: {
  users: readonly UserInfo[]
  activeUserId: string
  onSwitch: (id: string) => void
  onAdd: () => void
  onManage: () => void
  onClose: () => void
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (event: Event): void => {
      const node = menuRef.current
      if (node !== null && event.target instanceof Node && node.contains(event.target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])
  return (
    <div className="user-menu" role="menu" aria-label="User profiles" ref={menuRef}>
      {users.map(user => (
        <button
          key={user.id}
          type="button"
          role="menuitem"
          className={user.id === activeUserId ? 'user-menu-item active' : 'user-menu-item'}
          onClick={() => { onSwitch(user.id) }}
          title={user.name}
        >
          <span className="user-menu-avatar" aria-hidden="true">
            {user.avatar !== undefined
              ? <img src={avatarSrc(user.avatar)} alt="" draggable={false} />
              : (
                <svg viewBox="0 0 16 16">
                  <circle cx="8" cy="5.2" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M3 13.5c.9-2.7 2.8-4.1 5-4.1s4.1 1.4 5 4.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              )}
          </span>
          <span className="user-menu-name">{user.name}</span>
          {user.id === activeUserId
            ? (
              <svg className="user-menu-check" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )
            : undefined}
        </button>
      ))}
      <div className="user-menu-sep" aria-hidden="true" />
      <button type="button" role="menuitem" className="user-menu-item" onClick={onAdd}>
        <span className="user-menu-avatar plus" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <line x1="8" y1="3.5" x2="8" y2="12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <line x1="3.5" y1="8" x2="12.5" y2="8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <span className="user-menu-name">Add user…</span>
      </button>
      <button type="button" role="menuitem" className="user-menu-item" onClick={onManage}>
        <span className="user-menu-avatar" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <line x1="2" y1="4.5" x2="14" y2="4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="6" cy="4.5" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <line x1="2" y1="11.5" x2="14" y2="11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="10" cy="11.5" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </span>
        <span className="user-menu-name">Manage in settings</span>
      </button>
    </div>
  )
}
