import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Cloud,
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
import lmStudioIcon from "../../assets/lm-studio.svg"
import ollamaIcon from "../../assets/ollama.svg"
import { Button, IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { OtisMark } from "../../components/OtisMark.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { isPickerRowSelectable, mergeModelLoad, pickerDetailLabel, pickerItemKey } from "../models/model-list.js"

const LOCAL_SERVER_DEFAULTS = { ollama: "http://127.0.0.1:11434", lmStudio: "http://127.0.0.1:1234" }

type OnboardingPath = "welcome" | "cloud" | "local" | "managed" | "server" | "serverModels"
type OnboardingDirection = "forward" | "back"

/**
 * First-run onboarding, rendered in place of the conversation until a model is configured. Hosted inference uses
 * Fireworks; local inference can either be managed by Otis or connect to an existing Ollama, LM Studio, or NVIDIA
 * PAIR endpoint. A successful selection sets `model` and the shell swaps this page for the workspace.
 */
export function OnboardingPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { api } = useDesktop()
  const state = useDesktopState("hostedConfigured", "modelLoad", "pairConfigured", "pairEndpoints")
  const [path, setPath] = useState<OnboardingPath>("welcome")
  const [direction, setDirection] = useState<OnboardingDirection>("forward")
  const [apiKey, setApiKey] = useState("")
  const [ollama, setOllama] = useState("")
  const [lmStudio, setLmStudio] = useState("")
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

  const pairConfigured = state?.pairConfigured === true

  useEffect(() => {
    if (path === "managed" || (path === "cloud" && hostedConfigured) || (path === "serverModels" && pairConfigured)) {
      void load()
    }
  }, [path, hostedConfigured, pairConfigured, load])

  const modelLoad = state?.modelLoad ?? null
  const rowProvider =
    path === "cloud" ? "fireworks" : path === "managed" ? "local" : path === "serverModels" ? "pair" : null
  const rows = mergeModelLoad(items ?? [], modelLoad).filter(
    (item): item is ModelPickerChoice => item.kind === "model" && rowProvider !== null && item.provider === rowProvider,
  )
  async function saveKey() {
    setError(undefined)
    const result = await api.setFireworksApiKey(apiKey.trim())
    if (!result.ok) setError(result.reason)
  }

  async function select(item: ModelPickerChoice) {
    if (!isPickerRowSelectable(item)) return
    setError(undefined)
    const result = await api.selectModel(pickerItemKey(item))
    if (
      !result.ok &&
      result.reason !== "The selection was cancelled." &&
      result.reason !== "The selection was superseded."
    ) {
      setError(result.reason)
    }
  }

  function openServerSetup() {
    setOllama(state?.pairEndpoints.ollama ?? LOCAL_SERVER_DEFAULTS.ollama)
    setLmStudio(state?.pairEndpoints.lmStudio ?? LOCAL_SERVER_DEFAULTS.lmStudio)
    setError(undefined)
    navigate("server", "forward")
  }

  async function connectServer() {
    setError(undefined)
    setServerPending(true)
    try {
      const result = await api.connectPairEndpoints({ ollama, lmStudio })
      if (!result.ok) {
        setError(result.reason)
        return
      }
      const catalog = await load()
      if (!catalog) return
      if (!catalog.some((item) => item.kind === "model" && item.provider === "pair")) {
        setError("Connected, but the server reported no available models.")
        return
      }
      navigate("serverModels", "forward")
    } finally {
      setServerPending(false)
    }
  }

  function goBack() {
    setError(undefined)
    if (path === "serverModels") navigate("server", "back")
    else navigate(path === "managed" || path === "server" ? "local" : "welcome", "back")
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
          <IconButton icon={Settings} label="Settings" size={26} className="noDrag" onClick={onOpenSettings} />
        </div>
        <div key={path} className={`onboarding-welcome onboarding-step onboarding-step-${direction}`}>
          <div className="onboarding-brand">
            <OtisMark className="onboarding-logo" />
            <h1 className="onboarding-title">Otis</h1>
            <p className="onboarding-sub">Your personal AI agent, powered by open models.</p>
          </div>
          <div className="onboarding-choices">
            <p className="onboarding-choose">Choose a model setup</p>
            <div className="onboarding-cards">
              <button type="button" className="onboarding-card" onClick={() => navigate("cloud", "forward")}>
                <Icon icon={Cloud} size={15} className="onboarding-cardIcon" />
                <span className="onboarding-cardText">
                  <span className="onboarding-cardTitle">Hosted</span>
                  <span className="onboarding-cardBody">
                    Top open models, ready instantly. Pay-as-you-go — you connect it with a Fireworks key.
                  </span>
                </span>
                <Icon icon={ChevronRight} size={14} className="onboarding-cardChevron" />
              </button>
              <button type="button" className="onboarding-card" onClick={() => navigate("local", "forward")}>
                <Icon icon={HardDrive} size={15} className="onboarding-cardIcon" />
                <span className="onboarding-cardText">
                  <span className="onboarding-cardTitle">Local</span>
                  <span className="onboarding-cardBody">
                    Run models on this Mac or your local AI network. Private and works offline.
                  </span>
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
        <Button variant="ghost" size="sm" className="noDrag" onClick={goBack}>
          <Icon icon={ArrowLeft} size={13} />
          Back
        </Button>
        <IconButton icon={Settings} label="Settings" size={26} className="noDrag" onClick={onOpenSettings} />
      </div>
      <div key={path} className={`onboarding-panel onboarding-step onboarding-step-${direction}`}>
        {path === "cloud" ? (
          <>
            <OtisMark className="onboarding-logo" />
            <p className="onboarding-panelTitle">Set up hosted models</p>
          </>
        ) : null}

        {path === "local" ? (
          <>
            <div className="onboarding-stepHeader">
              <OtisMark className="onboarding-logo" />
              <p className="onboarding-panelTitle">Choose local inference</p>
              <p className="onboarding-hint">Use a model managed by Otis or connect one you already run.</p>
            </div>
            <div className="onboarding-cards">
              <button type="button" className="onboarding-card" onClick={() => navigate("managed", "forward")}>
                <span className="onboarding-cardMark" aria-hidden>
                  <OtisMark className="onboarding-cardOtisMark" decorative />
                </span>
                <span className="onboarding-cardText">
                  <span className="onboarding-cardTitle">Managed by Otis</span>
                  <span className="onboarding-cardBody">Download a curated model and run it with llama.cpp.</span>
                </span>
                <Icon icon={ChevronRight} size={14} className="onboarding-cardChevron" />
              </button>
              <button type="button" className="onboarding-card" onClick={openServerSetup}>
                <span className="onboarding-providerMarks" aria-hidden>
                  <img className="onboarding-providerMark onboarding-providerMarkOllama" src={ollamaIcon} alt="" />
                  <img className="onboarding-providerMark" src={lmStudioIcon} alt="" />
                </span>
                <span className="onboarding-cardText">
                  <span className="onboarding-cardTitle">Ollama or LM Studio</span>
                  <span className="onboarding-cardBody">Connect directly or through NVIDIA PAIR.</span>
                </span>
                <Icon icon={ChevronRight} size={14} className="onboarding-cardChevron" />
              </button>
            </div>
          </>
        ) : null}

        {path === "cloud" && !hostedConfigured ? (
          <>
            <p className="onboarding-hint">
              Hosted models run on Fireworks (pay-as-you-go).{" "}
              <button type="button" className="onboarding-link" onClick={() => void api.openFireworksKeyPage()}>
                Get a key
              </button>{" "}
              and paste it here:
            </p>
            <div className="onboarding-keyRow">
              <Icon icon={KeyRound} size={14} className="onboarding-keyIcon" />
              <input
                className="onboarding-input"
                type="password"
                placeholder="Paste your key here"
                aria-label="Fireworks API key"
                value={apiKey}
                autoComplete="off"
                onChange={(event) => setApiKey(event.target.value)}
              />
              <Button variant="primary" size="sm" disabled={!apiKey.trim()} onClick={() => void saveKey()}>
                Continue
                <Icon icon={ArrowRight} size={13} />
              </Button>
            </div>
          </>
        ) : null}

        {path === "cloud" && hostedConfigured ? <p className="onboarding-hint">Key saved. Now pick a model:</p> : null}

        {path === "managed" ? <LocalPick items={rows} itemsLoaded={items !== undefined} onSelect={select} /> : null}

        {path === "server" ? (
          <>
            <div className="onboarding-stepHeader">
              <OtisMark className="onboarding-logo" />
              <p className="onboarding-panelTitle">Connect a local model server</p>
              <p className="onboarding-hint">
                Connect to Ollama or LM Studio directly, or through NVIDIA PAIR — the default local addresses are
                prefilled.
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
              <div className="onboarding-actions onboarding-actionsEnd">
                <Button variant="primary" size="sm" disabled={serverPending} onClick={() => void connectServer()}>
                  <Icon
                    icon={serverPending ? Loader2 : Plug}
                    size={13}
                    className={serverPending ? "spin" : undefined}
                  />
                  {serverPending ? "Checking…" : "Connect"}
                </Button>
              </div>
            </div>
          </>
        ) : null}

        {path === "serverModels" ? (
          <>
            <div className="onboarding-stepHeader">
              <OtisMark className="onboarding-logo" />
              <p className="onboarding-panelTitle">Choose a model</p>
              <p className="onboarding-hint">Select a model reported by your connected server.</p>
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
                    <span className="onboarding-rowDetail">{pickerDetailLabel(item)}</span>
                  </button>
                </div>
              ))}
              {!items && !error ? <p className="onboarding-hint">Loading models…</p> : null}
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
                        <span className="onboarding-recommended" title="Recommended for this machine">
                          <Icon icon={Star} size={11} />
                        </span>
                      ) : null}
                    </span>
                    <span className={`onboarding-rowDetail${status?.kind === "error" ? " error" : ""}`}>
                      {loading ? <Icon icon={Loader2} size={11} className="spin" /> : null}
                      {status?.label ?? pickerDetailLabel(item)}
                    </span>
                  </button>
                  {loading ? (
                    <IconButton
                      icon={X}
                      label="Cancel model load"
                      size={22}
                      className="onboarding-cancel"
                      onClick={() => void api.cancelModelSelection()}
                    />
                  ) : null}
                </div>
              )
            })}
            {!items && !error ? <p className="onboarding-hint">Loading models…</p> : null}
          </div>
        ) : null}

        {error ? <p className="onboarding-error">{error}</p> : null}
      </div>
    </main>
  )
}

