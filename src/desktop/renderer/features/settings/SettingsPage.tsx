import {
  Award,
  Box,
  ChartNoAxesColumnDecreasing,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Cpu,
  FileText,
  Globe,
  KeyRound,
  Laptop,
  LoaderCircle,
  NotebookPen,
  Palette,
  Plug,
  Puzzle,
  RulerDimensionLine,
  SlidersHorizontal,
  X,
} from "lucide-react"
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react"
import type { ServerInput } from "../../../../app/local-servers.js"
import type { PairPickerChoice, ServerPickerChoice } from "../../../../inference/picker-catalog.js"
import { hiddenModelKey } from "../../../../inference/picker-filter.js"
import {
  HOSTED_PROVIDER_INFO,
  HOSTED_PROVIDERS,
  type HostedModel,
  type HostedProvider,
  isServerProvider,
  type LocalServerTab,
  localServerNames,
  localServerTabs,
  type ServerProvider,
  serverFormInputs,
} from "../../../../inference/types.js"
import type { LocalStats } from "../../../../local/stats.js"
import type {
  DesktopApi,
  SessionOpResult,
  TextSize,
  ThemeName,
  UiLanguage,
} from "../../../contracts.js"
import { Button, IconButton, Toggle } from "../../components/Button.js"
import { Icon, RetentionBadge } from "../../components/Icon.js"
import { TabStrip } from "../../components/TabStrip.js"
import { TextField } from "../../components/TextField.js"
import { formatTokenCount, usageBreakdown } from "../../format.js"
import { LANGUAGE_OPTIONS, useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { AchievementsTab } from "../achievements/Achievements.js"
import { ModelDetail } from "../models/ModelPicker.js"

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
  usage: { label: "settings.usage", icon: ChartNoAxesColumnDecreasing },
  achievements: { label: "settings.achievements", icon: Award },
} as const

export type SettingsTab = keyof typeof SETTINGS_TABS

/** Skills list in pages of this many; a suite can bring a hundred. */
const SKILLS_PAGE = 10
const MODELS_SHOWN = 5

const SKILL_ORIGINS = {
  bundled: "settings.skillBundled",
  personal: "settings.skillPersonal",
  project: "settings.skillProject",
} as const
const SETTINGS_TAB_IDS = Object.keys(SETTINGS_TABS) as SettingsTab[]

/** Mirrors TEXT_SIZES in src/local/settings.ts, for the same reason as THEME_NAMES. */
const TEXT_SIZES: TextSize[] = ["small", "default", "large", "larger"]
const TEXT_SIZE_LABELS = {
  small: "settings.textSizeSmall",
  default: "settings.textSizeDefault",
  large: "settings.textSizeLarge",
  larger: "settings.textSizeLarger",
} as const

/**
 * The settings page, opened from the header's gear button or the ⌘K palette. It takes over the
 * whole window. Mirrors the TUI's /settings submenu: hosted API keys, local model-server endpoints,
 * theme, plus /thinking and /fast toggles; the /debug toggle is development-only and never renders
 * in production builds. Model selection and local-model deletion live in the composer's model
 * picker. Every control writes through the main process; status events update the UI.
 */
