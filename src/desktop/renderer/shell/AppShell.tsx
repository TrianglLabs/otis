import { useEffect, useState } from "react"
import { AgentsPanel } from "../features/agents/AgentsPanel.js"
import { ConversationView } from "../features/conversation/Transcript.js"
import { SettingsPage } from "../features/settings/SettingsPage.js"
import { useDesktop, useDesktopState } from "../runtime.js"
import { Sidebar } from "./Sidebar.js"
import { WorkspaceHeader } from "./WorkspaceHeader.js"

/**
 * The application shell: collapsible session sidebar, the conversation column, and the delegated-runs rail when
 * the session has subagents. The header rows double as the window drag region (the macOS title bar is hidden);
 * interactive elements opt out with the `noDrag` class.
 */
export function AppShell() {
  const { api } = useDesktop()
  const state = useDesktopState()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = state?.theme ?? "default"
  }, [state?.theme])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key === "b") {
        event.preventDefault()
        setSidebarCollapsed((value) => !value)
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
    <div
      className={`appShell ${platformClass}${sidebarCollapsed ? " sidebarCollapsed" : ""}${settingsOpen ? " settingsOpen" : ""}`}
    >
      {sidebarCollapsed || settingsOpen ? null : (
        <Sidebar onCollapse={() => setSidebarCollapsed(true)} onOpenSettings={() => setSettingsOpen(true)} />
      )}
      {settingsOpen ? (
        <div className="mainColumn">
          <SettingsPage onClose={() => setSettingsOpen(false)} />
        </div>
      ) : null}
      {/* The conversation stays mounted while settings is open — hidden, not unmounted — so the composer's draft,
          the transcript scroll position, and expanded cards survive the round trip. */}
      <div className={`mainColumn${settingsOpen ? " mainColumn-hidden" : ""}`}>
        <WorkspaceHeader sidebarCollapsed={sidebarCollapsed} onShowSidebar={() => setSidebarCollapsed(false)} />
        <ConversationView />
      </div>
      {settingsOpen ? null : <AgentsPanel />}
    </div>
  )
}
