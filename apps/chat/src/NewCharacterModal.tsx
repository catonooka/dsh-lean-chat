/** The new-character dialog: name, an avatar tile, and a system prompt. */

import { useEffect, useState, type JSX } from 'react'
import { BOT_AVATAR_FIRST, avatarSrc, botAvatarTiles } from './avatar.ts'

/**
 * A cancellable character form. The panel is presentational: App creates the
 * provider profile through the API and switches to it, so a failed create
 * simply leaves this dialog's error to the caller.
 */
export function NewCharacterModal({ onCreate, onClose }: {
  onCreate: (input: { name: string; avatar?: number; persona?: string }) => void
  onClose: () => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState<number>(BOT_AVATAR_FIRST)
  const [persona, setPersona] = useState('')
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true) }
  }, [onClose])
  const trimmed = name.trim()
  const submit = (): void => {
    if (trimmed === '') return
    const trimmedPersona = persona.trim()
    onCreate({ name: trimmed, avatar, ...trimmedPersona !== '' ? { persona: trimmedPersona } : {} })
  }
  return (
    <div className="settings-overlay" role="presentation" onClick={onClose}>
      <div
        className="settings-panel add-user-panel"
        role="dialog"
        aria-modal="true"
        aria-label="New character"
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="settings-head">
          <span className="settings-title">New character</span>
        </div>
        <label className="settings-row">
          <span className="settings-label">Name</span>
          <input
            type="text"
            value={name}
            aria-label="Character name"
            placeholder="e.g. Robo"
            autoFocus
            spellCheck={false}
            onChange={(event) => { setName(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
        </label>
        <div className="avatar-grid add-user-grid">
          {botAvatarTiles().map(tile => (
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
          <span className="settings-label">System prompt</span>
          <textarea
            value={persona}
            rows={3}
            aria-label="Character system prompt"
            placeholder="You are a helpful assistant."
            onChange={(event) => { setPersona(event.target.value) }}
          />
          <span className="settings-hint">
            Copies the current endpoint, key, and model — set those apart later in settings if
            {' '}this character should run elsewhere.
          </span>
        </label>
        <div className="settings-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={trimmed === ''} onClick={submit}>
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
