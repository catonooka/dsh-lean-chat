/** The first-run avatar choice: one of the ten, required before it closes. */

import { useState, type JSX } from 'react'
import { AVATAR_COUNT, avatarSrc } from './avatar.ts'

interface AvatarModalProps {
  onPick: (avatar: number, name: string) => void
}

/** The required picker shown until the user chooses an avatar. An optional
 * name field rides along so onboarding can name the user, not just dress
 * them: fresh stores otherwise carry the generic default name. */
export function AvatarModal({ onPick }: AvatarModalProps): JSX.Element {
  const [hovered, setHovered] = useState<number | undefined>(undefined)
  const [name, setName] = useState('')
  return (
    <div className="settings-overlay avatar-overlay" role="presentation">
      <div className="settings-panel avatar-panel" role="dialog" aria-modal="true" aria-label="Choose your avatar">
        <div className="settings-head">
          <span className="settings-title">Choose your avatar</span>
        </div>
        <label className="settings-row">
          <span className="settings-label">Your name</span>
          <input
            type="text"
            value={name}
            aria-label="Your name"
            placeholder="You"
            autoFocus
            spellCheck={false}
            maxLength={40}
            onChange={(event) => { setName(event.target.value) }}
          />
        </label>
        <div className="avatar-grid">
          {Array.from({ length: AVATAR_COUNT }, (_, index) => index + 1).map(avatar => (
            <button
              key={avatar}
              type="button"
              className={hovered === avatar ? 'avatar-option hovered' : 'avatar-option'}
              aria-label={`Avatar ${String(avatar)}`}
              onMouseEnter={() => { setHovered(avatar) }}
              onMouseLeave={() => { setHovered(undefined) }}
              onClick={() => { onPick(avatar, name.trim()) }}
            >
              <img src={avatarSrc(avatar)} alt="" draggable={false} />
            </button>
          ))}
        </div>
        <span className="settings-hint">Pick one to start chatting — you can change it later in Settings.</span>
      </div>
    </div>
  )
}
