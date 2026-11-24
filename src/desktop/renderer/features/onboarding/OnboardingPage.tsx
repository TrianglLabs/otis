import {
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  ChevronRight,
  Cloud,
  Cpu,
  Globe,
  KeyRound,
  Laptop,
  Loader2,
  Plug,
  RulerDimensionLine,
  Search,
  Settings,
  Star,
  X,
} from "lucide-react"
import { Fragment, type KeyboardEvent, useCallback, useEffect, useState } from "react"
import type { ServerInput } from "../../../../app/local-servers.js"
import type { ModelPickerChoice, ModelPickerItem } from "../../../../inference/picker-catalog.js"
import {
  filterModelPickerItems,
  groupByVendor,
  pickerItemKey,
} from "../../../../inference/picker-filter.js"
import {
  HOSTED_PROVIDER_INFO,
  HOSTED_PROVIDERS,
  type HostedProvider,
  isServerProvider,
  type LocalServerTab,
  localServerNames,
  localServerTabs,
  type ServerProvider,
  serverFormInputs,
} from "../../../../inference/types.js"
import { Button, IconButton } from "../../components/Button.js"
import { Icon, ProviderMark, RetentionBadge, VendorMark } from "../../components/Icon.js"
import { OtisMark } from "../../components/OtisMark.js"
import { ProgressBar, ProgressStop } from "../../components/Progress.js"
import { TextField } from "../../components/TextField.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import {
  isPickerRowSelectable,
  localModelFacts,
  mergeModelLoad,
  pickerDetailLabel,
} from "../models/model-list.js"

const LOCAL_SERVER_DEFAULTS = {
  ollama: "http://127.0.0.1:11434",
  lmStudio: "http://127.0.0.1:1234",
}

type OnboardingPath = "welcome" | "cloud" | "local" | "managed" | "server" | "serverModels"
type OnboardingDirection = "forward" | "back"

/**
 * First-run onboarding, rendered in place of the conversation until a model is configured. Hosted
 * inference takes one hosted provider's key (Fireworks by default); local inference can either be
 * managed by Otis or connect to an existing Ollama, oMLX, LM Studio, or NVIDIA PAIR endpoint. A
 * successful selection sets `model` and the shell swaps this page for the workspace.
 */
