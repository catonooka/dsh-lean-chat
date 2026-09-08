/** The settings panel: every runtime-configurable option of the chat surface. */

import { useEffect, useState, type JSX } from 'react'
import { fetchModels, updateConfig, type AppConfig, type SettingsPatch } from './api.ts'

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
  onSaved: (config: AppConfig) => void
  onClose: () => void
}

export function SettingsPanel({ config, theme, onTheme, onSaved, onClose }: SettingsProps): JSX.Element {
  const [provider, setProvider] = useState(config.provider)
  const [model, setModel] = useState(config.model)
  const [effort, setEffort] = useState<'off' | 'low' | 'high' | 'max'>(effortOf(config.reasoningEffort))
  const [temperature, setTemperature] = useState<number | undefined>(config.temperature)
  const [persona, setPersona] = useState(config.persona)
  const [baseUrl, setBaseUrl] = useState(config.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

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

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const patch: SettingsPatch = { provider, model, reasoningEffort: effort, persona }
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

        <label className="settings-row">
          <span className="settings-label">Provider</span>
          <input
            type="text"
            value={provider}
            spellCheck={false}
            onChange={(event) => { setProvider(event.target.value) }}
          />
        </label>

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
          </div>
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
            placeholder="You are a helpful assistant."
            onChange={(event) => { setPersona(event.target.value) }}
          />
          <span className="settings-hint">The whole system prompt. Empty means the default persona.</span>
        </label>

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

/** Map a config effort to the segmented control's always-selected state. */
function effortOf(value: string | undefined): 'off' | 'low' | 'high' | 'max' {
  return value === 'low' || value === 'high' || value === 'max' ? value : 'off'
}
