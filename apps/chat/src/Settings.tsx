/** The settings panel: every runtime-configurable option of the chat surface. */

import { useEffect, useState, type JSX } from 'react'
import { AVATAR_COUNT, BOT_AVATAR_SRC, avatarSrc, botAvatarTiles } from './avatar.ts'
import {
  checkModelAbilities,
  fetchChromeStatus,
  fetchModels,
  testChromeSearch,
  updateConfig,
  updateUser,
  type AppConfig,
  type ChromeStatus,
  type ModelAbilities,
  type ProfileInfo,
  type SettingsPatch,
  type UserInfo,
} from './api.ts'

export type Theme = 'system' | 'light' | 'dark'

const THEME_KEY = 'dsh-chat-theme'

const EFFORTS: readonly { id: 'off' | 'low' | 'high' | 'max'; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'low', label: 'Low' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
]

const THEMES: readonly { id: Theme; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

const SEARCH_TOOLS: readonly { id: 'tiny-metasearch' | 'user-chrome'; label: string }[] = [
  { id: 'tiny-metasearch', label: 'Built-in' },
  { id: 'user-chrome', label: 'Your Chrome' },
]

/** Apply one theme choice to the document root (`system` follows the OS). */
export function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}

/** The stored theme choice, defaulting to `system`. */
export function readStoredTheme(): Theme {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_KEY) : null
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

/** Store one theme choice; it is a client preference, never server state. */
export function storeTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme)
}

interface SettingsProps {
  config: AppConfig
  theme: Theme
  onTheme: (theme: Theme) => void
  /** The chosen user avatar (1..30); picked instantly, like the theme. */
  avatar: number | null
  onAvatar: (avatar: number) => void
  /** The user-profile roster, when it has loaded. */
  users?: UserInfo[]
  /** Which profile is acting; the picker switches instantly. */
  activeUserId?: string
  onSwitchUser: (id: string) => void
  /** Adopt a refreshed roster after an edit landed server-side. */
  onUsersUpdated: (users: UserInfo[]) => void
  /** A server-applied update that keeps the panel open (profile operations). */
  onApplied: (config: AppConfig) => void
  /** The Save button's update, which also closes the panel. */
  onSaved: (config: AppConfig) => void
  onClose: () => void
}

