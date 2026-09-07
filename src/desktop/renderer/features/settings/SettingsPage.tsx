import { Check, ChevronDown, ChevronRight, Trash2, X } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import type { DownloadedLocalModel, ThemeName } from "../../../contracts.js"
import { Button, IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { useDesktop, useDesktopState } from "../../runtime.js"

/** Mirrors THEME_NAMES in src/local/settings.ts; that module reads the filesystem and cannot be bundled here. */
const THEME_NAMES: ThemeName[] = [
  "default",
  "nord",
  "bright",
  "matrix",
  "midnight",
  "graphite",
  "beige",
  "vice",
  "eagan",
]

/** Mirrors PAIR_DEFAULT_ENDPOINTS in src/inference/pair.ts; that module's discovery code is not bundled here. */
const PAIR_DEFAULT_ENDPOINTS = { ollama: "http://127.0.0.1:11434", lmStudio: "http://127.0.0.1:1234" }

/**
 * The settings page, opened from the sidebar's gear button. It takes over the whole window, sidebar included.
 * Mirrors the TUI's /settings submenu: hosted API key, NVIDIA PAIR endpoints, local-model deletion, theme, plus
 * the /thinking, /fast, and /debug toggles. Model selection lives in the composer's model picker.
 * Every control writes through the main process; status events update the UI.
 */
export function SettingsPage({ onClose }: { onClose: () => void }) {
  const { api } = useDesktop()
  const state = useDesktopState()
  const [openForm, setOpenForm] = useState<"hosted" | "pair">()

  const [apiKey, setApiKey] = useState("")
  const [hostedPending, setHostedPending] = useState(false)
  const [hostedError, setHostedError] = useState<string>()

  const [ollama, setOllama] = useState("")
  const [lmStudio, setLmStudio] = useState("")
  const [pairPending, setPairPending] = useState(false)
  const [pairError, setPairError] = useState<string>()

  const [downloaded, setDownloaded] = useState<DownloadedLocalModel[]>()
  const [deleting, setDeleting] = useState<string>()
  const [deleteError, setDeleteError] = useState<string>()

  const [fastError, setFastError] = useState<string>()
  const [fastPending, setFastPending] = useState(false)

  const reloadDownloaded = useCallback(async () => {
    try {
      setDownloaded(await api.listDownloadedModels())
    } catch {
      setDownloaded([])
    }
  }, [api])

  useEffect(() => {
    void reloadDownloaded()
  }, [reloadDownloaded])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [onClose])

  if (!state) return null
  const { fastServing } = state
  const fastDisabled = fastPending || !fastServing.available || state.busy

  const toggleForm = (form: "hosted" | "pair") => {
    setHostedError(undefined)
    setPairError(undefined)
    if (form === "pair" && openForm !== "pair") {
      setOllama(state.pairEndpoints.ollama ?? PAIR_DEFAULT_ENDPOINTS.ollama)
      setLmStudio(state.pairEndpoints.lmStudio ?? PAIR_DEFAULT_ENDPOINTS.lmStudio)
    }
    setOpenForm(openForm === form ? undefined : form)
  }

  const submitHosted = async () => {
    setHostedError(undefined)
    setHostedPending(true)
    try {
      const result = await api.setFireworksApiKey(apiKey)
      if (result.ok) {
        setApiKey("")
        setOpenForm(undefined)
      } else {
        setHostedError(result.reason)
      }
    } finally {
      setHostedPending(false)
    }
  }

  const submitPair = async () => {
    setPairError(undefined)
    setPairPending(true)
    try {
      const result = await api.connectPairEndpoints({ ollama, lmStudio })
      if (result.ok) setOpenForm(undefined)
      else setPairError(result.reason)
    } finally {
      setPairPending(false)
    }
  }

  const deleteModel = async (id: string) => {
    setDeleteError(undefined)
    setDeleting(id)
    try {
      const result = await api.deleteLocalModel(id)
      if (!result.ok) setDeleteError(result.reason)
      await reloadDownloaded()
    } finally {
      setDeleting(undefined)
    }
  }

  const toggleFast = async (fast: boolean) => {
    setFastError(undefined)
    setFastPending(true)
    try {
      const result = await api.setFastServing(fast)
      if (
        !result.ok &&
        result.reason !== "The selection was cancelled." &&
        result.reason !== "The selection was superseded."
      ) {
        setFastError(result.reason)
      }
    } finally {
      setFastPending(false)
    }
  }

  return (
    <div className="settingsPage">
      <div className="settingsPage-header">
        <IconButton icon={X} label="Close settings (Esc)" size={22} className="noDrag" onClick={onClose} />
      </div>

      <div className="settingsPage-scroll">
        <div className="settingsPage-column">
          <div className="settings-section">Providers</div>

          <button type="button" className="settingsRow settingsRow-expand" onClick={() => toggleForm("hosted")}>
            <span className="settingsRow-label">Hosted inference</span>
            <span className="settingsRow-meta">{state.hostedConfigured ? "Replace API key" : "Add API key"}</span>
            <Icon icon={openForm === "hosted" ? ChevronDown : ChevronRight} size={12} />
          </button>
          {openForm === "hosted" ? (
            <div className="settingsForm">
              <label className="settingsForm-label" htmlFor="settings-api-key">
                Fireworks API key
              </label>
              <input
                id="settings-api-key"
                type="password"
                className="settingsForm-input"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitHosted()
                }}
                spellCheck={false}
                autoComplete="off"
              />
              <div className="settingsForm-actions">
                <Button variant="ghost" size="sm" onClick={() => void api.openFireworksKeyPage()}>
                  Get a key
                </Button>
                <Button variant="primary" size="sm" disabled={hostedPending} onClick={() => void submitHosted()}>
                  Continue
                </Button>
              </div>
              {hostedPending ? <div className="settings-message">Checking hosted inference...</div> : null}
              {hostedError ? <div className="settings-message settings-error">{hostedError}</div> : null}
            </div>
          ) : null}

          <button type="button" className="settingsRow settingsRow-expand" onClick={() => toggleForm("pair")}>
            <span className="settingsRow-label">NVIDIA PAIR</span>
            <span className="settingsRow-meta">
              {state.pairConfigured ? "Reconnect or choose model" : "Connect local AI cluster"}
            </span>
            <Icon icon={openForm === "pair" ? ChevronDown : ChevronRight} size={12} />
          </button>
          {openForm === "pair" ? (
            <div className="settingsForm">
              <p className="settingsForm-note">
                These are PAIR's standard proxy addresses, or your last saved addresses. Only one working endpoint is
                required. Change an address only if PAIR → Endpoints shows a different proxy port.
              </p>
              <label className="settingsForm-label" htmlFor="settings-pair-ollama">
                Ollama
              </label>
              <input
                id="settings-pair-ollama"
                className="settingsForm-input"
                value={ollama}
                onChange={(event) => setOllama(event.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <label className="settingsForm-label" htmlFor="settings-pair-lmstudio">
                LM Studio
              </label>
              <input
                id="settings-pair-lmstudio"
                className="settingsForm-input"
                value={lmStudio}
                onChange={(event) => setLmStudio(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitPair()
                }}
                spellCheck={false}
                autoComplete="off"
              />
              <div className="settingsForm-actions">
                <Button variant="primary" size="sm" disabled={pairPending} onClick={() => void submitPair()}>
                  Connect
                </Button>
              </div>
              {pairPending ? <div className="settings-message">Checking NVIDIA PAIR endpoints…</div> : null}
              {pairError ? <div className="settings-message settings-error">{pairError}</div> : null}
            </div>
          ) : null}

          {downloaded && downloaded.length > 0 ? (
            <>
              <div className="settings-section">Local models</div>
              {downloaded.map((model) => (
                <div key={model.id} className="settingsRow">
                  <span className="settingsRow-label">
                    {model.displayName}
                    <span className="settingsRow-meta">{model.detail}</span>
                  </span>
                  <IconButton
                    icon={Trash2}
                    label={`Delete ${model.displayName}`}
                    size={22}
                    disabled={deleting !== undefined}
                    onClick={() => void deleteModel(model.id)}
                  />
                </div>
              ))}
              {deleteError ? <div className="settings-message settings-error">{deleteError}</div> : null}
            </>
          ) : null}

          <div className="settings-section">Theme</div>
          <div className="themeGrid">
            {THEME_NAMES.map((theme) => (
              <ThemeTile
                key={theme}
                theme={theme}
                active={theme === state.theme}
                onSelect={(name) => void api.setTheme(name)}
              />
            ))}
          </div>

          <div className="settings-section">Behavior</div>
          <div className="settingsRow">
            <span className="settingsRow-label">Thinking traces</span>
            <Toggle
              label="Show or hide model thinking traces"
              checked={state.thinkingVisible}
              onChange={(visible) => void api.setThinkingVisible(visible)}
            />
          </div>
          <div
            className="settingsRow"
            title={fastServing.available ? undefined : "Fast serving is not available for this model"}
          >
            <span className="settingsRow-label">
              Fast serving
              {state.model && fastServing.available ? (
                <span className="settingsRow-meta">{state.model.displayName ?? state.model.id.split("/").pop()}</span>
              ) : null}
            </span>
            <Toggle
              label="Toggle Fast serving"
              checked={fastServing.enabled}
              disabled={fastDisabled}
              onChange={(fast) => void toggleFast(fast)}
            />
          </div>
          <div className="settingsRow" title="Session only — applies from the next turn">
            <span className="settingsRow-label">Debug mode</span>
            <Toggle label="Toggle debug mode" checked={state.debug} onChange={(on) => void api.setDebugMode(on)} />
          </div>
          {fastError ? <div className="settings-message settings-error">{fastError}</div> : null}
        </div>
      </div>
    </div>
  )
}

/** A theme choice with a live swatch: the nested data-theme resolves this tile's variables to that theme. */
function ThemeTile({
  theme,
  active,
  onSelect,
}: {
  theme: ThemeName
  active: boolean
  onSelect: (theme: ThemeName) => void
}) {
  return (
    <button
      type="button"
      className={`themeTile${active ? " themeTile-active" : ""}`}
      onClick={() => onSelect(theme)}
      aria-pressed={active}
    >
      <span className="themeTile-preview" data-theme={theme}>
        <span className="themeTile-line themeTile-lineText" />
        <span className="themeTile-line themeTile-lineDim" />
        <span className="themeTile-dot" />
      </span>
      <span className="themeTile-name">
        {theme}
        {active ? <Icon icon={Check} size={11} /> : null}
      </span>
    </button>
  )
}

/** A rectangular switch, in keeping with the app's sharp corners. */
function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle${checked ? " toggle-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  )
}
