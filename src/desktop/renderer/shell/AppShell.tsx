import { Download, FolderOpen } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "../components/Button.js"
import { Icon } from "../components/Icon.js"
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
  const [installing, setInstalling] = useState(false)
  const [locateError, setLocateError] = useState<string | undefined>(undefined)
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
            {state?.needsWorkspace ? (
              <div className="workspaceBanner">
                <span>
                  Otis couldn&apos;t find this session&apos;s working folder. You can read its history; choose the
                  folder once to continue. Otis will remember it.
                  {locateError ? <span className="workspaceBanner-error">{locateError}</span> : null}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void api.pickWorkspaceFolder().then(async (path) => {
                      if (!path) return
                      const result = await api.locateWorkspace(path)
                      setLocateError(result.ok ? undefined : (result.reason ?? "Could not open that folder."))
                    })
                  }
                >
                  <Icon icon={FolderOpen} size={12} />
                  Locate working folder
                </Button>
              </div>
            ) : null}
            <ConversationView installing={installing} />
          </>
        )}
      </div>
      {settingsOpen ? null : <AgentsPanel />}
      {state?.update.status === "ready" ? (
        <button
          type="button"
          className="updateFab noDrag"
          disabled={installing}
          title={
            installing ? "Restarting into the update…" : `Otis ${state.update.version} is ready — restart to update`
          }
          onClick={() => {
            setInstalling(true)
            void api.installUpdate()
          }}
        >
          <Icon icon={Download} size={12} />
          {installing ? "Restarting…" : "Update"}
        </button>
      ) : null}
      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
    </div>
  )
}
