import { ArrowUp, ChevronDown, Square, Zap } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Button } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { PROVIDER_LABELS, shortModelId } from "../../format.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { ModelPicker } from "../models/ModelPicker.js"
import { draftAfterSend } from "./draft.js"

/**
 * The prompt composer. Enter sends, Shift+Enter inserts a newline, Escape stops active work. The draft is only
 * cleared after the application accepts the prompt (recorded in the session); on rejection the text stays put and
 * the reason is shown.
 */
export function Composer() {
  const { api } = useDesktop()
  const state = useDesktopState()
  const [draft, setDraft] = useState("")
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const busy = state?.busy ?? false
  const modelState = state?.modelState ?? "unconfigured"
  const canSend = modelState === "ready" && draft.trim().length > 0 && !sending

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "0"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`
  }, [draft])

  const submit = async () => {
    const text = draft
    if (!text.trim() || sending || modelState !== "ready") return
    setSending(true)
    setSendError(null)
    try {
      const result = await api.sendPrompt(text)
      if (result.accepted) setDraft((current) => draftAfterSend(current, text, true))
      else setSendError(result.reason)
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }

  const placeholder =
    modelState === "starting"
      ? "Starting the model…"
      : modelState === "ready"
        ? busy
          ? "Steer the active turn, or queue a follow-up…"
          : "Ask Otis anything…"
        : "Set up a model to start chatting"

  return (
    <div className="composer">
      {modelState === "failed" && state?.modelError ? (
        <div className="composer-banner" role="alert">
          The model could not start: {state.modelError}
        </div>
      ) : null}
      <div
        className={`composer-box${busy ? " composer-boxWorking" : ""}${modelState !== "ready" && !busy ? " composer-boxDisabled" : ""}`}
      >
        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          placeholder={placeholder}
          disabled={modelState !== "ready"}
          aria-label="Prompt"
          onChange={(event) => {
            setDraft(event.target.value)
            setSendError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            } else if (event.key === "Escape" && busy) {
              event.preventDefault()
              void api.stop()
            }
          }}
        />
        <div className="composer-footer">
          {state?.model ? (
            <>
              <button
                type="button"
                className={`composer-model${state.modelState === "starting" || state.modelState === "failed" ? ` composer-model-${state.modelState}` : ""}`}
                onClick={() => setPickerOpen((open) => !open)}
                title={`${state.model.id} · ${PROVIDER_LABELS[state.model.provider] ?? state.model.provider}${state.fastServing.enabled ? " · Fast serving" : ""} — select a model`}
                aria-haspopup="dialog"
                aria-expanded={pickerOpen}
              >
                {state.fastServing.enabled ? <Icon icon={Zap} size={11} className="composer-fast" /> : null}
                {state.model.displayName ?? shortModelId(state.model.id)}
                <Icon icon={ChevronDown} size={11} />
              </button>
              {pickerOpen ? <ModelPicker onClose={() => setPickerOpen(false)} /> : null}
            </>
          ) : (
            <span className="composer-model" />
          )}
          <span className="composer-actions">
            {busy ? (
              <Button variant="danger" size="sm" icon={Square} onClick={() => void api.stop()} title="Stop (Esc)">
                Stop
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              icon={ArrowUp}
              disabled={!canSend}
              onClick={() => void submit()}
              title={busy ? "Send as follow-up (Enter)" : "Send (Enter)"}
            >
              {busy ? "Follow up" : "Send"}
            </Button>
          </span>
        </div>
      </div>
      {sendError ? (
        <div className="composer-hint">
          <span className="composer-error">{sendError} Your draft was kept.</span>
        </div>
      ) : null}
    </div>
  )
}
