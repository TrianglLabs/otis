import { Brain, ChevronDown, RotateCcw } from "lucide-react"
import { type CSSProperties, useEffect, useRef, useState } from "react"
import type {
  LocalThinkingSelection,
  LocalThinkingState,
} from "../../../../inference/local-thinking.js"
import { Icon } from "../../components/Icon.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import "./thinking-control.css"

export function ThinkingControl() {
  const state = useDesktopState("localThinking", "busy", "modelState")
  if (!state?.localThinking) return null
  return (
    <ThinkingSlider
      key={state.localThinking.modelId}
      state={state.localThinking}
      disabled={state.busy || state.modelState !== "ready"}
    />
  )
}

function ThinkingSlider({ state, disabled }: { state: LocalThinkingState; disabled: boolean }) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(state.selected)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const root = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const slider = useRef<HTMLInputElement>(null)
  const committed = useRef(state.selected)
  const pending = useRef<LocalThinkingSelection | undefined>(undefined)
  const saveId = useRef(0)
  const effective = selected === "default" ? state.defaultLevel : selected
  const levelLabel = t(`thinking.${effective}`)
  const fillPercent = (state.levels.indexOf(effective) / (state.levels.length - 1)) * 100

  useEffect(() => {
    if (pending.current !== undefined) return
    committed.current = state.selected
    setSelected(state.selected)
  }, [state.selected])

  useEffect(() => {
    if (!open) return
    slider.current?.focus()
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener("pointerdown", closeOutside)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener("keydown", closeOnEscape, true)
    return () => {
      document.removeEventListener("pointerdown", closeOutside)
      document.removeEventListener("keydown", closeOnEscape, true)
    }
  }, [open])

  async function save(value: LocalThinkingSelection) {
    if (
      disabled ||
      value === pending.current ||
      (pending.current === undefined && value === committed.current)
    )
      return
    const id = ++saveId.current
    pending.current = value
    setSaving(true)
    setError(undefined)
    try {
      await api.setLocalThinking(state.modelId, value)
      committed.current = value
      if (id !== saveId.current) return
      setSelected(value)
    } catch (reason) {
      if (id !== saveId.current) return
      setSelected(committed.current)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (id === saveId.current) {
        pending.current = undefined
        setSaving(false)
      }
    }
  }

  return (
    <span ref={root} className="thinkingControl">
      <button
        ref={trigger}
        type="button"
        className="composer-model thinkingControl-trigger"
        aria-label={`${t("thinking.label")} ${levelLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        title={t("thinking.title")}
      >
        <Icon icon={Brain} size={12} />
        <span className="thinkingControl-value">{levelLabel}</span>
        <Icon icon={ChevronDown} size={10} />
      </button>
      {open ? (
        <span
          className="composer-popover thinkingControl-panel"
          role="dialog"
          aria-label={t("thinking.title")}
          style={{ "--thinking-fill": `${fillPercent}%` } as CSSProperties}
        >
          <span className="thinkingControl-header">
            <span className="thinkingControl-selected" aria-hidden="true">
              {levelLabel}
            </span>
            <button
              type="button"
              className="thinkingControl-reset"
              aria-label={t("thinking.reset")}
              title={t("thinking.reset")}
              disabled={disabled || saving || selected === "default"}
              onClick={() => void save("default")}
            >
              <Icon icon={RotateCcw} size={12} />
            </button>
          </span>
          <input
            ref={slider}
            type="range"
            min={0}
            max={state.levels.length - 1}
            step={1}
            value={state.levels.indexOf(effective)}
            aria-label={t("thinking.title")}
            aria-valuetext={levelLabel}
            disabled={disabled}
            onChange={(event) => setSelected(state.levels[Number(event.target.value)])}
            onPointerUp={(event) => void save(state.levels[Number(event.currentTarget.value)])}
            onKeyUp={(event) => {
              if (
                [
                  "ArrowLeft",
                  "ArrowRight",
                  "ArrowUp",
                  "ArrowDown",
                  "Home",
                  "End",
                  "PageUp",
                  "PageDown",
                ].includes(event.key)
              ) {
                void save(state.levels[Number(event.currentTarget.value)])
              }
            }}
            onBlur={() => void save(selected)}
          />
          {error ? (
            <span role="alert" className="composer-error">
              {error}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}
