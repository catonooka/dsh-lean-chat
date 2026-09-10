/** The add-user dialog: name plus an avatar tile, then App switches to it. */

import { useEffect, useState, type JSX } from 'react'
import { AVATAR_COUNT, avatarSrc } from './avatar.ts'
import { fetchChromeStatus } from './api.ts'

/**
 * A cancellable name + avatar form. The panel is presentational: App mints
 * the profile through the API and performs the switch, so a failed create
 * simply leaves the dialog's error to this component's caller.
 */
export function AddUserModal({ onCreate, onClose }: {
  onCreate: (input: { name: string; avatar: number; chromeProfile?: string }) => void
  onClose: () => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState(1)
  const [chromeProfile, setChromeProfile] = useState('')
  const [chromeClients, setChromeClients] = useState<string[]>([])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true) }
  }, [onClose])
  // Offer the Chrome profiles connected right now; "any" is the default.
  useEffect(() => {
    fetchChromeStatus()
      .then((status) => {
        if (status.clients !== undefined) setChromeClients(status.clients.map(entry => entry.client))
      })
      .catch(() => { /* the picker stays at "any connected profile" */ })
  }, [])
  const trimmed = name.trim()
  return (
    <div className="settings-overlay" role="presentation" onClick={onClose}>
      <div
        className="settings-panel add-user-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Add user"
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="settings-head">
          <span className="settings-title">Add user</span>
        </div>
        <label className="settings-row">
          <span className="settings-label">Name</span>
          <input
            type="text"
            value={name}
            aria-label="User name"
            placeholder="e.g. Work"
            autoFocus
            spellCheck={false}
            onChange={(event) => { setName(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && trimmed !== '') {
                onCreate({ name: trimmed, avatar, ...chromeProfile !== '' ? { chromeProfile } : {} })
              }
            }}
          />
        </label>
        <div className="avatar-grid add-user-grid">
          {Array.from({ length: AVATAR_COUNT }, (_, index) => index + 1).map(tile => (
            <button
              key={tile}
              type="button"
              className={avatar === tile ? 'avatar-option active' : 'avatar-option'}
              aria-label={`Avatar ${String(tile)}`}
              aria-pressed={avatar === tile}
              onClick={() => { setAvatar(tile) }}
            >
              <img src={avatarSrc(tile)} alt="" draggable={false} />
            </button>
          ))}
        </div>
        <label className="settings-row">
          <span className="settings-label">Chrome</span>
          <select
            aria-label="Chrome profile for this user"
            value={chromeProfile}
            onChange={(event) => { setChromeProfile(event.target.value) }}
          >
            <option value="">Any connected profile</option>
            {chromeClients.map(client => <option key={client} value={client}>{client}</option>)}
          </select>
        </label>
        <div className="settings-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={trimmed === ''}
            onClick={() => { onCreate({ name: trimmed, avatar, ...chromeProfile !== '' ? { chromeProfile } : {} }) }}
          >
            Add user
          </button>
        </div>
      </div>
    </div>
  )
}
