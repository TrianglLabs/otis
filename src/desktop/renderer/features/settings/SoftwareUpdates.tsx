import { LoaderCircle } from "lucide-react"
import { useState } from "react"
import { Button } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { useDesktop, useDesktopState } from "../../runtime.js"

export function SoftwareUpdates() {
  const { api } = useDesktop()
  const state = useDesktopState()
  const [requesting, setRequesting] = useState(false)
  const [requestFailed, setRequestFailed] = useState(false)
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
          : ready
            ? `Otis ${update.version} is ready to install.`
            : unavailable
              ? "Update checks aren’t available in this build of Otis."
              : update.status === "current"
                ? "You’re up to date."
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
      <div className={`settings-message${failed ? " settings-error" : ""}`} role="status">
        {message}
      </div>
    </>
  )
}
