import { useEffect, useState } from "react"
import { AgentsPanel } from "../features/agents/AgentsPanel.js"
import { ConversationView } from "../features/conversation/Transcript.js"
import { OnboardingPage } from "../features/onboarding/OnboardingPage.js"
import { CommandPalette } from "../features/palette/CommandPalette.js"
import { SettingsPage } from "../features/settings/SettingsPage.js"
import { useDesktop, useDesktopState } from "../runtime.js"
import { WorkspaceHeader } from "./WorkspaceHeader.js"

/**
 * The application shell: the conversation column and the delegated-runs rail when the session has subagents.
 * There is no session sidebar — the ⌘K palette is the only session navigation. The header rows double as the
 * window drag region (the macOS title bar is hidden); interactive elements opt out with `noDrag`.
 */
export function AppShell() {
  const { api } = useDesktop()
  const state = useDesktopState()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = state?.theme ?? "default"
  }, [state?.theme])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key === "k") {
        event.preventDefault()
        setPaletteOpen((value) => !value)
      } else if (event.key === "n") {
        event.preventDefault()
        void api.startNewSession()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [api])

  const platformClass = state?.platform === "darwin" ? "platform-darwin" : "platform-linux"

  return (
    <div className={`appShell ${platformClass}${settingsOpen ? " settingsOpen" : ""}`}>
      {settingsOpen ? (
        <div className="mainColumn">
          <SettingsPage onClose={() => setSettingsOpen(false)} />
        </div>
      ) : null}
      {/* The conversation stays mounted while settings is open — hidden, not unmounted — so the composer's draft,
          the transcript scroll position, and expanded cards survive the round trip. */}
      <div className={`mainColumn${settingsOpen ? " mainColumn-hidden" : ""}`}>
        {state && state.model === null ? (
          <OnboardingPage onOpenSettings={() => setSettingsOpen(true)} />
        ) : (
          <>
            <WorkspaceHeader onOpenPalette={() => setPaletteOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />
            <ConversationView />
          </>
        )}
      </div>
      {settingsOpen ? null : <AgentsPanel />}
      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
    </div>
  )
}
