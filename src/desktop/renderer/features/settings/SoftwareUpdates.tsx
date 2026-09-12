import { LoaderCircle } from "lucide-react"
import { useState } from "react"
import { Button } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { useDesktop, useDesktopState } from "../../runtime.js"

export function SoftwareUpdates() {
  const { api } = useDesktop()
  const state = useDesktopState("update", "version")
  const [requesting, setRequesting] = useState(false)
  const [requestFailed, setRequestFailed] = useState(false)
  // "You're up to date." is a check result, not a resting status: it only appears after a manual check.
  const [hasChecked, setHasChecked] = useState(false)
  if (!state) return null

  const { update } = state
  const downloading = update.status === "downloading"
  const ready = update.status === "ready"
  const unavailable = update.status === "unavailable"
  const checking = update.status === "checking" || (requesting && !downloading && !ready && update.status !== "error")
  const failed = requestFailed || update.status === "error"

  const check = async () => {
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

  const message = requestFailed
    ? "Couldn’t check for updates. Please try again."
    : checking
      ? "Checking for a newer version…"
      : update.status === "error"
        ? update.message
        : downloading
          ? `Downloading Otis ${update.version} in the background…`
          : unavailable
            ? "Update checks aren’t available in this build of Otis."
            : hasChecked && update.status === "current"
              ? "You’re up to date."
              : update.status === "current" || ready
                ? undefined
                : "Updates download in the background. You choose when to restart."

  return (
    <>
      <div className="settings-section">Updates</div>
      <div className="settingsRow">
        <span className="settingsRow-label">
          Otis <span className="settingsRow-meta">{state.version}</span>
        </span>
        <Button
          size="sm"
          disabled={requesting || checking || downloading || ready || unavailable}
          onClick={() => void check()}
        >
          {checking || downloading ? <Icon icon={LoaderCircle} size={12} className="spin" /> : null}
          {checking ? "Checking…" : downloading ? "Downloading…" : ready ? "Update ready" : "Check for updates"}
        </Button>
      </div>
      {message ? (
        <div className={`settings-message${failed ? " settings-error" : ""}`} role="status">
          {message}
        </div>
      ) : null}
    </>
  )
}