export function SettingsPage({
  open,
  onClose,
  installing,
  onInstallUpdate,
  initialTab = "providers",
}: {
  open: boolean
  onClose: () => void
  installing: boolean
  onInstallUpdate: () => void
  initialTab?: SettingsTab
}) {
  const { api } = useDesktop()
  const { locale, systemLocale, t } = useI18n()
  const state = useDesktopState(
    "freshAchievements",
    "fastServing",
    "busy",
    "working",
    "pairEndpoints",
    "servers",
    "runtimePlatform",
    "pairConfigured",
    "hostedConfigured",
    "hiddenModels",
    "theme",
    "textSize",
    "language",
    "thinkingVisible",
    "notifyOnCompletion",
    "permissionMode",
    "model",
    "debug",
    "remote",
    "remoteSaved",
    "stats",
    "primeTeamId",
  )
  const servers = new Intl.ListFormat(locale, { type: "disjunction" }).format(
    localServerNames(state?.runtimePlatform),
  )
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab)
  // An unlock banner clicked while settings is already open still lands on its tab.
  const [openForm, setOpenForm] = useState<"pair" | HostedProvider>()
  const [hostedOpen, setHostedOpen] = useState(false)
  const [extension, setExtension] = useState<"skills" | "memory">("skills")
  const tabRefs = useRef(new Map<SettingsTab, HTMLButtonElement>())

  // The server form shows one server at a time; every address stays in state and is probed.
  const [serverTab, setServerTab] = useState<LocalServerTab>("ollama")
  const [pairInputs, setPairInputs] = useState({ ollama: "", lmStudio: "" })
  const [serverInputs, setServerInputs] = useState<Partial<Record<ServerProvider, ServerInput>>>({})
  const setServer = (provider: ServerProvider, patch: Partial<ServerInput>) =>
    setServerInputs((inputs) => ({
      ...inputs,
      [provider]: { baseURL: "", ...inputs[provider], ...patch },
    }))
  const connected = (tab: LocalServerTab) =>
    Boolean(isServerProvider(tab) ? state?.servers[tab] : state?.pairEndpoints[tab])
  const address = isServerProvider(serverTab)
    ? (serverInputs[serverTab]?.baseURL ?? "")
    : pairInputs[serverTab]
  const setAddress = (baseURL: string) =>
    isServerProvider(serverTab)
      ? setServer(serverTab, { baseURL })
      : setPairInputs((inputs) => ({ ...inputs, [serverTab]: baseURL }))
  const submitOnEnter = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") void submitPair()
  }
  // A key is typed once per connect; the saved one stays in force while the field is blank.
  const clearServerKeys = () =>
    setServerInputs((inputs) =>
      Object.fromEntries(
        Object.entries(inputs).map(([provider, input]) => [provider, { ...input, apiKey: "" }]),
      ),
    )
  const [pairPending, setPairPending] = useState(false)
  const [pairError, setPairError] = useState<string>()
  const [pairModels, setPairModels] = useState<(PairPickerChoice | ServerPickerChoice)[]>()
  const [pairCatalogReload, setPairCatalogReload] = useState(0)

  const [fastError, setFastError] = useState<string>()
  // Hidden, not unmounted, while closed (see AppShell). Closing leaves the tab, so a tab's
  // leave effects such as marking achievements seen still run, and drops open forms; each open
  // lands on the requested tab.
  useEffect(() => {
    setActiveTab(open ? initialTab : "providers")
    if (open) return
    setOpenForm(undefined)
    setHostedOpen(false)
    setPairError(undefined)
    setFastError(undefined)
  }, [open, initialTab])
  const [fastPending, setFastPending] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [open, onClose])

  // Keep hooks unconditional while the initial snapshot is loading.
  useEffect(() => {
    const anyServer = state?.pairConfigured || Object.keys(state?.servers ?? {}).length > 0
    if (activeTab !== "providers" || openForm !== "pair" || !anyServer) return
    let cancelled = false
    void api
      .listModels()
      .then((items) => {
        if (cancelled) return
        setPairModels(
          items.filter(
            (item): item is PairPickerChoice | ServerPickerChoice =>
              item.kind === "model" &&
              (item.provider === "pair" || isServerProvider(item.provider)),
          ),
        )
      })
      .catch(() => {
        if (!cancelled) setPairModels([])
      })
    return () => {
      cancelled = true
    }
  }, [activeTab, openForm, state?.pairConfigured, state?.servers, pairCatalogReload, api])

  if (!state) return null
  const { fastServing } = state
  const fastDisabled = fastPending || !fastServing.available || state.busy || state.working > 0
  const textSizeIndex = TEXT_SIZES.indexOf(state.textSize)

  const toggleForm = (form: "pair" | HostedProvider) => {
    setPairError(undefined)
    if (form === "pair" && openForm !== "pair") {
      setPairInputs({
        ollama: state.pairEndpoints.ollama ?? PAIR_DEFAULT_ENDPOINTS.ollama,
        lmStudio: state.pairEndpoints.lmStudio ?? PAIR_DEFAULT_ENDPOINTS.lmStudio,
      })
      setServerInputs(serverFormInputs(state.runtimePlatform, state.servers))
      setServerTab(
        localServerTabs(state.runtimePlatform).find(([tab]) => connected(tab))?.[0] ?? "ollama",
      )
    }
    setOpenForm(openForm === form ? undefined : form)
  }

  const submitPair = async () => {
    setPairError(undefined)
    setPairPending(true)
    try {
      const result = await api.connectLocalServers({ ...pairInputs, ...serverInputs })
      // The form stays open on success: model selection happens here now. Every successful connect
      // — including reconnects to a changed endpoint — refetches the catalog.
      if (result.ok) {
        setPairCatalogReload((n) => n + 1)
        clearServerKeys()
      } else setPairError(result.reason)
    } finally {
      setPairPending(false)
    }
  }

  return (
    <div className="settingsPage">
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
                {id === "achievements" && activeTab !== id && state?.freshAchievements.length ? (
                  <i className="settingsSidebar-dot" />
                ) : null}
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
            {/* Page-level tabs sit with the title; section-level ones sit with their heading. */}
            <div className="settingsPage-heading">
              <h1 className="settingsPage-title">{t(SETTINGS_TABS[activeTab].label)}</h1>
              {activeTab === "extensions" ? (
                <TabStrip
                  tabs={[
                    ["skills", t("settings.skills"), FileText],
                    ["memory", t("settings.memory"), NotebookPen],
                  ]}
                  selected={extension}
                  onSelect={setExtension}
                />
              ) : null}
            </div>
            {activeTab === "providers" ? (
              <>
                <div className="settingsGroup">
                  <h2 className="settings-section">{t("settings.providers")}</h2>
                  <div className="settingsSurface">
                    <section className="settingsProvider">
                      <button
                        type="button"
                        className="settingsRow settingsRow-expand"
                        aria-expanded={hostedOpen}
                        onClick={() => {
                          // Collapsing the group takes its open key editor with it.
                          if (hostedOpen && openForm !== "pair") setOpenForm(undefined)
                          setHostedOpen(!hostedOpen)
                        }}
                      >
                        <span className="settingsRow-label">{t("settings.hostedInference")}</span>
                        <Icon icon={hostedOpen ? ChevronDown : ChevronRight} size={12} />
                      </button>
                      {hostedOpen ? (
                        <div className="settingsProvider-list">
                          {HOSTED_PROVIDERS.map((provider) => (
                            <HostedProviderRow
                              key={provider}
                              provider={provider}
                              configured={state.hostedConfigured[provider]}
                              teamId={state.primeTeamId}
                              open={openForm === provider}
                              onToggle={() => toggleForm(provider)}
                            />
                          ))}
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
                          <TabStrip
                            tabs={localServerTabs(state.runtimePlatform).map(([tab, name]) => [
                              tab,
                              <>
                                {name}
                                {connected(tab) ? <Icon icon={Check} size={11} /> : null}
                              </>,
                            ])}
                            selected={serverTab}
                            onSelect={(tab) => {
                              setPairError(undefined)
                              setServerTab(tab)
                            }}
                          />
                          <div className="settingsEndpoints">
                            <TextField
                              icon={Globe}
                              aria-label={t("settings.serverAddress")}
                              placeholder={t("settings.serverAddress")}
                              value={address}
                              onChange={(event) => setAddress(event.target.value)}
                              onKeyDown={submitOnEnter}
                              spellCheck={false}
                              autoComplete="off"
                            />
                            {isServerProvider(serverTab) ? (
                              <TextField
                                id={`settings-${serverTab}-key`}
                                type="password"
                                icon={KeyRound}
                                aria-label={t("settings.serverKey")}
                                placeholder={
                                  state.servers[serverTab]?.hasApiKey
                                    ? t("settings.serverKeyHint")
                                    : t("settings.serverKey")
                                }
                                value={serverInputs[serverTab]?.apiKey ?? ""}
                                onChange={(event) =>
                                  setServer(serverTab, { apiKey: event.target.value })
                                }
                                onKeyDown={submitOnEnter}
                                autoComplete="off"
                              />
                            ) : null}
                            {serverTab === "custom" ? (
                              <>
                                <TextField
                                  icon={Box}
                                  aria-label={t("settings.serverModel")}
                                  placeholder={t("settings.serverModel")}
                                  value={serverInputs.custom?.model ?? ""}
                                  onChange={(event) =>
                                    setServer("custom", { model: event.target.value })
                                  }
                                  onKeyDown={submitOnEnter}
                                  spellCheck={false}
                                  autoComplete="off"
                                />
                                <TextField
                                  icon={RulerDimensionLine}
                                  aria-label={t("settings.serverContext")}
                                  placeholder={t("settings.serverContext")}
                                  inputMode="numeric"
                                  value={serverInputs.custom?.contextLength ?? ""}
                                  onChange={(event) =>
                                    setServer("custom", { contextLength: event.target.value })
                                  }
                                  onKeyDown={submitOnEnter}
                                  autoComplete="off"
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
                          {state.pairConfigured || Object.keys(state.servers).length ? (
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
                                      clearServerKeys()
                                    })
                                  }}
                                >
                                  <span className="settingsRow-label">
                                    {item.displayName}
                                    <span className="settingsRow-meta settingsRow-detail">
                                      <ModelDetail item={item} />
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

                <HostedModelsSettings
                  configured={state.hostedConfigured}
                  hiddenModels={state.hiddenModels}
                />
              </>
            ) : null}

            {activeTab === "usage" ? <UsageStats stats={state.stats} /> : null}

            {activeTab === "extensions" ? (
              extension === "skills" ? (
                <SkillsSettings />
              ) : (
                <MemorySettings />
              )
            ) : null}
            {activeTab === "appearance" ? (
              <>
                <div className="settingsRow settingsSurface">
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

                <div className="settingsRow settingsSurface">
                  <label className="settingsRow-label" htmlFor="settings-text-size">
                    {t("settings.textSize")}
                    <span className="settingsRow-meta">{t(TEXT_SIZE_LABELS[state.textSize])}</span>
                  </label>
                  {/* Four snap points from small A to large A, the way macOS sizes text. */}
                  <span className="settingsTextSize">
                    <span className="settingsTextSize-small" aria-hidden>
                      A
                    </span>
                    <input
                      id="settings-text-size"
                      type="range"
                      className="slider"
                      style={
                        {
                          "--slider-fill": `${(textSizeIndex * 100) / (TEXT_SIZES.length - 1)}%`,
                        } as CSSProperties
                      }
                      min={0}
                      max={TEXT_SIZES.length - 1}
                      step={1}
                      list="settings-text-size-ticks"
                      value={textSizeIndex}
                      aria-label={t("settings.textSize")}
                      aria-valuetext={t(TEXT_SIZE_LABELS[state.textSize])}
                      onChange={(event) =>
                        void api.setTextSize(TEXT_SIZES[Number(event.target.value)])
                      }
                    />
                    <datalist id="settings-text-size-ticks">
                      {TEXT_SIZES.map((size, index) => (
                        <option key={size} value={index} />
                      ))}
                    </datalist>
                    <span className="settingsTextSize-large" aria-hidden>
                      A
                    </span>
                  </span>
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

            {activeTab === "achievements" ? <AchievementsTab /> : null}
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
                  <h2 className="settings-section">{t("settings.server")}</h2>
                  <div className="settingsSurface">
                    <ServerSettings remote={state.remote} remoteSaved={state.remoteSaved} />
                  </div>
                  <p className="settingsForm-note settingsGroup-note">{t("settings.remoteNote")}</p>
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

/**
 * One hosted provider as a settings row: its name and connection state, with an Add or Replace
 * key button that opens a single inline key field beneath the row. The main process verifies the
 * key against the provider's catalog and never sends it back; a saved key closes the editor.
 */
function HostedProviderRow({
  provider,
  configured,
  teamId,
  open,
  onToggle,
}: {
  provider: HostedProvider
  configured: boolean
  /** The Prime Intellect team billed for inference (null: personal wallet); its row edits it. */
  teamId: string | null
  open: boolean
  onToggle: () => void
}) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const [apiKey, setApiKey] = useState("")
  const [team, setTeam] = useState(teamId ?? "")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  // A key typed but not saved leaves with the editor.
  useEffect(() => {
    if (!open) setApiKey("")
  }, [open])
  const name = HOSTED_PROVIDER_INFO[provider].name
  const billsTeam = provider === "primeintellect"
  const teamChanged = billsTeam && team.trim() !== (teamId ?? "")
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") void submit()
    if (event.key === "Escape") onToggle()
  }
  const submit = async () => {
    setError(undefined)
    setPending(true)
    try {
      if (teamChanged) await api.setPrimeTeamId(team)
      if (apiKey.trim()) {
        const result = await api.setHostedApiKey(provider, apiKey)
        if (!result.ok) return setError(result.reason)
      }
      setApiKey("")
      onToggle()
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="settingsProvider">
      <div className="settingsRow">
        <span className="settingsRow-label">
          {name}
          <span className="settingsRow-meta settingsRow-detail">
            <span className={configured ? "settingsProvider-connected" : undefined}>
              {configured ? t("settings.providerConnected") : t("settings.providerNotConnected")}
            </span>
            <span aria-hidden>·</span>
            <RetentionBadge retention={HOSTED_PROVIDER_INFO[provider].dataRetention} />
          </span>
        </span>
        <Button size="sm" aria-expanded={open} onClick={onToggle}>
          {open ? t("common.cancel") : configured ? t("settings.replaceKey") : t("settings.addKey")}
        </Button>
      </div>
      {open ? (
        <div className="settingsProvider-editor">
          <TextField
            type="password"
            className="settingsProvider-key"
            icon={KeyRound}
            aria-label={t("settings.hostedKey", { provider: name })}
            placeholder={t("settings.hostedKey", { provider: name })}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
          <Button size="sm" onClick={() => void api.openHostedKeyPage(provider)}>
            {t("settings.getKey")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={pending || !(apiKey.trim() || teamChanged)}
            onClick={() => void submit()}
          >
            {t("common.save")}
          </Button>
          {billsTeam ? (
            <>
              <TextField
                className="settingsProvider-key"
                aria-label={t("settings.primeTeamId")}
                placeholder={t("settings.primeTeamId")}
                value={team}
                onChange={(event) => setTeam(event.target.value)}
                onKeyDown={onKeyDown}
                spellCheck={false}
                autoComplete="off"
              />
              <p className="settingsForm-note settingsProvider-message">
                {t("settings.primeTeamIdNote")}
              </p>
            </>
          ) : null}
          {pending ? (
            <div className="settings-message settingsProvider-message">
              {t("settings.checkingHosted")}
            </div>
          ) : null}
          {error ? (
            <div className="settings-message settings-error settingsProvider-message">{error}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Every keyed hosted provider's catalog, one provider at a time behind a tab strip, with a
 * visibility switch per model. The catalogs load when the tab opens and again when a key is added
 * or removed; the switches follow the status stream, so a toggle lands when the main process has
 * persisted it.
 */
function HostedModelsSettings({
  configured,
  hiddenModels,
}: {
  configured: Record<HostedProvider, boolean>
  hiddenModels: string[]
}) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const [catalogs, setCatalogs] = useState<Partial<Record<HostedProvider, HostedModel[]>>>()
  const [failed, setFailed] = useState(false)
  const [chosen, setChosen] = useState<HostedProvider>()
  const providers = HOSTED_PROVIDERS.filter((provider) => configured[provider])
  const keyed = providers.join(" ")
  // A provider whose key was removed falls back to the first keyed one.
  const provider = chosen && providers.includes(chosen) ? chosen : providers[0]
  useEffect(() => {
    if (!keyed) return
    let cancelled = false
    setCatalogs(undefined)
    setFailed(false)
    void api.listHostedCatalogs().then(
      (result) => {
        if (!cancelled) setCatalogs(result)
      },
      () => {
        if (!cancelled) setFailed(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, keyed])
  if (!provider) return null
  const name = HOSTED_PROVIDER_INFO[provider].name
  const models = catalogs?.[provider] ?? []
  return (
    <div className="settingsGroup">
      <h2 className="settings-section">{t("settings.hostedModels")}</h2>
      <TabStrip
        tabs={providers.map((entry) => [entry, HOSTED_PROVIDER_INFO[entry].name])}
        selected={provider}
        onSelect={setChosen}
      />
      <div className="settingsSurface">
        <section role="tabpanel" aria-label={name}>
          {failed ? (
            <div className="settingsRow settings-message settings-error">
              {t("settings.hostedModelsFailed")}
            </div>
          ) : catalogs === undefined ? (
            <div className="settingsRow settings-message">{t("common.loadingModels")}</div>
          ) : models.length ? (
            models.map((model) => (
              <div className="settingsRow" key={model.id}>
                <span className="settingsRow-label">
                  {model.displayName}
                  <span className="settingsRow-meta settingsRow-detail">
                    <ModelDetail
                      item={{ kind: "model", ...model, available: true, active: false }}
                    />
                  </span>
                </span>
                <Toggle
                  label={t("settings.showModel", { name: model.displayName })}
                  checked={!hiddenModels.includes(hiddenModelKey(provider, model.id))}
                  onChange={(shown) => void api.setModelHidden(provider, model.id, !shown)}
                />
              </div>
            ))
          ) : (
            <div className="settingsRow settings-message">{t("settings.noHostedModels")}</div>
          )}
        </section>
      </div>
      <p className="settingsForm-note settingsGroup-note">{t("settings.hostedModelsNote")}</p>
    </div>
  )
}

/**
 * Where the runtime runs: this machine, or an `otis serve` daemon. The row names the current one;
 * its inline editor pairs with a daemon, like a provider row takes a key. Either change restarts
 * the app.
 */
function ServerSettings({
  remote,
  remoteSaved,
}: {
  remote: string | null
  remoteSaved: string | null
}) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState(remoteSaved ?? "")
  const [token, setToken] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  // The saved token applies while the address is the one it was saved for.
  const tokenSaved = remoteSaved !== null && url.trim() === remoteSaved
  const ready = Boolean(url.trim() && (token.trim() || tokenSaved)) && !pending
  const connect = async () => {
    if (!ready) return
    setPending(true)
    setError(undefined)
    const result = await api.connectRemote(url, token)
    if (!result.ok) {
      setError(result.reason)
      setPending(false)
    }
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") void connect()
    if (event.key === "Escape") setOpen(false)
  }
  return (
    <div className="settingsProvider">
      <div className="settingsRow">
        <span className="settingsRow-label">
          {t("settings.serverRunsOn")}
          <span className={`settingsRow-meta${remote ? " settingsProvider-connected" : ""}`}>
            {remote ?? t("settings.serverThisMachine")}
          </span>
        </span>
        {remote ? (
          <Button size="sm" onClick={() => void api.disconnectRemote()}>
            {t("settings.serverUseThisMachine")}
          </Button>
        ) : (
          <Button size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t("common.cancel") : t("settings.serverConnect")}
          </Button>
        )}
      </div>
      {open && !remote ? (
        <div className="settingsProvider-editor">
          <TextField
            className="settingsProvider-key"
            icon={Globe}
            aria-label={t("settings.remoteUrl")}
            placeholder={t("settings.remoteUrlPlaceholder")}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
          <TextField
            type="password"
            className="settingsProvider-key"
            icon={KeyRound}
            aria-label={t("settings.remoteToken")}
            placeholder={t(tokenSaved ? "settings.remoteTokenHint" : "settings.remoteToken")}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={onKeyDown}
            autoComplete="off"
          />
          <Button variant="primary" size="sm" disabled={!ready} onClick={() => void connect()}>
            {pending ? t("common.checking") : t("common.connect")}
          </Button>
          {error ? (
            <div className="settings-message settings-error settingsProvider-message">{error}</div>
          ) : null}
        </div>
      ) : null}
    </div>
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
  const [allModels, setAllModels] = useState(false)

  if (!stats) {
    return (
      <section className="settingsSurface settingsUsage settingsUsage-loading" aria-busy="true">
        {t("settings.usageLoading")}
      </section>
    )
  }

  const recentActivity = stats.recentActivity
  const maxDailyTokens = Math.max(1, ...recentActivity.map((day) => day.tokens))
  const number = new Intl.NumberFormat(locale)
  const firstDay = recentActivity[0]
  const lastDay = recentActivity.at(-1)
  const activeDay = recentActivity.find((day) => day.date === activeDate)
  const countedTokens = stats.promptTokens + stats.completionTokens
  const share = (tokens: number) => (countedTokens === 0 ? 0 : tokens / countedTokens)
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 })
  const breakdown = usageBreakdown(stats, t, locale)
  // Each bar is relative to the leader.
  const models = Object.entries(stats.modelUsage)
    .map(([name, usage]) => ({
      name,
      ...usage,
      total: usage.promptTokens + usage.completionTokens,
    }))
    .sort((a, b) => b.total - a.total)

  return (
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
          <span className="settingsUsage-mixTitle">
            {t("settings.usageTokenMix")}
            {breakdown.hitRate ? (
              <span className="settingsUsage-cacheHit">{breakdown.hitRate}</span>
            ) : null}
          </span>
          {/* One segment per legend row, in legend order, each as wide as its share. */}
          <div
            className="settingsUsage-mixTrack"
            data-empty={countedTokens === 0 ? "true" : undefined}
            aria-hidden="true"
          >
            {breakdown.rows
              .filter((row) => row.tokens > 0)
              .map((row) => (
                <i
                  key={row.id}
                  className={`settingsUsage-mixSegment settingsUsage-mix-${row.id}`}
                  style={{ flexGrow: share(row.tokens) }}
                />
              ))}
          </div>
          <div className="settingsUsage-mixValues">
            {breakdown.rows.map((row) => (
              <span key={row.id}>
                <i className={`settingsUsage-mixDot settingsUsage-mix-${row.id}`} />
                {row.label}
                <strong>{formatTokenCount(row.tokens)}</strong>
                <small>{percent.format(share(row.tokens))}</small>
              </span>
            ))}
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
        <UsageMetric label={t("settings.usageToday")} value={formatTokenCount(stats.todayTokens)} />
      </div>

      {models.length ? (
        <div className="settingsUsage-models">
          <div className="settingsUsage-activityHeader">
            <span>{t("settings.usageByModel")}</span>
          </div>
          {models
            .slice(0, allModels ? undefined : MODELS_SHOWN)
            .map(
              ({
                name,
                hosted,
                promptTokens,
                completionTokens,
                cachedPromptTokens,
                total,
                cacheReportedPromptTokens,
              }) => (
                <div
                  key={name}
                  className="settingsUsage-model"
                  style={
                    { "--usage-share": `${(total / models[0].total) * 100}%` } as CSSProperties
                  }
                >
                  <span className="settingsUsage-modelName" title={name}>
                    {name}
                  </span>
                  <span
                    className="settingsUsage-modelWhere"
                    title={t(hosted ? "common.hosted" : "common.local")}
                  >
                    <Icon icon={hosted ? Cloud : Laptop} size={13} />
                  </span>
                  <span className="settingsUsage-modelSplit">
                    {cacheReportedPromptTokens > 0
                      ? t("settings.usageModelSplitCached", {
                          input: formatTokenCount(promptTokens),
                          cached: formatTokenCount(cachedPromptTokens),
                          output: formatTokenCount(completionTokens),
                        })
                      : t("settings.usageModelSplit", {
                          input: formatTokenCount(promptTokens),
                          output: formatTokenCount(completionTokens),
                        })}
                  </span>
                  <strong title={number.format(total)}>{formatTokenCount(total)}</strong>
                  <i className="settingsUsage-modelBar" aria-hidden="true" />
                </div>
              ),
            )}
          {models.length > MODELS_SHOWN && !allModels ? (
            <Button
              variant="ghost"
              size="sm"
              className="settingsUsage-more"
              onClick={() => setAllModels(true)}
            >
              {t("settings.skillsMore")}
            </Button>
          ) : null}
        </div>
      ) : null}

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

/** Month and day, with the year once it is not this one. */
function formatShortDate(date: string, locale: string) {
  const day = localDate(date)
  const year = day.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" as const }
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...year }).format(day)
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
  const [url, setUrl] = useState("")
  const [limit, setLimit] = useState(SKILLS_PAGE)
  const { value: summary, pending, error, change } = useSettingsList(listSkills)
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
                  size="sm"
                  disabled={pending}
                  onClick={() => void change(() => api.updateSkills(source.id))}
                >
                  {t("settings.skillUpdate")}
                </Button>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => void change(() => api.removeSkills(source.id))}
                >
                  {t("settings.skillRemove")}
                </Button>
              </span>
            </div>
          ))}
          <div className="settingsForm settingsSurface-form">
            <label className="settingsForm-label" htmlFor="settings-skill-url">
              {t("settings.skillUrl")}
            </label>
            <TextField
              id="settings-skill-url"
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
                <span className="settingsRow-meta settingsRow-truncate" title={skill.description}>
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
        <p className="settingsForm-note settingsGroup-note">{t("settings.skillsNote")}</p>
      </div>
    </>
  )
}

const listMemory = (api: DesktopApi) => api.listMemory()
const listSkills = (api: DesktopApi) => api.listSkills()

/**
 * A settings list read from the API and reread after each change: the change runs alone, its
 * failure shows as the reason, and success rereads the list.
 */
function useSettingsList<T>(list: (api: DesktopApi) => Promise<T>) {
  const { api } = useDesktop()
  const [value, setValue] = useState<T>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    void list(api).then(setValue)
  }, [api, list])
  const change = async (operation: () => Promise<SessionOpResult>) => {
    setPending(true)
    setError(undefined)
    const result = await operation()
    setPending(false)
    if (result.ok) setValue(await list(api))
    else setError(result.reason)
    return result.ok
  }
  return { value, pending, error, change }
}

/** What Otis remembers, in file order; added for this workspace, forgotten one by one. */
function MemorySettings() {
  const { api } = useDesktop()
  const { locale, t } = useI18n()
  const [fact, setFact] = useState("")
  const { value: entries, pending, error, change } = useSettingsList(listMemory)
  const rememberFact = async () => {
    const text = fact.trim()
    if (text && (await change(() => api.rememberFact("workspace", text)))) setFact("")
  }
  return (
    <div className="settingsGroup">
      <h2 className="settings-section">{t("settings.memory")}</h2>
      <div className="settingsSurface">
        {entries?.length === 0 ? (
          <div className="settingsRow settings-message">{t("settings.memoryEmpty")}</div>
        ) : null}
        {entries?.map((entry, index) => (
          <div className="settingsRow" key={index}>
            <span className="settingsRow-label">
              <span className="settingsRow-truncate" title={entry.text}>
                {entry.text}
              </span>
              <span className="settingsRow-meta">
                {t(entry.scope === "global" ? "settings.memoryGlobal" : "settings.memoryWorkspace")}
                {` · ${entry.topic}`}
                {entry.date ? ` · ${formatShortDate(entry.date, locale)}` : ""}
              </span>
            </span>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => void change(() => api.forgetFact(entry.scope, entry.text))}
            >
              {t("settings.memoryForget")}
            </Button>
          </div>
        ))}
        <div className="settingsForm settingsSurface-form">
          <label className="settingsForm-label" htmlFor="settings-memory-fact">
            {t("settings.memoryFact")}
          </label>
          <TextField
            id="settings-memory-fact"
            value={fact}
            onChange={(event) => setFact(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void rememberFact()
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="settingsForm-actions">
            <Button
              variant="primary"
              size="sm"
              disabled={pending || !fact.trim()}
              onClick={rememberFact}
            >
              {t("settings.memoryRemember")}
            </Button>
          </div>
          {error ? <div className="settings-message settings-error">{error}</div> : null}
        </div>
      </div>
      <p className="settingsForm-note settingsGroup-note">{t("settings.memoryNote")}</p>
    </div>
  )
}
