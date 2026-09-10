import { Diamond } from "lucide-react"
import { useDesktopState } from "./runtime.js"
import { AppShell } from "./shell/AppShell.js"

export function App() {
  const state = useDesktopState()
  if (!state) {
    return (
      <div className="bootScreen">
        <Diamond
          size={22}
          strokeWidth={1.25}
          fill="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        />
        <span>Loading workspace…</span>
      </div>
    )
  }
  return <AppShell />
}

/** Shown when the preload bridge is missing outside demo mode. A broken bridge is loud, never disguised. */
export function BridgeMissing() {
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
      <span>The desktop bridge is unavailable.</span>
      <span className="bootScreen-hint">Restart the app. If the problem persists, reinstall Otis Desktop.</span>
    </div>
  )
}
