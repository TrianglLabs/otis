import { Brain, ChevronsUpDown } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type {
  LocalThinkingSelection,
  LocalThinkingState,
} from "../../../../inference/local-thinking.js"
import { Icon } from "../../components/Icon.js"
import { TabStrip } from "../../components/TabStrip.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import "./thinking-control.css"

export function ThinkingControl() {
  const state = useDesktopState("localThinking", "busy", "working", "modelState")
  if (!state?.localThinking) return null
  return (
    <ThinkingLevels
      key={state.localThinking.modelId}
      state={state.localThinking}
      disabled={state.busy || state.working > 0 || state.modelState !== "ready"}
    />
  )
}

function ThinkingLevels({ state, disabled }: { state: LocalThinkingState; disabled: boolean }) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(state.selected)
  const [error, setError] = useState<string>()
  const root = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLSpanElement>(null)
  const committed = useRef(state.selected)
  const pending = useRef<LocalThinkingSelection | undefined>(undefined)
  const saveId = useRef(0)
  const effective = selected === "default" ? state.defaultLevel : selected
  const levelLabel = t(`thinking.${effective}`)

  useEffect(() => {
    if (pending.current !== undefined) return
    committed.current = state.selected
    setSelected(state.selected)
  }, [state.selected])

  useEffect(() => {
    if (!open) return
    panel.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
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
        <Icon icon={ChevronsUpDown} size={10} />
      </button>
      {/* The model's levels as a segmented control, the pill on the chosen one. Choosing the
          model's own level follows its default rather than pinning it, and says so. */}
      {open ? (
        <span
          ref={panel}
          className="thinkingControl-panel"
          role="dialog"
          aria-label={t("thinking.title")}
        >
          <span className="thinkingControl-header">
            <span className="thinkingControl-title">{t("thinking.title")}</span>
            {effective === state.defaultLevel ? (
              <span className="thinkingControl-default">{t("thinking.default")}</span>
            ) : null}
          </span>
          <TabStrip
            tabs={state.levels.map((level) => [level, t(`thinking.${level}`)] as const)}
            selected={effective}
            onSelect={(level) => {
              setSelected(level)
              void save(level === state.defaultLevel ? "default" : level)
            }}
          />
          {error ? (
            <span role="alert" className="composer-error thinkingControl-error">
              {error}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}
