import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Cloud,
  Cpu,
  HardDrive,
  KeyRound,
  Loader2,
  Plug,
  Settings,
  Star,
  X,
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import type { ModelPickerChoice, ModelPickerItem } from "../../../../inference/picker-catalog.js"
import { localServerNames, supportsOmlx } from "../../../../inference/types.js"
import lmStudioIcon from "../../assets/lm-studio.svg"
import ollamaIcon from "../../assets/ollama.svg"
import omlxIcon from "../../assets/omlx.svg"
import { Button, IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { OtisMark } from "../../components/OtisMark.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import {
  isPickerRowSelectable,
  mergeModelLoad,
  pickerDetailLabel,
  pickerItemKey,
} from "../models/model-list.js"

const LOCAL_SERVER_DEFAULTS = {
  ollama: "http://127.0.0.1:11434",
  lmStudio: "http://127.0.0.1:1234",
}

type OnboardingPath = "welcome" | "cloud" | "local" | "managed" | "server" | "serverModels"
type OnboardingDirection = "forward" | "back"

/**
 * First-run onboarding, rendered in place of the conversation until a model is configured. Hosted
 * inference uses Fireworks; local inference can either be managed by Otis or connect to an existing
 * Ollama, oMLX, LM Studio, or NVIDIA PAIR endpoint. A successful selection sets `model` and the
 * shell swaps this page for the workspace.
 */
