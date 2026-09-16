import { Check, ChevronDown, ChevronRight, Plug, X } from "lucide-react"
import { useEffect, useState } from "react"
import type { PairPickerChoice } from "../../../../inference/picker-catalog.js"
import type { ThemeName, UiLanguage } from "../../../contracts.js"
import lmStudioIcon from "../../assets/lm-studio.svg"
import ollamaIcon from "../../assets/ollama.svg"
import { Button, IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { LANGUAGE_OPTIONS, useI18n } from "../../i18n/index.js"
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
 * Mirrors the TUI's /settings submenu: hosted API key, local model-server endpoints, theme, plus /thinking and /fast
 * toggles; the /debug toggle is development-only and never renders in production builds. Model selection and
 * local-model deletion live in the composer's model picker.
 * Every control writes through the main process; status events update the UI.
 */
export function SettingsPage({ onClose }: { onClose: () => void }) {
  const { api } = useDesktop()
  const { systemLocale, t } = useI18n()
  const state = useDesktopState(
    "fastServing",
    "busy",
    "pairEndpoints",
    "pairConfigured",
    "theme",
    "language",
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

  // Connecting is only half the setup: once endpoints answer, list their models so one can be selected here.
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
        <IconButton icon={X} label={t("settings.close")} className="noDrag" onClick={onClose} />
      </div>

      <div className="settingsPage-scroll">
        <div className="settingsPage-column">
          <div className="settings-section">{t("settings.providers")}</div>

          <button type="button" className="settingsRow settingsRow-expand" onClick={() => toggleForm("hosted")}>
            <span className="settingsRow-label">{t("settings.hostedInference")}</span>
            <Icon icon={openForm === "hosted" ? ChevronDown : ChevronRight} size={12} />
          </button>
          {openForm === "hosted" ? (
            <div className="settingsForm">
              <label className="settingsForm-label" htmlFor="settings-api-key">
                {t("settings.fireworksKey")}
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
                  {t("settings.getKey")}
                </Button>
                <Button variant="primary" size="sm" disabled={hostedPending} onClick={() => void submitHosted()}>
                  {t("common.continue")}
                </Button>
              </div>
              {hostedPending ? <div className="settings-message">{t("settings.checkingHosted")}</div> : null}
              {hostedError ? <div className="settings-message settings-error">{hostedError}</div> : null}
            </div>
          ) : null}

          <button type="button" className="settingsRow settingsRow-expand" onClick={() => toggleForm("pair")}>
            <span className="settingsRow-label">{t("settings.localServers")}</span>
            <Icon icon={openForm === "pair" ? ChevronDown : ChevronRight} size={12} />
          </button>
          {openForm === "pair" ? (
            <div className="settingsForm">
              <p className="settingsForm-note">{t("settings.localServersNote")}</p>
              <div className="settingsEndpoints">
                <label className="settingsEndpoint-label" htmlFor="settings-pair-ollama">
                  <img
                    className="settingsProviderMark settingsProviderMark-ollama"
                    src={ollamaIcon}
                    alt=""
                    aria-hidden
                  />
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
                <label className="settingsEndpoint-label" htmlFor="settings-pair-lmstudio">
                  <img className="settingsProviderMark" src={lmStudioIcon} alt="" aria-hidden />
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
              </div>
              <div className="settingsForm-actions">
                <Button variant="primary" size="sm" disabled={pairPending} onClick={() => void submitPair()}>
                  <Icon icon={Plug} size={13} />
                  {t("common.connect")}
                </Button>
              </div>
              {pairPending ? <div className="settings-message">{t("settings.checkingServers")}</div> : null}
              {pairError ? <div className="settings-message settings-error">{pairError}</div> : null}
              {state.pairConfigured ? (
                <>
                  <div className="settingsForm-label settingsModels-label">{t("settings.availableModels")}</div>
                  {pairModels === undefined ? (
                    <div className="settings-message">{t("common.loadingModels")}</div>
                  ) : null}
                  {pairModels?.length === 0 ? (
                    <div className="settings-message">{t("settings.noServerModels")}</div>
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
                        <span className="settingsRow-meta">{pickerDetailLabel(item, t)}</span>
                      </span>
                      {item.active ? <Icon icon={Check} size={13} /> : null}
                    </button>
                  ))}
                </>
              ) : null}
            </div>
          ) : null}

          <div className="settings-section">{t("settings.appearance")}</div>
          <div className="settingsRow">
            <span className="settingsRow-label">{t("settings.language")}</span>
            <select
              className="settingsSelect"
              aria-label={t("settings.language")}
              value={state.language}
              onChange={(event) => void api.setLanguage(event.target.value as UiLanguage)}
            >
              {LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value === "system"
                    ? t("settings.systemLanguage", {
                        language:
                          LANGUAGE_OPTIONS.find((candidate) => candidate.value === systemLocale)?.label ?? "English",
                      })
                    : option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="settings-section">{t("settings.theme")}</div>
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

          <div className="settings-section">{t("settings.security")}</div>
          <div className="settingsRow">
            <span className="settingsRow-label">
              {t("settings.permissionMode")}
              <span className="settingsRow-meta">
                {state.permissionMode === "auto"
                  ? t("settings.permissionAutoDetail")
                  : state.permissionMode === "ask"
                    ? t("settings.permissionAskDetail")
                    : t("settings.permissionDenyDetail")}
              </span>
            </span>
            <select
              className="settingsSelect"
              aria-label={t("settings.permissionMode")}
              value={state.permissionMode}
              onChange={(event) => {
                const mode = event.target.value
                if (mode === "ask" || mode === "auto") void api.setPermissionMode(mode)
              }}
            >
              {state.permissionMode === "dontAsk" ? (
                <option value="dontAsk" disabled>
                  {t("settings.dontAsk")}
                </option>
              ) : null}
              <option value="ask">{t("settings.ask")}</option>
              <option value="auto">{t("settings.auto")}</option>
            </select>
          </div>

          <div className="settings-section">{t("settings.behavior")}</div>
          <div className="settingsRow">
            <span className="settingsRow-label">{t("settings.thinkingTraces")}</span>
            <Toggle
              label={t("settings.toggleThinking")}
              checked={state.thinkingVisible}
              onChange={(visible) => void api.setThinkingVisible(visible)}
            />
          </div>
          <div className="settingsRow" title={fastServing.available ? undefined : t("settings.fastUnavailable")}>
            <span className="settingsRow-label">
              {t("settings.fastServing")}
              {state.model && fastServing.available ? (
                <span className="settingsRow-meta">{state.model.displayName ?? state.model.id.split("/").pop()}</span>
              ) : null}
            </span>
            <Toggle
              label={t("settings.toggleFast")}
              checked={fastServing.enabled}
              disabled={fastDisabled}
              onChange={(fast) => void toggleFast(fast)}
            />
          </div>
          {!import.meta.env.PROD ? (
            <div className="settingsRow" title={t("settings.debugHint")}>
              <span className="settingsRow-label">{t("settings.debugMode")}</span>
              <Toggle
                label={t("settings.toggleDebug")}
                checked={state.debug}
                onChange={(on) => void api.setDebugMode(on)}
              />
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
