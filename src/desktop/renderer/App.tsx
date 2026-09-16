import { Diamond } from "lucide-react"
import { OtisMark } from "./components/OtisMark.js"
import { useI18n } from "./i18n/index.js"
import { useDesktopSelector } from "./runtime.js"
import { AppShell } from "./shell/AppShell.js"

export function App() {
  const { t } = useI18n()
  const ready = useDesktopSelector((state) => state !== undefined)
  if (!ready) {
    return (
      <div className="bootScreen" role="status" aria-label={t("app.loadingWorkspace")}>
        <OtisMark className="home-logo" />
      </div>
    )
  }
  return <AppShell />
}

/** Shown when the preload bridge is missing outside demo mode. A broken bridge is loud, never disguised. */
export function BridgeMissing() {
  const { t } = useI18n()
  return (
    <div className="bootScreen bootScreen-error">
      <Diamond
        size={22}
        strokeWidth={1.25}
        fill="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      />
      <span>{t("app.bridgeUnavailable")}</span>
      <span className="bootScreen-hint">{t("app.bridgeUnavailableHint")}</span>
    </div>
  )
}
