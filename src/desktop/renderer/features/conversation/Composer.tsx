import { ArrowUp, ChevronDown, FolderOpen, Square, Zap } from "lucide-react"
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
/** The chip shows just the folder name; the full path stays in the tooltip. */
function workspaceFolderName(workspace: { label: string; path: string }): string {
  const parts = workspace.path.split("/").filter(Boolean)
  return parts.at(-1) ?? workspace.label
}

export function Composer({ installing = false }: { installing?: boolean }) {
  const { api } = useDesktop()
  const state = useDesktopState()
  const [draft, setDraft] = useState("")
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string>()
  const [pickerOpen, setPickerOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const busy = state?.busy ?? false
  const modelState = state?.modelState ?? "unconfigured"
  const needsWorkspace = state?.needsWorkspace ?? false
  const canSend = modelState === "ready" && draft.trim().length > 0 && !sending && !installing && !needsWorkspace

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "0"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`
  }, [draft])

  const openFolder = async () => {
    const path = await api.pickWorkspaceFolder()
    if (!path) return
    setWorkspaceError(undefined)
    const result = await api.openWorkspace(path)
    if (!result.ok) setWorkspaceError(result.reason)
  }

  const submit = async () => {
    const text = draft
    if (!text.trim() || sending || modelState !== "ready" || installing || needsWorkspace) return
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

  const placeholder = installing
    ? "Restarting into the update…"
    : needsWorkspace
      ? "Locate the working folder to continue this session"
      : modelState === "starting"
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
          <span className="composer-context">
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
            ) : null}
            {state ? (
              <button
                type="button"
                className="composer-workspace noDrag"
                title={workspaceError ?? `${state.workspace.path} — open a different folder`}
                onClick={() => void openFolder()}
              >
                <Icon icon={FolderOpen} size={11} />
                {workspaceFolderName(state.workspace)}
              </button>
            ) : null}
          </span>
          <span className="composer-actions">
            {busy ? (
              <Button variant="danger" size="sm" icon={Square} onClick={() => void api.stop()} title="Stop (Esc)">
                Stop
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              iconAfter={ArrowUp}
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
