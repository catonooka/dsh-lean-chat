/** Dialogs behind the chat context-menu actions: groups and delete. */

import { useEffect, useState, type JSX } from 'react'
import type { ChatGroupInfo } from './api.ts'

/** Shared shell: overlay panel that closes on Escape and outside click. */
function DialogShell({ title, onClose, children }: {
  title: string
  onClose: () => void
  children: JSX.Element | JSX.Element[]
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true) }
  }, [onClose])
  return (
    <div className="settings-overlay" role="presentation" onClick={onClose}>
      <div
        className="settings-panel session-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="settings-head">
          <span className="settings-title">{title}</span>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Name a new group; the caller creates it and moves the chat in. */
export function NewGroupDialog({ chatTitle, onCreate, onClose }: {
  chatTitle: string
  onCreate: (name: string) => void
  onClose: () => void
}): JSX.Element {
  const [name, setName] = useState('')
  const trimmed = name.trim()
  return (
    <DialogShell title="New group" onClose={onClose}>
      <label className="settings-row">
        <span className="settings-label">Name</span>
        <input
          type="text"
          value={name}
          aria-label="Group name"
          placeholder="e.g. X research"
          autoFocus
          spellCheck={false}
          onChange={(event) => { setName(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && trimmed !== '') onCreate(trimmed)
          }}
        />
      </label>
      <span className="settings-hint">{`"${chatTitle}" moves into the new group.`}</span>
      <div className="settings-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="btn primary"
          disabled={trimmed === ''}
          onClick={() => { onCreate(trimmed) }}
        >
          Create group
        </button>
      </div>
    </DialogShell>
  )
}

/** Move one chat into one of the user's groups, or back to ungrouped. */
export function MoveGroupDialog({ groups, current, onMove, onClose }: {
  groups: readonly ChatGroupInfo[]
  current: string | null
  onMove: (groupId: string | null) => void
  onClose: () => void
}): JSX.Element {
  return (
    <DialogShell title="Move to group" onClose={onClose}>
      <div className="group-choice-list" role="listbox" aria-label="Groups">
        <button
          type="button"
          role="option"
          aria-selected={current === null}
          className={current === null ? 'group-choice active' : 'group-choice'}
          onClick={() => { onMove(null) }}
        >
          Ungrouped
        </button>
        {groups.map(group => (
          <button
            key={group.id}
            type="button"
            role="option"
            aria-selected={current === group.id}
            className={current === group.id ? 'group-choice active' : 'group-choice'}
            onClick={() => { onMove(group.id) }}
          >
            {group.name}
          </button>
        ))}
      </div>
    </DialogShell>
  )
}

/** Confirm a destructive delete with the chat's name on the line. */
export function ConfirmDeleteDialog({ chatTitle, onConfirm, onClose }: {
  chatTitle: string
  onConfirm: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <DialogShell title="Delete chat?" onClose={onClose}>
      <span className="settings-hint">
        {`"${chatTitle}" and its whole history are deleted for good. This cannot be undone.`}
      </span>
      <div className="settings-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn danger" onClick={onConfirm}>Delete</button>
      </div>
    </DialogShell>
  )
}
