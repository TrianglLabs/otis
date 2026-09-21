import { LoaderCircle } from "lucide-react"
import { useState } from "react"
import { Button } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopState } from "../../runtime.js"

export function SoftwareUpdates({ installing, onInstall }: { installing: boolean; onInstall: () => void }) {
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

  const message =
    checking || downloading || ready || installing
      ? undefined
      : requestFailed
        ? t("updates.checkFailed")
        : update.status === "error"
          ? update.message
          : unavailable
            ? t("updates.unavailableBuild")
            : hasChecked && update.status === "current"
              ? t("updates.upToDate")
              : undefined

  return (
    <div className="settingsRow settingsUpdate">
      <span className="settingsRow-label">
        Otis <span className="settingsRow-meta">{state.version}</span>
      </span>
      {message ? (
        <span className={`settingsUpdate-status${failed ? " settings-error" : ""}`} role="status">
          {message}
        </span>
      ) : null}
      <Button
        size="sm"
        disabled={installing || checking || downloading || unavailable}
        onClick={ready ? onInstall : () => void check()}
        aria-live="polite"
        aria-busy={installing || checking || downloading}
        title={
          ready
            ? t("updates.versionReady", { version: update.version })
            : downloading
              ? t("updates.downloadingVersion", { version: update.version })
              : undefined
        }
      >
        {installing || checking || downloading ? <Icon icon={LoaderCircle} size={12} className="spin" /> : null}
        {installing
          ? t("shell.restarting")
          : checking
            ? t("updates.checking")
            : downloading
              ? t("updates.downloading")
              : ready
                ? t("updates.restartInstall")
                : t("updates.check")}
      </Button>
    </div>
  )
}
