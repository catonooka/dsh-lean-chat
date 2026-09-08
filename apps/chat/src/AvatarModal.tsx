/** The first-run avatar choice: one of the ten, required before it closes. */

import { useState, type JSX } from 'react'
import { AVATAR_COUNT, avatarSrc } from './avatar.ts'

interface AvatarModalProps {
  onPick: (avatar: number) => void
}

/** The required picker shown until the user chooses an avatar. */
export function AvatarModal({ onPick }: AvatarModalProps): JSX.Element {
  const [hovered, setHovered] = useState<number | undefined>(undefined)
  return (
    <div className="settings-overlay avatar-overlay" role="presentation">
      <div className="settings-panel avatar-panel" role="dialog" aria-modal="true" aria-label="Choose your avatar">
        <div className="settings-head">
          <span className="settings-title">Choose your avatar</span>
        </div>
        <div className="avatar-grid">
          {Array.from({ length: AVATAR_COUNT }, (_, index) => index + 1).map(avatar => (
            <button
              key={avatar}
              type="button"
              className={hovered === avatar ? 'avatar-option hovered' : 'avatar-option'}
              aria-label={`Avatar ${String(avatar)}`}
              onMouseEnter={() => { setHovered(avatar) }}
              onMouseLeave={() => { setHovered(undefined) }}
              onClick={() => { onPick(avatar) }}
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
