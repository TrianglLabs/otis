import {
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  LoaderCircle,
  Palette,
  Plug,
  Puzzle,
  SlidersHorizontal,
  X,
} from "lucide-react"
import { type CSSProperties, useEffect, useRef, useState } from "react"
import type { OmlxPickerChoice, PairPickerChoice } from "../../../../inference/picker-catalog.js"
import { localServerNames, supportsOmlx } from "../../../../inference/types.js"
import type { LocalStats } from "../../../../local/stats.js"
import type { SessionOpResult, SkillsSummary, ThemeName, UiLanguage } from "../../../contracts.js"
import lmStudioIcon from "../../assets/lm-studio.svg"
import ollamaIcon from "../../assets/ollama.svg"
import omlxIcon from "../../assets/omlx.svg"
import { Button, IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { formatTokenCount } from "../../format.js"
import { LANGUAGE_OPTIONS, useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { pickerDetailLabel } from "../models/model-list.js"

/**
 * Mirrors THEME_NAMES in src/local/settings.ts; that module reads the filesystem and cannot be
 * bundled here.
 */
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
  "pearl",
  "sage",
  "titanium",
]

/**
 * Mirrors PAIR_DEFAULT_ENDPOINTS in src/inference/pair.ts; that module's discovery code is not
 * bundled here.
 */
const PAIR_DEFAULT_ENDPOINTS = {
  ollama: "http://127.0.0.1:11434",
  lmStudio: "http://127.0.0.1:1234",
}

const SETTINGS_TABS = {
  providers: { label: "settings.inference", icon: Cpu },
  extensions: { label: "settings.extensions", icon: Puzzle },
  appearance: { label: "settings.appearance", icon: Palette },
  general: { label: "settings.general", icon: SlidersHorizontal },
} as const

type SettingsTab = keyof typeof SETTINGS_TABS

/** Skills list in pages of this many; a suite can bring a hundred. */
const SKILLS_PAGE = 10

const SKILL_ORIGINS = {
  bundled: "settings.skillBundled",
  personal: "settings.skillPersonal",
  project: "settings.skillProject",
} as const
const SETTINGS_TAB_IDS = Object.keys(SETTINGS_TABS) as SettingsTab[]

/**
 * The settings page, opened from the header's gear button or the ⌘K palette. It takes over the
 * whole window. Mirrors the TUI's /settings submenu: hosted API key, local model-server endpoints,
 * theme, plus /thinking and /fast toggles; the /debug toggle is development-only and never renders
 * in production builds. Model selection and local-model deletion live in the composer's model
 * picker. Every control writes through the main process; status events update the UI.
 */
export function SettingsPage({
  onClose,
  installing,
  onInstallUpdate,
}: {
  onClose: () => void
  installing: boolean
  onInstallUpdate: () => void
}) {
  const { api } = useDesktop()
  const { locale, systemLocale, t } = useI18n()
  const state = useDesktopState(
    "fastServing",
    "busy",
    "working",
    "pairEndpoints",
    "omlx",
    "platform",
    "pairConfigured",
    "theme",
    "language",
    "thinkingVisible",
    "notifyOnCompletion",
    "permissionMode",
    "model",
    "debug",
    "stats",
  )
  const showOmlx = supportsOmlx(state?.platform)
  const servers = new Intl.ListFormat(locale, { type: "disjunction" }).format(
    localServerNames(state?.platform),
  )
  const [activeTab, setActiveTab] = useState<SettingsTab>("providers")
  const [openForm, setOpenForm] = useState<"hosted" | "pair">()
  const tabRefs = useRef(new Map<SettingsTab, HTMLButtonElement>())

  const [apiKey, setApiKey] = useState("")
  const [hostedPending, setHostedPending] = useState(false)
  const [hostedError, setHostedError] = useState<string>()

  const [ollama, setOllama] = useState("")
  const [lmStudio, setLmStudio] = useState("")
  const [omlx, setOmlx] = useState("")
  const [omlxApiKey, setOmlxApiKey] = useState("")
  const [pairPending, setPairPending] = useState(false)
  const [pairError, setPairError] = useState<string>()
  const [pairModels, setPairModels] = useState<(PairPickerChoice | OmlxPickerChoice)[]>()
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

  // Keep hooks unconditional while the initial snapshot is loading.
  useEffect(() => {
    if (activeTab !== "providers" || openForm !== "pair" || !(state?.pairConfigured || state?.omlx))
      return
    let cancelled = false
    void api
      .listModels()
      .then((items) => {
        if (cancelled) return
        setPairModels(
          items.filter(
            (item): item is PairPickerChoice | OmlxPickerChoice =>
              item.kind === "model" && (item.provider === "pair" || item.provider === "omlx"),
          ),
        )
      })
      .catch(() => {
        if (!cancelled) setPairModels([])
      })
    return () => {
      cancelled = true
    }
  }, [activeTab, openForm, state?.pairConfigured, state?.omlx, pairCatalogReload, api])

  if (!state) return null
  const { fastServing } = state
  const fastDisabled = fastPending || !fastServing.available || state.busy || state.working > 0

  const toggleForm = (form: "hosted" | "pair") => {
    setHostedError(undefined)
    setPairError(undefined)
    if (form === "pair" && openForm !== "pair") {
      setOllama(state.pairEndpoints.ollama ?? PAIR_DEFAULT_ENDPOINTS.ollama)
      setLmStudio(state.pairEndpoints.lmStudio ?? PAIR_DEFAULT_ENDPOINTS.lmStudio)
      setOmlx(showOmlx ? (state.omlx?.baseURL ?? "http://127.0.0.1:8000") : "")
      setOmlxApiKey("")
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
      const result = await api.connectLocalServers({
        ollama,
        lmStudio,
        ...(showOmlx ? { omlx, omlxApiKey } : {}),
      })
      // The form stays open on success: model selection happens here now. Every successful connect
      // — including reconnects to a changed endpoint — refetches the catalog.
      if (result.ok) {
        setPairCatalogReload((n) => n + 1)
        setOmlxApiKey("")
      } else setPairError(result.reason)
    } finally {
      setPairPending(false)
    }
  }

  return (
    <div
      className="settingsPage"
      onPointerDownCapture={(event) => {
        event.currentTarget.dataset.pointerInput = "true"
      }}
      onKeyDownCapture={(event) => {
        delete event.currentTarget.dataset.pointerInput
      }}
    >
      <header className="workspaceHeader settingsPage-header">
        <div className="workspaceHeader-right">
          <IconButton icon={X} label={t("settings.close")} className="noDrag" onClick={onClose} />
        </div>
      </header>

      <div className="settingsPage-body">
        <nav className="settingsSidebar" aria-label={t("common.settings")}>
          <div className="settingsSidebar-tabs" role="tablist" aria-orientation="vertical">
            {SETTINGS_TAB_IDS.map((id, index) => (
              <button
                key={id}
                ref={(node) => {
                  if (node) tabRefs.current.set(id, node)
                  else tabRefs.current.delete(id)
                }}
                type="button"
                role="tab"
                id={`settings-tab-${id}`}
                aria-controls={`settings-panel-${id}`}
                aria-selected={activeTab === id}
                tabIndex={activeTab === id ? 0 : -1}
                className={`settingsSidebar-tab${
                  activeTab === id ? " settingsSidebar-tabActive" : ""
                }`}
                onClick={() => setActiveTab(id)}
                onKeyDown={(event) => {
                  let nextIndex: number | undefined
                  if (event.key === "ArrowDown" || event.key === "ArrowRight")
                    nextIndex = (index + 1) % SETTINGS_TAB_IDS.length
                  else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                    nextIndex = (index - 1 + SETTINGS_TAB_IDS.length) % SETTINGS_TAB_IDS.length
                  } else if (event.key === "Home") nextIndex = 0
                  else if (event.key === "End") nextIndex = SETTINGS_TAB_IDS.length - 1
                  if (nextIndex === undefined) return
                  event.preventDefault()
                  const nextTab = SETTINGS_TAB_IDS[nextIndex]
                  setActiveTab(nextTab)
                  tabRefs.current.get(nextTab)?.focus()
                }}
              >
                <Icon icon={SETTINGS_TABS[id].icon} size={14} />
                <span>{t(SETTINGS_TABS[id].label)}</span>
              </button>
            ))}
          </div>
        </nav>

        <main
          key={activeTab}
          className="settingsPage-content"
          role="tabpanel"
          id={`settings-panel-${activeTab}`}
          aria-labelledby={`settings-tab-${activeTab}`}
        >
          <div className="settingsPage-column">
            <h1 className="settingsPage-title">{t(SETTINGS_TABS[activeTab].label)}</h1>
            {activeTab === "providers" ? (
              <>
                <div className="settingsGroup">
                  <h2 className="settings-section">{t("settings.providers")}</h2>
                  <div className="settingsSurface">
                    <section className="settingsProvider">
                      <button
                        type="button"
                        className="settingsRow settingsRow-expand"
                        aria-expanded={openForm === "hosted"}
                        onClick={() => toggleForm("hosted")}
                      >
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
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void api.openFireworksKeyPage()}
                            >
                              {t("settings.getKey")}
                            </Button>
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={hostedPending}
                              onClick={() => void submitHosted()}
                            >
                              {t("common.continue")}
                            </Button>
                          </div>
                          {hostedPending ? (
                            <div className="settings-message">{t("settings.checkingHosted")}</div>
                          ) : null}
                          {hostedError ? (
                            <div className="settings-message settings-error">{hostedError}</div>
                          ) : null}
                        </div>
                      ) : null}
                    </section>

                    <section className="settingsProvider">
                      <button
                        type="button"
                        className="settingsRow settingsRow-expand"
                        aria-expanded={openForm === "pair"}
                        onClick={() => toggleForm("pair")}
                      >
                        <span className="settingsRow-label">{t("settings.localServers")}</span>
                        <Icon icon={openForm === "pair" ? ChevronDown : ChevronRight} size={12} />
                      </button>
                      {openForm === "pair" ? (
                        <div className="settingsForm">
                          <p className="settingsForm-note">
                            {t("settings.localServersNote", { servers })}
                          </p>
                          <div className="settingsEndpoints">
                            <label
                              className="settingsEndpoint-label"
                              htmlFor="settings-pair-ollama"
                            >
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
                            <label
                              className="settingsEndpoint-label"
                              htmlFor="settings-pair-lmstudio"
                            >
                              <img
                                className="settingsProviderMark"
                                src={lmStudioIcon}
                                alt=""
                                aria-hidden
                              />
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
                            {showOmlx ? (
                              <>
                                <label className="settingsEndpoint-label" htmlFor="settings-omlx">
                                  <img
                                    className="settingsProviderMark"
                                    src={omlxIcon}
                                    alt=""
                                    aria-hidden
                                  />
                                  oMLX
                                </label>
                                <input
                                  id="settings-omlx"
                                  className="settingsForm-input"
                                  value={omlx}
                                  onChange={(event) => setOmlx(event.target.value)}
                                  spellCheck={false}
                                  autoComplete="off"
                                />
                                <input
                                  id="settings-omlx-key"
                                  type="password"
                                  className="settingsForm-input settingsEndpoint-key"
                                  aria-label={t("settings.omlxKey")}
                                  value={omlxApiKey}
                                  onChange={(event) => setOmlxApiKey(event.target.value)}
                                  placeholder={
                                    state.omlx?.hasApiKey
                                      ? t("settings.omlxKeyHint")
                                      : t("settings.omlxKey")
                                  }
                                  autoComplete="off"
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") void submitPair()
                                  }}
                                />
                              </>
                            ) : null}
                          </div>
                          <div className="settingsForm-actions">
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={pairPending}
                              onClick={() => void submitPair()}
                            >
                              <Icon icon={Plug} size={13} />
                              {t("common.connect")}
                            </Button>
                          </div>
                          {pairPending ? (
                            <div className="settings-message">{t("settings.checkingServers")}</div>
                          ) : null}
                          {pairError ? (
                            <div className="settings-message settings-error">{pairError}</div>
                          ) : null}
                          {state.pairConfigured || state.omlx ? (
                            <>
                              <div className="settingsForm-label settingsModels-label">
                                {t("settings.availableModels")}
                              </div>
                              {pairModels === undefined ? (
                                <div className="settings-message">{t("common.loadingModels")}</div>
                              ) : null}
                              {pairModels?.length === 0 ? (
                                <div className="settings-message">
                                  {t("settings.noServerModels")}
                                </div>
                              ) : null}
                              {pairModels?.map((item) => (
                                <button
                                  type="button"
                                  key={item.selectionKey}
                                  className="settingsRow settingsRow-expand"
                                  onClick={() => {
                                    setPairError(undefined)
                                    void api.selectModel(item.selectionKey).then((result) => {
                                      if (!result.ok) return setPairError(result.reason)
                                      setPairCatalogReload((n) => n + 1)
                                      setOmlxApiKey("")
                                    })
                                  }}
                                >
                                  <span className="settingsRow-label">
                                    {item.displayName}
                                    <span className="settingsRow-meta">
                                      {pickerDetailLabel(item, t)}
                                    </span>
                                  </span>
                                  {item.active ? <Icon icon={Check} size={13} /> : null}
                                </button>
                              ))}
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </section>
                  </div>
                </div>

                <UsageStats stats={state.stats} />
              </>
            ) : null}

            {activeTab === "extensions" ? <SkillsSettings /> : null}
            {activeTab === "appearance" ? (
              <>
                <div className="settingsRow settingsLanguage settingsSurface">
                  <label className="settingsRow-label" htmlFor="settings-language">
                    {t("settings.language")}
                  </label>
                  <select
                    id="settings-language"
                    className="settingsSelect"
                    value={state.language}
                    onChange={(event) => void api.setLanguage(event.target.value as UiLanguage)}
                  >
                    {LANGUAGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.value === "system"
                          ? t("settings.systemLanguage", {
                              language:
                                LANGUAGE_OPTIONS.find(
                                  (candidate) => candidate.value === systemLocale,
                                )?.label ?? "English",
                            })
                          : option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="settingsGroup">
                  <h2 className="settings-section">{t("settings.theme")}</h2>
                  <div className="themeGrid settingsSurface">
                    {THEME_NAMES.map((theme) => (
                      <button
                        key={theme}
                        type="button"
                        className={`themeTile${theme === state.theme ? " themeTile-active" : ""}`}
                        onClick={() => void api.setTheme(theme)}
                        aria-pressed={theme === state.theme}
                      >
                        <span className="themeTile-preview" data-theme={theme} aria-hidden="true">
                          <svg
                            width="100%"
                            height="100%"
                            viewBox="0 0 56 40"
                            fill="none"
                            aria-hidden="true"
                          >
                            <path fill="var(--bg-elev)" d="M0 0h13v40H0z" />
                            <rect x="4" y="7" width="5" height="3" rx="1" fill="var(--accent)" />
                            <path fill="var(--text-dim)" d="M4 14h5v2H4zm0 6h5v2H4z" />
                            <rect x="21" y="6" width="28" height="9" rx="3" fill="var(--bg-user)" />
                            <path fill="var(--text)" d="M26 10h18v2H26zM19 21h25v2H19z" />
                            <path fill="var(--text-dim)" d="M19 25h17v2H19z" />
                            <rect
                              x="19"
                              y="31"
                              width="30"
                              height="5"
                              rx="2"
                              fill="var(--bg-elev)"
                            />
                            <circle cx="45.5" cy="33.5" r="1.5" fill="var(--accent)" />
                          </svg>
                        </span>
                        <span className="themeTile-name">
                          {theme}
                          {theme === state.theme ? <Icon icon={Check} size={11} /> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : null}

            {activeTab === "general" ? (
              <>
                <div className="settingsGroup">
                  <h2 className="settings-section">{t("settings.security")}</h2>
                  <div className="settingsSurface">
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
                  </div>
                </div>

                <div className="settingsGroup">
                  <h2 className="settings-section">{t("settings.behavior")}</h2>
                  <div className="settingsSurface">
                    <div className="settingsRow">
                      <span className="settingsRow-label">{t("settings.thinkingTraces")}</span>
                      <Toggle
                        label={t("settings.toggleThinking")}
                        checked={state.thinkingVisible}
                        onChange={(visible) => void api.setThinkingVisible(visible)}
                      />
                    </div>
                    <div className="settingsRow">
                      <span className="settingsRow-label">{t("settings.notifyOnCompletion")}</span>
                      <Toggle
                        label={t("settings.toggleNotify")}
                        checked={state.notifyOnCompletion}
                        onChange={(enabled) => void api.setNotifyOnCompletion(enabled)}
                      />
                    </div>
                    <div
                      className="settingsRow"
                      title={fastServing.available ? undefined : t("settings.fastUnavailable")}
                    >
                      <span className="settingsRow-label">
                        {t("settings.fastServing")}
                        {state.model && fastServing.available ? (
                          <span className="settingsRow-meta">
                            {state.model.displayName ?? state.model.id.split("/").pop()}
                          </span>
                        ) : null}
                      </span>
                      <Toggle
                        label={t("settings.toggleFast")}
                        checked={fastServing.enabled}
                        disabled={fastDisabled}
                        onChange={async (fast) => {
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
                        }}
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
                    {fastError ? (
                      <div className="settings-message settings-error">{fastError}</div>
                    ) : null}
                  </div>
                </div>

                <div className="settingsGroup">
                  <h2 className="settings-section">{t("updates.title")}</h2>
                  <div className="settingsSurface">
                    <SoftwareUpdates installing={installing} onInstall={onInstallUpdate} />
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </main>
      </div>
    </div>
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

function SoftwareUpdates({
  installing,
  onInstall,
}: {
  installing: boolean
  onInstall: () => void
}) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const state = useDesktopState("update", "version")
  const [requesting, setRequesting] = useState(false)
  const [requestFailed, setRequestFailed] = useState(false)
  // "You're up to date." is a check result, not a resting status: it only appears after a manual
  // check.
  const [hasChecked, setHasChecked] = useState(false)
  if (!state) return null

  const { update } = state
  const downloading = update.status === "downloading"
  const ready = update.status === "ready"
  const unavailable = update.status === "unavailable"
  const checking =
    update.status === "checking" ||
    (requesting && !downloading && !ready && update.status !== "error")
  const failed = requestFailed || update.status === "error"

  const message =
    checking || downloading || ready || installing
      ? undefined
      : requestFailed
        ? t("updates.checkFailed")
        : update.status === "error"
          ? update.message
          : unavailable
            ? t("updates.unavailableBuild")
            : hasChecked && update.status === "current"
              ? t("updates.upToDate")
              : undefined

  return (
    <div className="settingsRow settingsUpdate">
      <span className="settingsRow-label">
        Otis <span className="settingsRow-meta">{state.version}</span>
      </span>
      {message ? (
        <span className={`settingsUpdate-status${failed ? " settings-error" : ""}`} role="status">
          {message}
        </span>
      ) : null}
      <Button
        size="sm"
        disabled={installing || checking || downloading || unavailable}
        onClick={
          ready
            ? onInstall
            : async () => {
                setRequesting(true)
                setRequestFailed(false)
                setHasChecked(true)
                try {
                  await api.checkForUpdates()
                } catch {
                  setRequestFailed(true)
                } finally {
                  setRequesting(false)
                }
              }
        }
        aria-live="polite"
        aria-busy={installing || checking || downloading}
        title={
          ready
            ? t("updates.versionReady", { version: update.version })
            : downloading
              ? t("updates.downloadingVersion", { version: update.version })
              : undefined
        }
      >
        {installing || checking || downloading ? (
          <Icon icon={LoaderCircle} size={12} className="spin" />
        ) : null}
        {installing
          ? t("shell.restarting")
          : checking
            ? t("updates.checking")
            : downloading
              ? t("updates.downloading")
              : ready
                ? t("updates.restartInstall")
                : t("updates.check")}
      </Button>
    </div>
  )
}

function UsageStats({ stats }: { stats: LocalStats | undefined }) {
  const { locale, t } = useI18n()
  const [activeDate, setActiveDate] = useState<string>()

  if (!stats) {
    return (
      <div className="settingsGroup">
        <h2 className="settings-section">{t("settings.usage")}</h2>
        <section className="settingsSurface settingsUsage settingsUsage-loading" aria-busy="true">
          {t("settings.usageLoading")}
        </section>
      </div>
    )
  }

  const recentActivity = stats.recentActivity
  const maxDailyTokens = Math.max(1, ...recentActivity.map((day) => day.tokens))
  const number = new Intl.NumberFormat(locale)
  const firstDay = recentActivity[0]
  const lastDay = recentActivity.at(-1)
  const activeDay = recentActivity.find((day) => day.date === activeDate)
  const { promptTokens, completionTokens } = stats
  const countedTokens = promptTokens + completionTokens
  const inputShare = countedTokens === 0 ? 0 : (promptTokens / countedTokens) * 100

  return (
    <div className="settingsGroup">
      <h2 className="settings-section">{t("settings.usage")}</h2>
      <section className="settingsSurface settingsUsage" aria-label={t("settings.usage")}>
        <div className="settingsUsage-hero">
          <div className="settingsUsage-total">
            <span className="settingsUsage-eyebrow">{t("settings.usageTotal")}</span>
            <strong title={number.format(stats.totalTokens)}>
              {formatTokenCount(stats.totalTokens)}
            </strong>
            <span className="settingsUsage-note">{t("settings.usagePrivate")}</span>
          </div>
          <div className="settingsUsage-mix">
            <span className="settingsUsage-mixTitle">{t("settings.usageTokenMix")}</span>
            <div
              className="settingsUsage-mixTrack"
              data-empty={countedTokens === 0 ? "true" : undefined}
              style={{ "--usage-input-share": `${inputShare}%` } as CSSProperties}
              aria-hidden="true"
            />
            <div className="settingsUsage-mixValues">
              <span>
                <i className="settingsUsage-mixDot settingsUsage-mixDotInput" />
                {t("settings.usageInput")}
                <strong>{formatTokenCount(promptTokens)}</strong>
              </span>
              <span>
                <i className="settingsUsage-mixDot settingsUsage-mixDotOutput" />
                {t("settings.usageOutput")}
                <strong>{formatTokenCount(completionTokens)}</strong>
              </span>
            </div>
          </div>
        </div>

        <div className="settingsUsage-metrics">
          <UsageMetric
            label={t("settings.usageSessions")}
            value={number.format(stats.sessionCount)}
          />
          <UsageMetric
            label={t("settings.usageActiveDays")}
            value={number.format(stats.activeDays)}
          />
          <UsageMetric label={t("settings.usageStreak")} value={number.format(stats.streak)} />
        </div>

        <div className="settingsUsage-activity">
          <div className="settingsUsage-activityHeader">
            <span>{t("settings.usageRecent")}</span>
            {activeDay ? (
              <span className="settingsUsage-activeDay">
                {t("settings.usageDay", {
                  date: formatLongDate(activeDay.date, locale),
                  tokens: number.format(activeDay.tokens),
                })}
              </span>
            ) : firstDay && lastDay ? (
              <span>
                {formatShortDate(firstDay.date, locale)}–{formatShortDate(lastDay.date, locale)}
              </span>
            ) : null}
          </div>
          <div className="settingsUsage-chart">
            {recentActivity.map((day) => {
              const percent = Math.round((day.tokens / maxDailyTokens) * 100)
              const label = t("settings.usageDay", {
                date: formatLongDate(day.date, locale),
                tokens: number.format(day.tokens),
              })
              return (
                <button
                  type="button"
                  key={day.date}
                  className="settingsUsage-barSlot"
                  data-empty={day.tokens === 0 ? "true" : undefined}
                  style={{ "--usage-level": `${percent}%` } as CSSProperties}
                  aria-label={label}
                  onPointerEnter={() => setActiveDate(day.date)}
                  onPointerLeave={() => setActiveDate(undefined)}
                  onFocus={() => setActiveDate(day.date)}
                  onBlur={() => setActiveDate(undefined)}
                >
                  <span className="settingsUsage-bar" />
                </button>
              )
            })}
          </div>
          <div className="settingsUsage-average">
            <span>
              {t("settings.usageAverageTokens", {
                tokens: formatTokenCount(Math.round(stats.avgTokensPerSession)),
              })}
            </span>
            <span>
              {t("settings.usageAverageTime", {
                duration:
                  stats.avgSessionSeconds >= 3_600
                    ? `${(stats.avgSessionSeconds / 3_600).toFixed(1)}h`
                    : stats.avgSessionSeconds >= 60
                      ? `${Math.round(stats.avgSessionSeconds / 60)}m`
                      : `${Math.round(stats.avgSessionSeconds)}s`,
              })}
            </span>
          </div>
        </div>
      </section>
    </div>
  )
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="settingsUsage-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

function formatShortDate(date: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(localDate(date))
}

function formatLongDate(date: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", year: "numeric" }).format(
    localDate(date),
  )
}

function localDate(date: string) {
  return new Date(`${date}T12:00:00`)
}

/**
 * The skills the agent can load, reread from disk each time the tab opens, and the Git collections
 * Otis manages: install by URL, fast-forward, remove. Personal and project skills are files the
 * user places; the note says where.
 */
function SkillsSettings() {
  const { api } = useDesktop()
  const { t } = useI18n()
  const [summary, setSummary] = useState<SkillsSummary>()
  const [url, setUrl] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [limit, setLimit] = useState(SKILLS_PAGE)
  useEffect(() => {
    void api.listSkills().then(setSummary)
  }, [api])
  const change = async (operation: () => Promise<SessionOpResult>) => {
    setPending(true)
    setError(undefined)
    const result = await operation()
    setPending(false)
    if (result.ok) setSummary(await api.listSkills())
    else setError(result.reason)
    return result.ok
  }
  const install = async () => {
    const target = url.trim()
    if (target && (await change(() => api.installSkills(target)))) setUrl("")
  }
  return (
    <>
      <div className="settingsGroup">
        <h2 className="settings-section">{t("settings.skillsInstalled")}</h2>
        <div className="settingsSurface">
          {summary?.sources.length === 0 ? (
            <div className="settingsRow settings-message">{t("settings.noSkillsInstalled")}</div>
          ) : null}
          {summary?.sources.map((source) => (
            <div className="settingsRow" key={source.id}>
              <span className="settingsRow-label">
                <span>{source.id}</span>
                <span className="settingsRow-meta">
                  {t("settings.skillCollectionSkills", { count: source.skills.length })} ·{" "}
                  {source.url}
                </span>
              </span>
              <span className="settingsSkills-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => void change(() => api.updateSkills(source.id))}
                >
                  {t("settings.skillUpdate")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => void change(() => api.removeSkills(source.id))}
                >
                  {t("settings.skillRemove")}
                </Button>
              </span>
            </div>
          ))}
          <div className="settingsForm settingsSkills-install">
            <label className="settingsForm-label" htmlFor="settings-skill-url">
              {t("settings.skillUrl")}
            </label>
            <input
              id="settings-skill-url"
              className="settingsForm-input"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void install()
              }}
              placeholder="https://github.com/…"
              spellCheck={false}
              autoComplete="off"
            />
            <div className="settingsForm-actions">
              <Button
                variant="primary"
                size="sm"
                disabled={pending || !url.trim()}
                onClick={() => void install()}
              >
                {t("settings.skillInstall")}
              </Button>
            </div>
            {pending ? <div className="settings-message">{t("settings.skillsWorking")}</div> : null}
            {error ? <div className="settings-message settings-error">{error}</div> : null}
          </div>
        </div>
      </div>
      <div className="settingsGroup">
        <h2 className="settings-section">{t("settings.skillsAll")}</h2>
        <div className="settingsSurface">
          {summary === undefined ? (
            <div className="settingsRow settings-message">{t("settings.skillsLoading")}</div>
          ) : null}
          {summary?.skills.length === 0 ? (
            <div className="settingsRow settings-message">{t("settings.noSkills")}</div>
          ) : null}
          {summary?.skills.slice(0, limit).map((skill) => (
            <div className="settingsRow" key={skill.name}>
              <span className="settingsRow-label settingsSkill">
                <span>{skill.name}</span>
                <span
                  className="settingsRow-meta settingsSkill-description"
                  title={skill.description}
                >
                  {skill.description}
                </span>
              </span>
              <span className="settingsRow-meta settingsSkill-origin">
                {typeof skill.origin === "string"
                  ? t(SKILL_ORIGINS[skill.origin])
                  : skill.origin.collection}
              </span>
            </div>
          ))}
          {summary && summary.skills.length > limit ? (
            <div className="settingsRow">
              <span className="settingsRow-meta">
                {t("settings.skillsShown", { shown: limit, total: summary.skills.length })}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setLimit(limit + SKILLS_PAGE)}>
                {t("settings.skillsMore")}
              </Button>
            </div>
          ) : null}
        </div>
        <p className="settingsForm-note settingsSkills-note">{t("settings.skillsNote")}</p>
      </div>
    </>
  )
}
