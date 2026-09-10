import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Cloud,
  HardDrive,
  KeyRound,
  Loader2,
  Settings,
  Star,
  X,
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import type { ModelPickerChoice, ModelPickerItem } from "../../../../inference/picker-catalog.js"
import { Button, IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { OtisMark } from "../../components/OtisMark.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { isPickerRowSelectable, mergeModelLoad, pickerDetailLabel, pickerItemKey } from "../models/model-list.js"

/**
 * First-run onboarding, rendered in place of the conversation until a model is configured. Two paths: cloud
 * (Fireworks API key, then a hosted model) or a managed local model (selection downloads and loads it). PAIR is
 * deliberately absent — it is an advanced loopback setup that belongs in Settings. A successful selection sets
 * `model` in the snapshot and the shell swaps this page for the workspace on its own.
 */
export function OnboardingPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { api } = useDesktop()
  const state = useDesktopState()
  const [path, setPath] = useState<"welcome" | "cloud" | "local">("welcome")
  const [apiKey, setApiKey] = useState("")
  const [items, setItems] = useState<ModelPickerItem[]>()
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    try {
      setItems(await api.listModels())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [api])

  const hostedConfigured = state?.hostedConfigured === true

  useEffect(() => {
    if (path === "local" || (path === "cloud" && hostedConfigured)) void load()
  }, [path, hostedConfigured, load])

  const modelLoad = state?.modelLoad ?? null
  const rows = mergeModelLoad(items ?? [], modelLoad).filter(
    (item): item is ModelPickerChoice =>
      item.kind === "model" && item.provider === (path === "cloud" ? "fireworks" : "local"),
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

  if (path === "welcome") {
    return (
      <main className="onboarding">
        <div className="onboarding-topbar">
          <span />
          <IconButton icon={Settings} label="Settings" size={26} className="noDrag" onClick={onOpenSettings} />
        </div>
        <OtisMark className="home-logo" />
        <p className="onboarding-sub">Your personal AI agent, powered by open models.</p>
        <p className="onboarding-choose">Where should the AI run?</p>
        <div className="onboarding-cards">
          <button type="button" className="onboarding-card" onClick={() => setPath("cloud")}>
            <Icon icon={Cloud} size={15} className="onboarding-cardIcon" />
            <span className="onboarding-cardText">
              <span className="onboarding-cardTitle">Hosted</span>
              <span className="onboarding-cardBody">
                Top open models, ready instantly. Pay-as-you-go — you connect it with a Fireworks key.
              </span>
            </span>
            <Icon icon={ChevronRight} size={14} className="onboarding-cardChevron" />
          </button>
          <button type="button" className="onboarding-card" onClick={() => setPath("local")}>
            <Icon icon={HardDrive} size={15} className="onboarding-cardIcon" />
            <span className="onboarding-cardText">
              <span className="onboarding-cardTitle">On this Mac</span>
              <span className="onboarding-cardBody">
                A model downloaded to your computer. Free, private, works offline.
              </span>
            </span>
            <Icon icon={ChevronRight} size={14} className="onboarding-cardChevron" />
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="onboarding">
      <div className="onboarding-topbar">
        <Button variant="ghost" size="sm" className="noDrag" onClick={() => setPath("welcome")}>
          <Icon icon={ArrowLeft} size={13} />
          Back
        </Button>
        <IconButton icon={Settings} label="Settings" size={26} className="noDrag" onClick={onOpenSettings} />
      </div>
      <div className="onboarding-panel">
        {path === "cloud" ? (
          <>
            <OtisMark className="home-logo" />
            <p className="onboarding-panelTitle">Set up hosted models</p>
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

        {path === "local" ? <LocalPick items={rows} itemsLoaded={items !== undefined} onSelect={select} /> : null}

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
        <OtisMark className="home-logo" />
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
      <OtisMark className="home-logo" />
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