export function OnboardingPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { api } = useDesktop()
  const { locale, t } = useI18n()
  const state = useDesktopState(
    "hostedConfigured",
    "modelLoad",
    "pairConfigured",
    "pairEndpoints",
    "omlx",
    "platform",
  )
  const showOmlx = supportsOmlx(state?.platform)
  const servers = localServerNames(state?.platform)
  const serverList = new Intl.ListFormat(locale, { type: "disjunction" })
  const [path, setPath] = useState<OnboardingPath>("welcome")
  const [direction, setDirection] = useState<OnboardingDirection>("forward")
  const [apiKey, setApiKey] = useState("")
  const [ollama, setOllama] = useState("")
  const [lmStudio, setLmStudio] = useState("")
  const [omlx, setOmlx] = useState("")
  const [omlxApiKey, setOmlxApiKey] = useState("")
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

  const hostedConfigured = state?.hostedConfigured === true

  const pairConfigured = state?.pairConfigured === true || Boolean(state?.omlx)

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
      ? "fireworks"
      : path === "managed"
        ? "local"
        : path === "serverModels"
          ? "pair"
          : null
  const rows = mergeModelLoad(items ?? [], modelLoad).filter(
    (item): item is ModelPickerChoice =>
      item.kind === "model" &&
      rowProvider !== null &&
      (item.provider === rowProvider || (rowProvider === "pair" && item.provider === "omlx")),
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

  async function connectServer() {
    setError(undefined)
    setServerPending(true)
    try {
      const result = await api.connectLocalServers({
        ollama,
        lmStudio,
        ...(showOmlx ? { omlx, omlxApiKey } : {}),
      })
      if (!result.ok) {
        setError(result.reason)
        return
      }
      setOmlxApiKey("")
      const catalog = await load()
      if (!catalog) return
      if (
        !catalog.some(
          (item) => item.kind === "model" && (item.provider === "pair" || item.provider === "omlx"),
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
            <h1 className="onboarding-title">Otis</h1>
            <p className="onboarding-sub">{t("onboarding.tagline")}</p>
          </div>
          <div className="onboarding-choices">
            <p className="onboarding-choose">{t("onboarding.chooseSetup")}</p>
            <div className="onboarding-cards">
              <button
                type="button"
                className="onboarding-card"
                onClick={() => navigate("cloud", "forward")}
              >
                <Icon icon={Cloud} size={15} className="onboarding-cardIcon" />
                <span className="onboarding-cardText">
                  <span className="onboarding-cardTitle">{t("common.hosted")}</span>
                  <span className="onboarding-cardBody">{t("onboarding.hostedBody")}</span>
                </span>
                <Icon icon={ChevronRight} size={14} className="onboarding-cardChevron" />
              </button>
              <button
                type="button"
                className="onboarding-card"
                onClick={() => navigate("local", "forward")}
              >
                <Icon icon={HardDrive} size={15} className="onboarding-cardIcon" />
                <span className="onboarding-cardText">
                  <span className="onboarding-cardTitle">{t("common.local")}</span>
                  <span className="onboarding-cardBody">{t("onboarding.localBody")}</span>
                </span>
                <Icon icon={ChevronRight} size={14} className="onboarding-cardChevron" />
              </button>
            </div>
          </div>
        </div>
      </main>
    )
  }

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
          <>
            <OtisMark className="onboarding-logo" />
            <p className="onboarding-panelTitle">{t("onboarding.setupHosted")}</p>
          </>
        ) : null}

        {path === "local" ? (
          <>
            <div className="onboarding-stepHeader">
              <OtisMark className="onboarding-logo" />
              <p className="onboarding-panelTitle">{t("onboarding.chooseLocal")}</p>
              <p className="onboarding-hint">{t("onboarding.localHint")}</p>
            </div>
            <div className="onboarding-cards">
              <button
                type="button"
                className="onboarding-card"
                onClick={() => navigate("managed", "forward")}
              >
                <span className="onboarding-cardMark" aria-hidden>
                  <OtisMark className="onboarding-cardOtisMark" decorative />
                </span>
                <span className="onboarding-cardText">
                  <span className="onboarding-cardTitle">{t("onboarding.managed")}</span>
                  <span className="onboarding-cardBody">{t("onboarding.managedBody")}</span>
                </span>
                <Icon icon={ChevronRight} size={14} className="onboarding-cardChevron" />
              </button>
              <button
                type="button"
                className="onboarding-card"
                onClick={() => {
                  setOllama(state?.pairEndpoints.ollama ?? LOCAL_SERVER_DEFAULTS.ollama)
                  setLmStudio(state?.pairEndpoints.lmStudio ?? LOCAL_SERVER_DEFAULTS.lmStudio)
                  setOmlx(showOmlx ? (state?.omlx?.baseURL ?? "http://127.0.0.1:8000") : "")
                  setOmlxApiKey("")
                  setError(undefined)
                  navigate("server", "forward")
                }}
              >
                <span className="onboarding-providerMarks" aria-hidden>
                  <img
                    className="onboarding-providerMark onboarding-providerMarkOllama"
                    src={ollamaIcon}
                    alt=""
                  />
                  <img className="onboarding-providerMark" src={lmStudioIcon} alt="" />
                  {showOmlx ? (
                    <img className="onboarding-providerMark" src={omlxIcon} alt="" />
                  ) : null}
                </span>
                <span className="onboarding-cardText">
                  <span className="onboarding-cardTitle">{t("onboarding.server")}</span>
                  <span className="onboarding-cardBody">
                    {t("onboarding.serverBody", {
                      servers: serverList.format([...servers, "NVIDIA PAIR"]),
                    })}
                  </span>
                </span>
                <Icon icon={ChevronRight} size={14} className="onboarding-cardChevron" />
              </button>
            </div>
          </>
        ) : null}

        {path === "cloud" && !hostedConfigured ? (
          <>
            <p className="onboarding-hint">
              {t("onboarding.hostedHintBefore")}{" "}
              <button
                type="button"
                className="onboarding-link"
                onClick={() => void api.openFireworksKeyPage()}
              >
                {t("onboarding.getKey")}
              </button>{" "}
              {t("onboarding.hostedHintAfter")}
            </p>
            <div className="onboarding-keyRow">
              <Icon icon={KeyRound} size={14} className="onboarding-keyIcon" />
              <input
                className="onboarding-input"
                type="password"
                placeholder={t("onboarding.pasteKey")}
                aria-label={t("onboarding.fireworksKey")}
                value={apiKey}
                autoComplete="off"
                onChange={(event) => setApiKey(event.target.value)}
              />
              <Button
                variant="primary"
                size="sm"
                disabled={!apiKey.trim()}
                onClick={() => {
                  setError(undefined)
                  void api.setFireworksApiKey(apiKey.trim()).then((result) => {
                    if (!result.ok) setError(result.reason)
                  })
                }}
              >
                {t("common.continue")}
                <Icon icon={ArrowRight} size={13} />
              </Button>
            </div>
          </>
        ) : null}

        {path === "cloud" && hostedConfigured ? (
          <p className="onboarding-hint">{t("onboarding.keySaved")}</p>
        ) : null}

        {path === "managed" ? (
          <div className="onboarding-local">
            <OtisMark className="onboarding-logo" />
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
                <p className="onboarding-panelTitle">{t("onboarding.bestModel")}</p>
                <div className="onboarding-localPick">
                  <span className="onboarding-rowName">
                    {pick.displayName}
                    {"recommended" in pick && pick.recommended ? (
                      <span className="onboarding-recommended" title={t("common.recommended")}>
                        <Icon icon={Star} size={11} />
                      </span>
                    ) : null}
                    {"cpuOffload" in pick && pick.cpuOffload ? (
                      <span className="onboarding-cpuOffload" title={t("models.partlyOnCpu")}>
                        <Icon icon={Cpu} size={11} />
                      </span>
                    ) : null}
                  </span>
                  <span className="onboarding-rowDetail">
                    {pickLoading ? pickStatus.label : pickerDetailLabel(pick, t)}
                  </span>
                </div>
                <div className="onboarding-actions">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={pickLoading}
                    onClick={() => void select(pick)}
                  >
                    {"downloaded" in pick && pick.downloaded
                      ? t("common.continue")
                      : t("onboarding.downloadContinue")}
                    {pickLoading ? (
                      <Icon icon={Loader2} size={13} className="spin" />
                    ) : (
                      <Icon icon={ArrowRight} size={13} />
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
              <OtisMark className="onboarding-logo" />
              <p className="onboarding-panelTitle">{t("onboarding.connectServer")}</p>
              <p className="onboarding-hint">
                {t("onboarding.connectServerHint", { servers: serverList.format(servers) })}
              </p>
            </div>
            <div className="onboarding-endpoints">
              <label className="onboarding-endpointLabel" htmlFor="onboarding-ollama">
                <img
                  className="onboarding-endpointMark onboarding-providerMarkOllama"
                  src={ollamaIcon}
                  alt=""
                  aria-hidden
                />
                Ollama
              </label>
              <input
                id="onboarding-ollama"
                className="onboarding-endpointInput"
                value={ollama}
                onChange={(event) => setOllama(event.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <label className="onboarding-endpointLabel" htmlFor="onboarding-lmstudio">
                <img className="onboarding-endpointMark" src={lmStudioIcon} alt="" aria-hidden />
                LM Studio
              </label>
              <input
                id="onboarding-lmstudio"
                className="onboarding-endpointInput"
                value={lmStudio}
                onChange={(event) => setLmStudio(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void connectServer()
                }}
                spellCheck={false}
                autoComplete="off"
              />
              {showOmlx ? (
                <>
                  <label className="onboarding-endpointLabel" htmlFor="onboarding-omlx">
                    <img className="onboarding-endpointMark" src={omlxIcon} alt="" aria-hidden />
                    oMLX
                  </label>
                  <input
                    id="onboarding-omlx"
                    className="onboarding-endpointInput"
                    value={omlx}
                    onChange={(event) => setOmlx(event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <input
                    id="onboarding-omlx-key"
                    type="password"
                    className="onboarding-endpointInput onboarding-endpointKey"
                    aria-label={t("settings.omlxKey")}
                    value={omlxApiKey}
                    onChange={(event) => setOmlxApiKey(event.target.value)}
                    placeholder={
                      state?.omlx?.hasApiKey ? t("settings.omlxKeyHint") : t("settings.omlxKey")
                    }
                    autoComplete="off"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void connectServer()
                    }}
                  />
                </>
              ) : null}
              <div className="onboarding-actions onboarding-actionsEnd">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={serverPending}
                  onClick={() => void connectServer()}
                >
                  <Icon
                    icon={serverPending ? Loader2 : Plug}
                    size={13}
                    className={serverPending ? "spin" : undefined}
                  />
                  {serverPending ? t("common.checking") : t("common.connect")}
                </Button>
              </div>
            </div>
          </>
        ) : null}

        {path === "serverModels" ? (
          <>
            <div className="onboarding-stepHeader">
              <OtisMark className="onboarding-logo" />
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
          <div className="onboarding-list">
            {rows.map((item) => {
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
                        <span className="onboarding-recommended" title={t("common.recommended")}>
                          <Icon icon={Star} size={11} />
                        </span>
                      ) : null}
                      {"cpuOffload" in item && item.cpuOffload ? (
                        <span className="onboarding-cpuOffload" title={t("models.partlyOnCpu")}>
                          <Icon icon={Cpu} size={11} />
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={`onboarding-rowDetail${status?.kind === "error" ? " error" : ""}`}
                    >
                      {loading ? <Icon icon={Loader2} size={11} className="spin" /> : null}
                      {status?.label ?? pickerDetailLabel(item, t)}
                    </span>
                  </button>
                  {loading ? (
                    <IconButton
                      icon={X}
                      label={t("common.cancelModelLoad")}
                      size={22}
                      className="onboarding-cancel"
                      onClick={() => void api.cancelModelSelection()}
                    />
                  ) : null}
                </div>
              )
            })}
            {!items && !error ? (
              <p className="onboarding-hint">{t("common.loadingModels")}</p>
            ) : null}
          </div>
        ) : null}

        {path !== "managed" && error ? <p className="onboarding-error">{error}</p> : null}
      </div>
    </main>
  )
}