export function OnboardingPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { api } = useDesktop()
  const { locale, t } = useI18n()
  const state = useDesktopState(
    "hostedConfigured",
    "modelLoad",
    "pairConfigured",
    "pairEndpoints",
    "servers",
    "runtimePlatform",
  )
  const servers = localServerNames(state?.runtimePlatform)
  const serverList = new Intl.ListFormat(locale, { type: "disjunction" })
  const [path, setPath] = useState<OnboardingPath>("welcome")
  const [direction, setDirection] = useState<OnboardingDirection>("forward")
  const [hostedProvider, setHostedProvider] = useState<HostedProvider>(HOSTED_PROVIDERS[0])
  const [apiKey, setApiKey] = useState("")
  const [teamId, setTeamId] = useState("")
  const [modelQuery, setModelQuery] = useState("")
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
  const connectOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") void connectServer()
  }
  const [serverPending, setServerPending] = useState(false)
  const [items, setItems] = useState<ModelPickerItem[]>()
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    try {
      const catalog = await api.listModels()
      setItems(catalog)
      return catalog
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    }
  }, [api])

  const hostedConfigured = state?.hostedConfigured[hostedProvider] === true
  const hostedName = HOSTED_PROVIDER_INFO[hostedProvider].name
  const billsTeam = hostedProvider === "primeintellect"
  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && apiKey.trim()) void saveHostedKey()
  }

  const pairConfigured =
    state?.pairConfigured === true || Object.keys(state?.servers ?? {}).length > 0

  useEffect(() => {
    if (
      path === "managed" ||
      (path === "cloud" && hostedConfigured) ||
      (path === "serverModels" && pairConfigured)
    ) {
      void load()
    }
  }, [path, hostedConfigured, pairConfigured, load])

  const modelLoad = state?.modelLoad ?? null
  const rowProvider =
    path === "cloud"
      ? hostedProvider
      : path === "managed"
        ? "local"
        : path === "serverModels"
          ? "pair"
          : null
  const rows = mergeModelLoad(items ?? [], modelLoad).filter(
    (item): item is ModelPickerChoice =>
      item.kind === "model" &&
      rowProvider !== null &&
      (item.provider === rowProvider ||
        (rowProvider === "pair" && isServerProvider(item.provider))),
  )

  // The local step shows the single best model for this computer: the recommended row when it fits,
  // else the first row that does.
  const pick =
    rows.find((item) => "recommended" in item && item.recommended && isPickerRowSelectable(item)) ??
    rows.find(isPickerRowSelectable)
  // Rows that are all unavailable for one identical reason hit a platform limit, not a memory fit.
  const reasons = new Set(
    rows.map((item) =>
      item.available || !("availabilityLabel" in item) ? undefined : item.availabilityLabel,
    ),
  )
  const platformLimit = reasons.size === 1 ? [...reasons][0] : undefined
  const pickStatus = pick && "status" in pick ? pick.status : undefined
  const pickLoading = pickStatus?.kind === "progress"
  const pickError = error ?? (pickStatus?.kind === "error" ? pickStatus.label : undefined)

  async function select(item: ModelPickerChoice) {
    setError(undefined)
    try {
      const result = await api.selectModel(pickerItemKey(item))
      if (
        !result.ok &&
        result.reason !== "The selection was cancelled." &&
        result.reason !== "The selection was superseded."
      ) {
        setError(result.reason)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  // A Prime Intellect team is billed from the first request, so it lands before the key.
  async function saveHostedKey() {
    setError(undefined)
    if (billsTeam && teamId.trim()) await api.setPrimeTeamId(teamId)
    const result = await api.setHostedApiKey(hostedProvider, apiKey.trim())
    if (!result.ok) setError(result.reason)
  }

  async function connectServer() {
    setError(undefined)
    setServerPending(true)
    try {
      const result = await api.connectLocalServers({ ...pairInputs, ...serverInputs })
      if (!result.ok) {
        setError(result.reason)
        return
      }
      setServerInputs((inputs) =>
        Object.fromEntries(
          Object.entries(inputs).map(([provider, input]) => [provider, { ...input, apiKey: "" }]),
        ),
      )
      const catalog = await load()
      if (!catalog) return
      if (
        !catalog.some(
          (item) =>
            item.kind === "model" && (item.provider === "pair" || isServerProvider(item.provider)),
        )
      ) {
        setError(t("onboarding.connectedNoModels"))
        return
      }
      navigate("serverModels", "forward")
    } finally {
      setServerPending(false)
    }
  }

  function navigate(next: OnboardingPath, nextDirection: OnboardingDirection) {
    setDirection(nextDirection)
    setPath(next)
  }

  if (path === "welcome") {
    return (
      <main className="onboarding">
        <div className="onboarding-topbar">
          <span />
          <IconButton
            icon={Settings}
            label={t("common.settings")}
            size={26}
            className="noDrag"
            onClick={onOpenSettings}
          />
        </div>
        <div
          key={path}
          className={`onboarding-welcome onboarding-step onboarding-step-${direction}`}
        >
          <div className="onboarding-brand">
            <OtisMark className="onboarding-logo" />
            <h1 className="onboarding-title">{t("onboarding.welcome")}</h1>
            <p className="onboarding-sub">{t("onboarding.tagline")}</p>
          </div>
          <div className="onboarding-choices">
            <button
              type="button"
              className="onboarding-choice"
              onClick={() => {
                // A provider that already has a key opens on its models; otherwise OpenRouter.
                setHostedProvider(
                  HOSTED_PROVIDERS.find((provider) => state?.hostedConfigured[provider]) ??
                    HOSTED_PROVIDERS[0],
                )
                navigate("cloud", "forward")
              }}
            >
              <span className="onboarding-choiceMark" aria-hidden>
                <Icon icon={Cloud} size={20} className="onboarding-choiceIcon" />
              </span>
              <span className="onboarding-choiceText">
                <span className="onboarding-choiceTitle">{t("common.hosted")}</span>
                <span className="onboarding-choiceBody">{t("onboarding.hostedBody")}</span>
              </span>
              <Icon icon={ChevronRight} size={16} className="onboarding-choiceChevron" />
            </button>
            <button
              type="button"
              className="onboarding-choice"
              onClick={() => navigate("local", "forward")}
            >
              <span className="onboarding-choiceMark" aria-hidden>
                <Icon icon={Laptop} size={20} className="onboarding-choiceIcon" />
              </span>
              <span className="onboarding-choiceText">
                <span className="onboarding-choiceTitle">{t("common.local")}</span>
                <span className="onboarding-choiceBody">{t("onboarding.localBody")}</span>
              </span>
              <Icon icon={ChevronRight} size={16} className="onboarding-choiceChevron" />
            </button>
          </div>
        </div>
      </main>
    )
  }

  // A user-managed server adds its connection screen before the model list.
  const stepIndex = {
    cloud: hostedConfigured ? 2 : 1,
    local: 1,
    managed: 2,
    server: 2,
    serverModels: 3,
  }[path]
  const stepCount = path === "server" || path === "serverModels" ? 4 : 3
  const matches = filterModelPickerItems(rows, modelQuery)
  return (
    <main className="onboarding">
      <div className="onboarding-topbar">
        <Button
          variant="ghost"
          size="sm"
          className="noDrag"
          onClick={() => {
            setError(undefined)
            if (path === "serverModels") navigate("server", "back")
            else navigate(path === "managed" || path === "server" ? "local" : "welcome", "back")
          }}
        >
          <Icon icon={ArrowLeft} size={13} />
          {t("onboarding.back")}
        </Button>
        <div
          className="onboarding-steps"
          role="img"
          aria-label={t("onboarding.step", { current: stepIndex + 1, total: stepCount })}
        >
          {Array.from({ length: stepCount }, (_, step) => (
            <span
              key={step}
              className={`onboarding-stepDot${step === stepIndex ? " onboarding-stepDot-current" : ""}${
                step < stepIndex ? " onboarding-stepDot-done" : ""
              }`}
            />
          ))}
        </div>
        <IconButton
          icon={Settings}
          label={t("common.settings")}
          size={26}
          className="noDrag"
          onClick={onOpenSettings}
        />
      </div>
      <div key={path} className={`onboarding-panel onboarding-step onboarding-step-${direction}`}>
        {path === "cloud" ? (
          <div className="onboarding-stepHeader">
            <p className="onboarding-panelTitle">{t("onboarding.setupHosted")}</p>
            <p className="onboarding-hint">
              {t("onboarding.hostedHintBefore", { provider: hostedName })}
            </p>
          </div>
        ) : null}

        {path === "local" ? (
          <>
            <div className="onboarding-stepHeader">
              <p className="onboarding-panelTitle">{t("onboarding.chooseLocal")}</p>
              <p className="onboarding-hint">{t("onboarding.localHint")}</p>
            </div>
            <div className="onboarding-choices">
              <button
                type="button"
                className="onboarding-choice"
                onClick={() => navigate("managed", "forward")}
              >
                <span className="onboarding-choiceMark" aria-hidden>
                  <OtisMark className="onboarding-choiceOtisMark" decorative />
                </span>
                <span className="onboarding-choiceText">
                  <span className="onboarding-choiceTitle">{t("onboarding.managed")}</span>
                  <span className="onboarding-choiceBody">{t("onboarding.managedBody")}</span>
                </span>
                <Icon icon={ChevronRight} size={16} className="onboarding-choiceChevron" />
              </button>
              <button
                type="button"
                className="onboarding-choice"
                onClick={() => {
                  setPairInputs({
                    ollama: state?.pairEndpoints.ollama ?? LOCAL_SERVER_DEFAULTS.ollama,
                    lmStudio: state?.pairEndpoints.lmStudio ?? LOCAL_SERVER_DEFAULTS.lmStudio,
                  })
                  setServerInputs(serverFormInputs(state?.runtimePlatform, state?.servers ?? {}))
                  setServerTab(
                    localServerTabs(state?.runtimePlatform).find(([tab]) => connected(tab))?.[0] ??
                      "ollama",
                  )
                  setError(undefined)
                  navigate("server", "forward")
                }}
              >
                <span className="onboarding-providerMarks" aria-hidden>
                  {localServerTabs(state?.runtimePlatform).map(([tab]) => (
                    <ProviderMark key={tab} provider={tab} className="onboarding-providerMark" />
                  ))}
                </span>
                <span className="onboarding-choiceText">
                  <span className="onboarding-choiceTitle">{t("onboarding.server")}</span>
                  <span className="onboarding-choiceBody">
                    {t("onboarding.serverBody", {
                      servers: serverList.format([...servers, "NVIDIA PAIR"]),
                    })}
                  </span>
                </span>
                <Icon icon={ChevronRight} size={16} className="onboarding-choiceChevron" />
              </button>
            </div>
          </>
        ) : null}

        {path === "cloud" && !hostedConfigured ? (
          <>
            <div className="onboarding-form">
              <fieldset className="onboarding-providers">
                <legend className="onboarding-providersLegend">
                  {t("onboarding.chooseProvider")}
                </legend>
                <ProviderGrid
                  choices={HOSTED_PROVIDERS.map((provider) => [
                    provider,
                    HOSTED_PROVIDER_INFO[provider].name,
                  ])}
                  selected={hostedProvider}
                  connected={(provider) => state?.hostedConfigured[provider] === true}
                  onSelect={(provider) => {
                    setError(undefined)
                    setApiKey("")
                    setModelQuery("")
                    setHostedProvider(provider)
                  }}
                />
              </fieldset>
              <div className="onboarding-formBody">
                <div className="onboarding-field">
                  <span className="onboarding-fieldLabel">
                    {t("onboarding.hostedKey", { provider: hostedName })}
                  </span>
                  <TextField
                    icon={KeyRound}
                    type="password"
                    placeholder={t("onboarding.pasteKey")}
                    aria-label={t("onboarding.hostedKey", { provider: hostedName })}
                    value={apiKey}
                    autoComplete="off"
                    onChange={(event) => setApiKey(event.target.value)}
                    onKeyDown={submitOnEnter}
                  />
                </div>
                {billsTeam ? (
                  <div className="onboarding-field">
                    <span className="onboarding-fieldLabel">{t("settings.primeTeamId")}</span>
                    <TextField
                      aria-label={t("settings.primeTeamId")}
                      title={t("settings.primeTeamIdNote")}
                      value={teamId}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setTeamId(event.target.value)}
                      onKeyDown={submitOnEnter}
                    />
                  </div>
                ) : null}
                <p className="onboarding-formNote">
                  <RetentionBadge retention={HOSTED_PROVIDER_INFO[hostedProvider].dataRetention} />
                  <span aria-hidden>·</span>
                  <button
                    type="button"
                    className="onboarding-link"
                    onClick={() => void api.openHostedKeyPage(hostedProvider)}
                  >
                    {t("onboarding.getKey")}
                  </button>
                </p>
              </div>
            </div>
            <div className="onboarding-actions">
              <Button
                variant="primary"
                size="lg"
                disabled={!apiKey.trim()}
                onClick={() => void saveHostedKey()}
              >
                {t("common.continue")}
                <Icon icon={ArrowRight} size={14} />
              </Button>
            </div>
          </>
        ) : null}

        {path === "cloud" && hostedConfigured ? (
          <p className="onboarding-hint">{t("onboarding.keySaved")}</p>
        ) : null}

        {path === "managed" ? (
          <div className="onboarding-local">
            {!pick ? (
              error ? (
                <p className="onboarding-error">{error}</p>
              ) : (
                <p className="onboarding-hint">
                  {items
                    ? (platformLimit ?? t("onboarding.noLocalFit"))
                    : t("common.loadingModels")}
                </p>
              )
            ) : (
              <>
                <p className="onboarding-hint">{t("onboarding.bestModel")}</p>
                <div className="onboarding-localPick">
                  <span className="onboarding-rowName">
                    {pick.displayName}
                    {"cpuOffload" in pick && pick.cpuOffload ? (
                      <span className="onboarding-cpuOffload" title={t("models.partlyOnCpu")}>
                        <Icon icon={Cpu} size={11} />
                      </span>
                    ) : null}
                  </span>
                  {pickLoading || pick.provider !== "local" ? (
                    <>
                      <span className="onboarding-rowDetail">
                        {pickLoading ? pickStatus.label : pickerDetailLabel(pick, t)}
                      </span>
                      {pickLoading && pickStatus.percent !== undefined ? (
                        <ProgressBar
                          percent={pickStatus.percent}
                          label={pickStatus.label}
                          className="onboarding-pickProgress"
                        />
                      ) : null}
                    </>
                  ) : (
                    <dl className="onboarding-specs">
                      {localModelFacts(pick, t, locale).map((fact) => (
                        <div key={fact.term} className="onboarding-spec">
                          <div className="onboarding-specText">
                            <dt className="onboarding-specTerm">{fact.term}</dt>
                            {fact.hint ? (
                              <dd className="onboarding-specHint">{fact.hint}</dd>
                            ) : null}
                          </div>
                          <dd className="onboarding-specValue">{fact.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
                <div className="onboarding-actions">
                  <Button
                    variant="primary"
                    size="lg"
                    disabled={pickLoading}
                    onClick={() => void select(pick)}
                  >
                    {"downloaded" in pick && pick.downloaded
                      ? t("common.continue")
                      : t("onboarding.downloadContinue")}
                    {pickLoading ? (
                      <Icon icon={Loader2} size={14} className="spin" />
                    ) : (
                      <Icon icon={ArrowRight} size={14} />
                    )}
                  </Button>
                  {pickLoading ? (
                    <IconButton
                      icon={X}
                      label={t("common.cancelModelLoad")}
                      size={22}
                      onClick={() => void api.cancelModelSelection()}
                    />
                  ) : null}
                </div>
                {pickError ? <p className="onboarding-error">{pickError}</p> : null}
              </>
            )}
          </div>
        ) : null}

        {path === "server" ? (
          <>
            <div className="onboarding-stepHeader">
              <p className="onboarding-panelTitle">{t("onboarding.connectServer")}</p>
              <p className="onboarding-hint">{t("onboarding.connectServerHint")}</p>
            </div>
            <div className="onboarding-form">
              <fieldset className="onboarding-providers">
                <legend className="onboarding-providersLegend">
                  {t("onboarding.chooseServer")}
                </legend>
                <ProviderGrid
                  choices={localServerTabs(state?.runtimePlatform)}
                  selected={serverTab}
                  connected={connected}
                  onSelect={(tab) => {
                    setError(undefined)
                    setServerTab(tab)
                  }}
                />
              </fieldset>
              <div className="onboarding-formBody">
                <div className="onboarding-field">
                  <span className="onboarding-fieldLabel">{t("settings.serverAddress")}</span>
                  <TextField
                    icon={Globe}
                    aria-label={t("settings.serverAddress")}
                    placeholder={t("settings.serverAddress")}
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    onKeyDown={connectOnEnter}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
                {isServerProvider(serverTab) ? (
                  <div className="onboarding-field">
                    <span className="onboarding-fieldLabel">{t("settings.serverKey")}</span>
                    <TextField
                      icon={KeyRound}
                      id={`onboarding-${serverTab}-key`}
                      type="password"
                      aria-label={t("settings.serverKey")}
                      placeholder={
                        state?.servers[serverTab]?.hasApiKey
                          ? t("settings.serverKeyHint")
                          : undefined
                      }
                      value={serverInputs[serverTab]?.apiKey ?? ""}
                      onChange={(event) => setServer(serverTab, { apiKey: event.target.value })}
                      onKeyDown={connectOnEnter}
                      autoComplete="off"
                    />
                  </div>
                ) : null}
                {serverTab === "custom" ? (
                  <>
                    <div className="onboarding-field">
                      <span className="onboarding-fieldLabel">{t("settings.serverModel")}</span>
                      <TextField
                        icon={Box}
                        aria-label={t("settings.serverModel")}
                        value={serverInputs.custom?.model ?? ""}
                        onChange={(event) => setServer("custom", { model: event.target.value })}
                        onKeyDown={connectOnEnter}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </div>
                    <div className="onboarding-field">
                      <span className="onboarding-fieldLabel">{t("settings.serverContext")}</span>
                      <TextField
                        icon={RulerDimensionLine}
                        aria-label={t("settings.serverContext")}
                        inputMode="numeric"
                        value={serverInputs.custom?.contextLength ?? ""}
                        onChange={(event) =>
                          setServer("custom", { contextLength: event.target.value })
                        }
                        onKeyDown={connectOnEnter}
                        autoComplete="off"
                      />
                    </div>
                  </>
                ) : null}
                <p className="onboarding-formNote">{t("onboarding.connectServerNote")}</p>
              </div>
            </div>
            <div className="onboarding-actions">
              <Button
                variant="primary"
                size="lg"
                icon={Plug}
                busy={serverPending}
                onClick={() => void connectServer()}
              >
                {t("common.connect")}
              </Button>
            </div>
          </>
        ) : null}

        {path === "serverModels" ? (
          <>
            <div className="onboarding-stepHeader">
              <p className="onboarding-panelTitle">{t("onboarding.chooseModel")}</p>
              <p className="onboarding-hint">{t("onboarding.chooseServerModel")}</p>
            </div>
            <div className="onboarding-list onboarding-serverModels">
              {rows.map((item) => (
                <div key={pickerItemKey(item)} className="onboarding-row">
                  <button
                    type="button"
                    className="onboarding-rowSelect"
                    disabled={!isPickerRowSelectable(item)}
                    onClick={() => void select(item)}
                  >
                    <span className="onboarding-rowName">{item.displayName}</span>
                    <span className="onboarding-rowDetail">{pickerDetailLabel(item, t)}</span>
                  </button>
                </div>
              ))}
              {!items && !error ? (
                <p className="onboarding-hint">{t("common.loadingModels")}</p>
              ) : null}
            </div>
          </>
        ) : null}

        {path === "cloud" && hostedConfigured ? (
          <>
            <TextField
              icon={Search}
              aria-label={t("models.searchPlaceholder")}
              placeholder={t("models.searchPlaceholder")}
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="onboarding-list">
              {groupByVendor(matches).map(({ vendor, rows: group }, _, groups) => (
                <Fragment key={vendor?.name ?? ""}>
                  {vendor || groups.length > 1 ? (
                    <p className="onboarding-group">
                      {vendor ? <VendorMark vendor={vendor} label={vendor.name} /> : null}
                      {vendor?.name ?? t("models.otherVendor")}
                    </p>
                  ) : null}
                  {group.map((item) => {
                    const status = "status" in item ? item.status : undefined
                    const loading = status?.kind === "progress"
                    return (
                      <div key={pickerItemKey(item)} className="onboarding-row">
                        <button
                          type="button"
                          className="onboarding-rowSelect"
                          disabled={!isPickerRowSelectable(item) || loading}
                          onClick={() => void select(item)}
                        >
                          <span className="onboarding-rowName">
                            {item.displayName}
                            {"recommended" in item && item.recommended ? (
                              <span
                                className="onboarding-recommended"
                                title={t("common.recommended")}
                              >
                                <Icon icon={Star} size={11} />
                              </span>
                            ) : null}
                            {"cpuOffload" in item && item.cpuOffload ? (
                              <span
                                className="onboarding-cpuOffload"
                                title={t("models.partlyOnCpu")}
                              >
                                <Icon icon={Cpu} size={11} />
                              </span>
                            ) : null}
                          </span>
                          <span
                            className={`onboarding-rowDetail${status?.kind === "error" ? " error" : ""}`}
                          >
                            {status?.label ?? pickerDetailLabel(item, t)}
                          </span>
                        </button>
                        {loading ? (
                          <ProgressStop
                            percent={status.percent}
                            label={t("common.cancelModelLoad")}
                            className="onboarding-cancel"
                            onClick={() => void api.cancelModelSelection()}
                          />
                        ) : null}
                      </div>
                    )
                  })}
                </Fragment>
              ))}
              {items && rows.length > 0 && matches.length === 0 ? (
                <p className="onboarding-hint">{t("models.noMatches")}</p>
              ) : null}
              {!items && !error ? (
                <p className="onboarding-hint">{t("common.loadingModels")}</p>
              ) : null}
            </div>
          </>
        ) : null}

        {path !== "managed" && error ? <p className="onboarding-error">{error}</p> : null}
      </div>
    </main>
  )
}

/**
 * Providers or servers as tiles with their logos, the chosen one raised: three across, or two
 * across for four so no tile sits alone. Connected ones carry a check.
 */
function ProviderGrid<T extends HostedProvider | LocalServerTab>({
  choices,
  selected,
  connected,
  onSelect,
}: {
  choices: readonly (readonly [T, string])[]
  selected: T
  connected: (choice: T) => boolean
  onSelect: (choice: T) => void
}) {
  return (
    <div
      className="onboarding-providerGrid"
      style={{ gridTemplateColumns: `repeat(${choices.length === 4 ? 2 : 3}, minmax(0, 1fr))` }}
    >
      {choices.map(([choice, name]) => (
        <button
          key={choice}
          type="button"
          aria-pressed={choice === selected}
          className="onboarding-providerTile"
          onClick={() => onSelect(choice)}
        >
          <ProviderMark provider={choice} className="onboarding-providerMark" />
          <span className="onboarding-providerName">{name}</span>
          {connected(choice) ? (
            <Icon icon={Check} size={12} className="onboarding-providerCheck" />
          ) : null}
        </button>
      ))}
    </div>
  )
}
