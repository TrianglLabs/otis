import { LoaderCircle } from "lucide-react"
import { useState } from "react"
import { Button } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopState } from "../../runtime.js"

export function SoftwareUpdates() {
  const { api } = useDesktop()
  const { t } = useI18n()
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
    ? t("updates.checkFailed")
    : checking
      ? t("updates.checkingNewer")
      : update.status === "error"
        ? update.message
        : downloading
          ? t("updates.downloadingVersion", { version: update.version })
          : unavailable
            ? t("updates.unavailableBuild")
            : hasChecked && update.status === "current"
              ? t("updates.upToDate")
              : update.status === "current" || ready
                ? undefined
                : t("updates.backgroundHint")

  return (
    <>
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
          {checking
            ? t("updates.checking")
            : downloading
              ? t("updates.downloading")
              : ready
                ? t("updates.ready")
                : t("updates.check")}
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