/** The local step: the brand mark and the single best model for this Mac — no list to dig through. */
function LocalPick({
  items,
  itemsLoaded,
  onSelect,
}: {
  items: ModelPickerChoice[]
  itemsLoaded: boolean
  onSelect: (item: ModelPickerChoice) => void
}) {
  const { api } = useDesktop()
  const pick =
    items.find((item) => "recommended" in item && item.recommended && isPickerRowSelectable(item)) ??
    items.find(isPickerRowSelectable)
  if (!pick) {
    return (
      <div className="onboarding-local">
        <OtisMark className="onboarding-logo" />
        <p className="onboarding-hint">
          {itemsLoaded ? "No local model fits this Mac — go back and pick Hosted." : "Loading models…"}
        </p>
      </div>
    )
  }
  const status = "status" in pick ? pick.status : undefined
  const loading = status?.kind === "progress"
  return (
    <div className="onboarding-local">
      <OtisMark className="onboarding-logo" />
      <p className="onboarding-panelTitle">Best model for your Mac</p>
      <div className="onboarding-localPick">
        <span className="onboarding-rowName">
          {pick.displayName}
          {"recommended" in pick && pick.recommended ? (
            <span className="onboarding-recommended" title="Recommended for this machine">
              <Icon icon={Star} size={11} />
            </span>
          ) : null}
        </span>
        <span className={`onboarding-rowDetail${status?.kind === "error" ? " error" : ""}`}>
          {status?.label ?? pickerDetailLabel(pick)}
        </span>
      </div>
      <div className="onboarding-actions">
        <Button
          variant="primary"
          size="sm"
          disabled={!isPickerRowSelectable(pick) || loading}
          onClick={() => onSelect(pick)}
        >
          {"downloaded" in pick && pick.downloaded ? "Continue" : "Download and continue"}
          {loading ? <Icon icon={Loader2} size={13} className="spin" /> : <Icon icon={ArrowRight} size={13} />}
        </Button>
        {loading ? (
          <IconButton icon={X} label="Cancel model load" size={22} onClick={() => void api.cancelModelSelection()} />
        ) : null}
      </div>
    </div>
  )
}
