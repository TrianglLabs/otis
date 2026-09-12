import { Check, ChevronDown, ChevronRight, X } from "lucide-react"
import { useEffect, useState } from "react"
import type { PairPickerChoice } from "../../../../inference/picker-catalog.js"
import type { ThemeName } from "../../../contracts.js"
import { Button, IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { pickerDetailLabel } from "../models/model-list.js"
import { SoftwareUpdates } from "./SoftwareUpdates.js"

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
 * The settings page, opened from the header's gear button or the ⌘K palette. It takes over the whole window.
 * Mirrors the TUI's /settings submenu: hosted API key, NVIDIA PAIR endpoints, theme, plus the /thinking and /fast
 * toggles; the /debug toggle is development-only and never renders in production builds. Model selection and
 * local-model deletion live in the composer's model picker.
 * Every control writes through the main process; status events update the UI.
 */
export function SettingsPage({ onClose }: { onClose: () => void }) {
  const { api } = useDesktop()
  const state = useDesktopState(
    "fastServing",
    "busy",
    "pairEndpoints",
    "pairConfigured",
    "theme",
    "thinkingVisible",
    "permissionMode",
    "model",
    "debug",
  )
  const [openForm, setOpenForm] = useState<"hosted" | "pair">()

  const [apiKey, setApiKey] = useState("")
  const [hostedPending, setHostedPending] = useState(false)
  const [hostedError, setHostedError] = useState<string>()

  const [ollama, setOllama] = useState("")
  const [lmStudio, setLmStudio] = useState("")
  const [pairPending, setPairPending] = useState(false)
  const [pairError, setPairError] = useState<string>()
  const [pairModels, setPairModels] = useState<PairPickerChoice[]>()
  const [pairCatalogReload, setPairCatalogReload] = useState(0)

  const [fastError, setFastError] = useState<string>()
  const [fastPending, setFastPending] = useState(false)

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

  // Connecting is only half the setup: once endpoints answer, list PAIR's models so one can be selected here.
  useEffect(() => {
    if (openForm !== "pair" || !state.pairConfigured) return
    let cancelled = false
    void api
      .listModels()
      .then((items) => {
        if (!cancelled) {
          setPairModels(
            items.filter((item): item is PairPickerChoice => item.kind === "model" && item.provider === "pair"),
          )
        }
      })
      .catch(() => {
        if (!cancelled) setPairModels([])
      })
    return () => {
      cancelled = true
    }
  }, [openForm, state.pairConfigured, pairCatalogReload, api])

  const selectPairModel = async (item: PairPickerChoice) => {
    setPairError(undefined)
    const result = await api.selectModel(item.selectionKey)
    if (result.ok) setPairCatalogReload((n) => n + 1)
    else setPairError(result.reason)
  }

  const submitPair = async () => {
    setPairError(undefined)
    setPairPending(true)
    try {
      const result = await api.connectPairEndpoints({ ollama, lmStudio })
      // The form stays open on success: model selection happens here now. Every successful connect —
      // including reconnects to a changed endpoint — refetches the catalog.
      if (result.ok) setPairCatalogReload((n) => n + 1)
      else setPairError(result.reason)
    } finally {
      setPairPending(false)
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
        <IconButton icon={X} label="Close settings (Esc)" className="noDrag" onClick={onClose} />
      </div>

      <div className="settingsPage-scroll">
        <div className="settingsPage-column">
          <div className="settings-section">Providers</div>

          <button type="button" className="settingsRow settingsRow-expand" onClick={() => toggleForm("hosted")}>
            <span className="settingsRow-label">Hosted inference</span>
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
              {state.pairConfigured ? (
                <>
                  <div className="settingsForm-label">Models on your network</div>
                  {pairModels === undefined ? <div className="settings-message">Loading models…</div> : null}
                  {pairModels?.length === 0 ? (
                    <div className="settings-message">PAIR's endpoints report no models.</div>
                  ) : null}
                  {pairModels?.map((item) => (
                    <button
                      type="button"
                      key={item.selectionKey}
                      className="settingsRow settingsRow-expand"
                      onClick={() => void selectPairModel(item)}
                    >
                      <span className="settingsRow-label">
                        {item.displayName}
                        <span className="settingsRow-meta">{pickerDetailLabel(item)}</span>
                      </span>
                      {item.active ? <Icon icon={Check} size={13} /> : null}
                    </button>
                  ))}
                </>
              ) : null}
            </div>
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

          <div className="settings-section">Security</div>
          <div className="settingsRow">
            <span className="settingsRow-label">
              Permission mode
              <span className="settingsRow-meta">
                {state.permissionMode === "auto"
                  ? "Run shell commands and file changes automatically"
                  : state.permissionMode === "ask"
                    ? "Ask before shell commands and file changes"
                    : "Deny shell commands and file changes without asking"}
              </span>
            </span>
            <select
              className="settingsSelect"
              aria-label="Permission mode"
              value={state.permissionMode}
              onChange={(event) => {
                const mode = event.target.value
                if (mode === "ask" || mode === "auto") void api.setPermissionMode(mode)
              }}
            >
              {state.permissionMode === "dontAsk" ? (
                <option value="dontAsk" disabled>
                  Don’t ask
                </option>
              ) : null}
              <option value="ask">Ask</option>
              <option value="auto">Auto</option>
            </select>
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
          {!import.meta.env.PROD ? (
            <div className="settingsRow" title="Session only — applies from the next turn">
              <span className="settingsRow-label">Debug mode</span>
              <Toggle label="Toggle debug mode" checked={state.debug} onChange={(on) => void api.setDebugMode(on)} />
            </div>
          ) : null}
          {fastError ? <div className="settings-message settings-error">{fastError}</div> : null}
          <SoftwareUpdates />
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

/** A pill switch, in keeping with the app's soft geometry. */
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