export function SettingsPanel({
  config, theme, onTheme, avatar, onAvatar, users, activeUserId, onSwitchUser, onUsersUpdated, onApplied, onSaved, onClose,
}: SettingsProps): JSX.Element {
  const [profiles, setProfiles] = useState<ProfileInfo[]>(config.profiles ?? [])
  const [activeId, setActiveId] = useState(config.activeProfileId ?? config.profiles?.[0]?.id ?? '')
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [model, setModel] = useState(config.model)
  const [effort, setEffort] = useState<'off' | 'low' | 'high' | 'max'>(effortOf(config.reasoningEffort))
  const [temperature, setTemperature] = useState<number | undefined>(config.temperature)
  const [persona, setPersona] = useState(config.persona)
  const [characterAvatar, setCharacterAvatar] = useState<number | undefined>(config.avatar)
  const [baseUrl, setBaseUrl] = useState(config.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [searchTool, setSearchTool] = useState<'tiny-metasearch' | 'user-chrome'>(
    config.searchTool === 'user-chrome' ? 'user-chrome' : 'tiny-metasearch')
  const [autoCompact, setAutoCompact] = useState<boolean>(config.autoCompact !== false)
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [abilities, setAbilities] = useState<ModelAbilities | undefined>(undefined)
  const [checkingAbilities, setCheckingAbilities] = useState(false)
  const [saving, setSaving] = useState(false)
  const [chromeStatus, setChromeStatus] = useState<ChromeStatus | undefined>(undefined)
  const [chromeTesting, setChromeTesting] = useState(false)
  const [chromeTest, setChromeTest] = useState<string | undefined>(undefined)
  const [showChromeHelp, setShowChromeHelp] = useState(false)
  const [userRenaming, setUserRenaming] = useState(false)
  const [userNameDraft, setUserNameDraft] = useState('')
  const [chromeClients, setChromeClients] = useState<string[]>([])
  const activeUser = users?.find(user => user.id === activeUserId)
  const [error, setError] = useState<string | undefined>(undefined)

  // The Chrome-profile picker needs the connected client labels once per
  // panel visit; the connection row keeps its own live poll when visible.
  useEffect(() => {
    fetchChromeStatus()
      .then((status) => {
        if (status.clients !== undefined) setChromeClients(status.clients.map(entry => entry.client))
      })
      .catch(() => { /* the picker falls back to "any connected profile" */ })
  }, [])

  const commitUserName = async (): Promise<void> => {
    const name = userNameDraft.trim()
    setUserRenaming(false)
    if (name === '' || activeUserId === undefined) return
    try {
      const body = await updateUser(activeUserId, { name })
      onUsersUpdated(body.users)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** The Chrome-profile preference applies instantly, like the avatar. */
  const applyChromeProfile = async (label: string): Promise<void> => {
    if (activeUserId === undefined) return
    try {
      const body = await updateUser(activeUserId, { chromeProfile: label })
      onUsersUpdated(body.users)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** Adopt a server response: refresh the profile list and re-seed the rows
   * from the profile that is now active, keeping the panel open. */
  const adopt = (next: AppConfig): void => {
    onApplied(next)
    setProfiles(next.profiles ?? [])
    const active = next.profiles?.find(profile => profile.id === next.activeProfileId) ?? next.profiles?.[0]
    setActiveId(next.activeProfileId ?? active?.id ?? '')
    setModel(active?.model ?? next.model)
    setBaseUrl(active?.baseUrl ?? next.baseUrl ?? '')
    setCharacterAvatar(next.avatar)
    setPersona(active?.persona ?? next.persona)
    setApiKey('')
    setModels([])
  }

  // The connection row lives only while "Your Chrome" is selected, and its
  // state is the server's view (the extension's heartbeat), so it polls.
  useEffect(() => {
    if (searchTool !== 'user-chrome') return
    let cancelled = false
    const refresh = (): void => {
      fetchChromeStatus()
        .then((status) => { if (!cancelled) setChromeStatus(status) })
        .catch(() => { /* status stays stale; the test button reports real errors */ })
    }
    refresh()
    const timer = window.setInterval(refresh, 4000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [searchTool])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const loadModels = async (): Promise<void> => {
    setLoadingModels(true)
    try {
      setModels(await fetchModels())
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingModels(false)
    }
  }

  const runAbilityCheck = async (): Promise<void> => {
    setCheckingAbilities(true)
    try {
      setAbilities(await checkModelAbilities(model))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCheckingAbilities(false)
    }
  }

  /** Switching is local until Save: the rows re-seed from the target profile. */
  const selectProfile = (id: string): void => {
    if (id === activeId) return
    setActiveId(id)
    const target = profiles.find(profile => profile.id === id)
    setModel(target?.model ?? model)
    setBaseUrl(target?.baseUrl ?? '')
    setPersona(target?.persona ?? config.persona)
    setCharacterAvatar(target?.avatar)
    setApiKey('')
    setModels([])
    setRenaming(false)
  }

  const runProfileOp = async (patch: SettingsPatch): Promise<void> => {
    setSaving(true)
    try {
      adopt(await updateConfig(patch))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const commitRename = async (): Promise<void> => {
    const name = nameDraft.trim()
    if (name === '') return
    setRenaming(false)
    await runProfileOp({ renameProfile: { id: activeId, name } })
  }

  /** The character avatar applies instantly, like the user avatar. */
  const applyCharacterAvatar = async (option: number | undefined): Promise<void> => {
    try {
      const next = await updateConfig({ avatar: option ?? null })
      onApplied(next)
      setCharacterAvatar(next.avatar)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const runChromeTest = async (): Promise<void> => {
    setChromeTesting(true)
    setChromeTest(undefined)
    try {
      const outcome = await testChromeSearch('latest ai news')
      setChromeTest(outcome.ok
        ? `${outcome.engine ?? 'chrome'} · ${String(outcome.count ?? 0)} results · ${((outcome.ms ?? 0) / 1000).toFixed(1)}s`
        : `${outcome.engine ?? 'chrome'}: ${outcome.error ?? 'failed'}`)
      fetchChromeStatus().then(setChromeStatus).catch(() => undefined)
    } catch (err: unknown) {
      setChromeTest(err instanceof Error ? err.message : String(err))
    } finally {
      setChromeTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const patch: SettingsPatch = { model, reasoningEffort: effort, persona, searchTool, autoCompact }
      if (activeId !== (config.activeProfileId ?? config.profiles?.[0]?.id)) patch.switchProfile = activeId
      if (temperature === undefined) patch.temperature = null
      else patch.temperature = temperature
      const trimmedBase = baseUrl.trim()
      patch.baseUrl = trimmedBase === '' ? null : trimmedBase
      if (apiKey.trim() !== '') patch.apiKey = apiKey.trim()
      onSaved(await updateConfig(patch))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="settings-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="settings-panel" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="settings-head">
          <span className="settings-title">Settings</span>
          <button type="button" className="settings-close" aria-label="Close settings" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="settings-row">
          <span className="settings-label">Profile</span>
          {renaming
            ? (
              <div className="model-row">
                <input
                  type="text"
                  value={nameDraft}
                  spellCheck={false}
                  autoFocus
                  aria-label="Profile name"
                  onChange={(event) => { setNameDraft(event.target.value) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void commitRename()
                    if (event.key === 'Escape') setRenaming(false)
                  }}
                />
                <button type="button" className="models-load" disabled={saving} onClick={() => { void commitRename() }}>
                  Save name
                </button>
                <button type="button" className="models-load" onClick={() => { setRenaming(false) }}>
                  Cancel
                </button>
              </div>
            )
            : (
              <div className="model-row">
                <select
                  aria-label="Provider profile"
                  value={activeId}
                  onChange={(event) => { selectProfile(event.target.value) }}
                >
                  {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
                <button
                  type="button"
                  className="models-load"
                  onClick={() => {
                    setNameDraft(profiles.find(profile => profile.id === activeId)?.name ?? '')
                    setRenaming(true)
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="models-load"
                  disabled={saving}
                  onClick={() => { void runProfileOp({ newProfile: {} }) }}
                >
                  New
                </button>
                <button
                  type="button"
                  className="models-load"
                  disabled={saving || profiles.length <= 1}
                  onClick={() => { void runProfileOp({ deleteProfile: { id: activeId } }) }}
                >
                  Delete
                </button>
              </div>
            )}
          <span className="settings-hint">
            Each profile keeps its own endpoint, key, and model; the rows below edit the selected one. Every
            {' '}profile runs on the same OpenAI-compatible adapter.
          </span>
        </div>

        {users !== undefined && users.length > 0 && activeUserId !== undefined && activeUserId !== ''
          ? (
            <div className="settings-row">
              <span className="settings-label">User</span>
              <div className="model-row">
                {userRenaming
                  ? (
                    <>
                      <input
                        type="text"
                        value={userNameDraft}
                        spellCheck={false}
                        autoFocus
                        aria-label="User name"
                        onChange={(event) => { setUserNameDraft(event.target.value) }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void commitUserName()
                          if (event.key === 'Escape') setUserRenaming(false)
                        }}
                      />
                      <button type="button" className="models-load" onClick={() => { void commitUserName() }}>
                        Save name
                      </button>
                      <button type="button" className="models-load" onClick={() => { setUserRenaming(false) }}>
                        Cancel
                      </button>
                    </>
                  )
                  : (
                    <>
                      <select
                        aria-label="User profile"
                        value={activeUserId}
                        onChange={(event) => { onSwitchUser(event.target.value) }}
                      >
                        {users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
                      </select>
                      <button
                        type="button"
                        className="models-load"
                        onClick={() => {
                          setUserRenaming(true)
                          setUserNameDraft(activeUser?.name ?? '')
                        }}
                      >
                        Rename
                      </button>
                    </>
                  )}
              </div>
              <span className="settings-hint">
                Each user keeps their own chats, groups, and avatar; switching is instant and never stops a
                {' '}running task. The avatar row below edits the selected user.
              </span>
              <label className="chrome-pick">
                <span className="settings-label">Chrome</span>
                <select
                  aria-label="Chrome profile for this user"
                  value={activeUser?.chromeProfile ?? ''}
                  onChange={(event) => { void applyChromeProfile(event.target.value) }}
                >
                  <option value="">Any connected profile</option>
                  {chromeClients.map(client => <option key={client} value={client}>{client}</option>)}
                </select>
              </label>
              <span className="settings-hint">
                Browser steps in this user's chats default to the chosen Chrome profile — connected right now:
                {' '}{chromeClients.length > 0 ? chromeClients.join(', ') : 'none'}. Each profile labels itself in the
                {' '}extension options.
              </span>
            </div>
          )
          : undefined}

        <label className="settings-row">
          <span className="settings-label">Model</span>
          <div className="model-row">
            <input
              type="text"
              value={model}
              spellCheck={false}
              onChange={(event) => { setModel(event.target.value) }}
            />
            <button
              type="button"
              className="models-load"
              disabled={loadingModels}
              onClick={() => { void loadModels() }}
            >
              {loadingModels ? '…' : 'Load list'}
            </button>
            <button
              type="button"
              className="models-load"
              disabled={checkingAbilities}
              onClick={() => { void runAbilityCheck() }}
            >
              {checkingAbilities ? '…' : 'Check abilities'}
            </button>
          </div>
          {abilities !== undefined
            ? <span className="settings-hint model-abilities">{abilitiesLine(abilities)}</span>
            : undefined}
          {models.length > 0
            ? (
              <select
                aria-label="Pick a model"
                value={models.includes(model) ? model : ''}
                onChange={(event) => {
                  if (event.target.value !== '') setModel(event.target.value)
                }}
              >
                {!models.includes(model) ? <option value="">{model}</option> : undefined}
                {models.map(id => <option key={id} value={id}>{id}</option>)}
              </select>
            )
            : undefined}
          <span className="settings-hint">Free text, or load the endpoint's model list and pick one.</span>
        </label>

        <label className="settings-row">
          <span className="settings-label">Base URL</span>
          <input
            type="text"
            value={baseUrl}
            spellCheck={false}
            placeholder="default endpoint"
            onChange={(event) => { setBaseUrl(event.target.value) }}
          />
          {isCleartextEndpoint(baseUrl)
            ? <span className="settings-hint cleartext-warning">This http:// endpoint receives your API key in cleartext.</span>
            : undefined}
          <span className="settings-hint">Any OpenAI-compatible gateway; empty means the launch default.</span>
        </label>

        <label className="settings-row">
          <span className="settings-label">API key</span>
          <input
            type="password"
            value={apiKey}
            spellCheck={false}
            autoComplete="off"
            placeholder={config.apiKeySet === true ? 'unchanged (a key is set)' : 'not set — launch environment'}
            onChange={(event) => { setApiKey(event.target.value) }}
          />
          <span className="settings-hint">Stored owner-only under the dsh home; left blank to keep the current key.</span>
        </label>

        <div className="settings-row">
          <span className="settings-label">Thinking</span>
          <div className="segmented" role="radiogroup" aria-label="Thinking level">
            {EFFORTS.map(option => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={effort === option.id}
                className={effort === option.id ? 'segment active' : 'segment'}
                onClick={() => { setEffort(option.id) }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <span className="settings-label">
            Temperature
            <span className="settings-value">{temperature === undefined ? 'default' : temperature.toFixed(1)}</span>
          </span>
          <div className="temperature-row">
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={temperature ?? 1}
              aria-label="Temperature"
              onChange={(event) => { setTemperature(Number(event.target.value)) }}
            />
            <button
              type="button"
              className="temperature-reset"
              disabled={temperature === undefined}
              onClick={() => { setTemperature(undefined) }}
            >
              Default
            </button>
          </div>
        </div>

        <label className="settings-row">
          <span className="settings-label">System prompt</span>
          <textarea
            value={persona}
            rows={2}
            aria-label="System prompt"
            placeholder="You are a helpful assistant."
            onChange={(event) => { setPersona(event.target.value) }}
          />
          <span className="settings-hint">
            Each character keeps its own system prompt; switching characters switches it.
            {' '}Empty means the default persona.
          </span>
        </label>

        <div className="settings-row">
          <span className="settings-label">Character avatar</span>
          <div className="avatar-grid small">
            <button
              type="button"
              className={characterAvatar === undefined ? 'avatar-option active' : 'avatar-option'}
              aria-label="Classic avatar"
              aria-pressed={characterAvatar === undefined}
              onClick={() => { void applyCharacterAvatar(undefined) }}
            >
              <img src={BOT_AVATAR_SRC} alt="" draggable={false} />
            </button>
            {botAvatarTiles().map(option => (
              <button
                key={option}
                type="button"
                className={characterAvatar === option ? 'avatar-option active' : 'avatar-option'}
                aria-label={`Avatar ${String(option)}`}
                aria-pressed={characterAvatar === option}
                onClick={() => { void applyCharacterAvatar(option) }}
              >
                <img src={avatarSrc(option)} alt="" draggable={false} />
              </button>
            ))}
          </div>
          <span className="settings-hint">Robot tiles for characters; your cat tiles belong to user profiles.</span>
        </div>

        <div className="settings-row">
          <span className="settings-label">Auto-compact</span>
          <div className="segmented" role="radiogroup" aria-label="Auto-compact">
            <button
              type="button"
              role="radio"
              aria-checked={autoCompact}
              className={autoCompact ? 'segment active' : 'segment'}
              onClick={() => { setAutoCompact(true) }}
            >
              On
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!autoCompact}
              className={autoCompact ? 'segment' : 'segment active'}
              onClick={() => { setAutoCompact(false) }}
            >
              Off
            </button>
          </div>
          <span className="settings-hint">
            When the context window fills, older turns become a summary the model reads instead —
            {' '}recent messages stay verbatim, and the full history stays on disk.
          </span>
        </div>

        <div className="settings-row">
          <span className="settings-label">Search tool</span>
          <div className="segmented" role="radiogroup" aria-label="Search tool">
            {SEARCH_TOOLS.map(option => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={searchTool === option.id}
                className={searchTool === option.id ? 'segment active' : 'segment'}
                onClick={() => { setSearchTool(option.id) }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="settings-hint">
            Your Chrome runs the search with this browser's logins — the companion extension, or the debug
            {' '}port as a fallback. The model can prefix a query with x: to search your X.
          </span>
        </div>

        {searchTool === 'user-chrome'
          ? (
            <div className="settings-row">
              <span className="settings-label">
                Chrome connection
                <span className="settings-value chrome-connection">
                  <span
                    className={chromeStatus?.extension === true || chromeStatus?.cdp === true ? 'chrome-dot on' : 'chrome-dot'}
                    aria-hidden="true"
                  />
                  {chromeStatus?.extension === true
                    ? 'extension connected'
                    : chromeStatus?.cdp === true
                      ? 'debug port connected'
                      : chromeStatus === undefined ? 'checking…' : 'not connected'}
                  {chromeStatus?.extension === true && chromeStatus.clients !== undefined && chromeStatus.clients.length > 0
                    ? (
                      <span className="chrome-profiles">
                        {' · '}
                        {chromeStatus.clients.map(entry => entry.actuation === true ? `${entry.client} (actions)` : entry.client).join(', ')}
                      </span>
                    )
                    : undefined}
                </span>
              </span>
              <div className="chrome-row">
                <button
                  type="button"
                  className="models-load"
                  disabled={chromeTesting}
                  onClick={() => { void runChromeTest() }}
                >
                  {chromeTesting ? '…' : 'Test search'}
                </button>
                <button
                  type="button"
                  className="models-load"
                  aria-expanded={showChromeHelp}
                  onClick={() => { setShowChromeHelp(!showChromeHelp) }}
                >
                  {showChromeHelp ? 'Hide steps' : 'How to connect'}
                </button>
              </div>
              {chromeTest !== undefined ? <span className="settings-hint">{chromeTest}</span> : undefined}
              {showChromeHelp
                ? (
                  <div className="chrome-help">
                    <p><strong>Extension</strong> — invisible searches, no debug port:</p>
                    <ol>
                      <li>Open <code>chrome://extensions</code></li>
                      <li>Turn on <em>Developer mode</em></li>
                      <li><em>Load unpacked</em> → <code>{chromeStatus?.extensionPath ?? '…/dsh-lean-chat/packages/web/web-search-chrome/extension'}</code></li>
                    </ol>
                    <p>Different port? Set it once in the extension's options after loading.</p>
                    <p><strong>Debug port</strong> — quit Chrome fully, then relaunch:</p>
                    <pre><code>open -na "Google Chrome" --args --remote-debugging-port=9222</code></pre>
                  </div>
                )
                : undefined}
            </div>
          )
          : undefined}

        <div className="settings-row">
          <span className="settings-label">Your avatar</span>
          <div className="avatar-grid small">
            {Array.from({ length: AVATAR_COUNT }, (_, index) => index + 1).map(option => (
              <button
                key={option}
                type="button"
                className={avatar === option ? 'avatar-option active' : 'avatar-option'}
                aria-label={`Avatar ${String(option)}`}
                aria-pressed={avatar === option}
                onClick={() => { onAvatar(option) }}
              >
                <img src={avatarSrc(option)} alt="" draggable={false} />
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <span className="settings-label">Theme</span>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {THEMES.map(option => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={theme === option.id}
                className={theme === option.id ? 'segment active' : 'segment'}
                onClick={() => { onTheme(option.id) }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {error !== undefined
          ? (
            <div className="settings-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => { setError(undefined) }}>dismiss</button>
            </div>
          )
          : undefined}

        <div className="settings-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={saving} onClick={() => { void save() }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Whether an endpoint URL would carry the API key unencrypted. */
export function isCleartextEndpoint(url: string): boolean {
  return /^\s*http:\/\/[^\s]/i.test(url)
}

/** One verdict cell: ✓ accepted, ✗ rejected, ? the probe could not tell. */
function verdictMark(verdict: 'yes' | 'no' | 'unknown'): string {
  return verdict === 'yes' ? '✓' : verdict === 'no' ? '✗' : '?'
}

/** The abilities line shown under the model row. */
function abilitiesLine(abilities: ModelAbilities): string {
  return `${abilities.model}: image ${verdictMark(abilities.image)} · video ${verdictMark(abilities.video)}`
    + (abilities.image === 'unknown' && abilities.video === 'unknown'
      ? ' — the endpoint would not answer a probe'
      : '')
}

/** Map a config effort to the segmented control's always-selected state. */
function effortOf(value: string | undefined): 'off' | 'low' | 'high' | 'max' {
  return value === 'low' || value === 'high' || value === 'max' ? value : 'off'
}
