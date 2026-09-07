import { Folder, PanelLeftClose, Plus, Settings, Trash2 } from "lucide-react"
import { useState } from "react"
import type { SessionPickerItem } from "../../../app/session-metadata.js"
import { Button, IconButton } from "../components/Button.js"
import { Icon } from "../components/Icon.js"
import { useDesktop, useDesktopState } from "../runtime.js"
import { useScrollbarFlash } from "../useScrollbarFlash.js"

export function Sidebar({ onCollapse, onOpenSettings }: { onCollapse: () => void; onOpenSettings: () => void }) {
  const { api } = useDesktop()
  const state = useDesktopState()
  const busy = state?.busy ?? false
  const sessions = state?.sessions ?? []
  const scrollbar = useScrollbarFlash()
  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar-header">
        <span className="sidebar-workspace noDrag" title={state?.workspace.path}>
          <Icon icon={Folder} size={13} />
          <span className="sidebar-workspaceLabel">{state?.workspace.label ?? ""}</span>
        </span>
        <IconButton icon={Settings} label="Settings" onClick={onOpenSettings} className="noDrag" />
        <IconButton icon={PanelLeftClose} label="Hide sidebar (⌘B)" onClick={onCollapse} className="sidebar-collapse" />
      </div>

      <div className="sidebar-newSession">
        <Button
          variant="ghost"
          icon={Plus}
          className="sidebar-newButton"
          disabled={busy}
          title={busy ? "Finish the current work before starting over" : "New session (⌘N)"}
          onClick={() => void api.startNewSession()}
        >
          New session
        </Button>
      </div>

      <div className="sidebar-section">Sessions</div>
      <ul className={`sidebar-list${scrollbar.scrolling ? " scrolling" : ""}`} onScroll={scrollbar.onScroll}>
        {sessions.length === 0 ? <li className="sidebar-empty">No sessions yet</li> : null}
        {sessions.map((session) => (
          <li key={session.id} className="sidebar-listItem">
            <SessionRow session={session} disabled={busy} />
          </li>
        ))}
      </ul>
    </aside>
  )
}

function SessionRow({ session, disabled }: { session: SessionPickerItem; disabled: boolean }) {
  const { api } = useDesktop()
  const [confirming, setConfirming] = useState(false)

  if (confirming) {
    return (
      <div className="sessionRow sessionRow-confirm">
        <div className="sessionRow-text">
          <div className="sessionRow-title">Delete this session?</div>
          <div className="sessionRow-detail">This cannot be undone</div>
        </div>
        <div className="sessionRow-confirmActions">
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Keep
          </Button>
          <Button variant="danger" size="sm" onClick={() => void api.deleteSession(session.id)}>
            Delete
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={`sessionRow${session.active ? " sessionRow-active" : ""}`}>
      <button
        type="button"
        className="sessionRow-main"
        disabled={disabled}
        title={disabled ? "Finish the current work before switching sessions" : session.title}
        onClick={() => void api.selectSession(session.id)}
      >
        <span className="sessionRow-title">{session.title}</span>
        <span className="sessionRow-detail">{session.detail}</span>
      </button>
      <IconButton
        icon={Trash2}
        label="Delete session"
        className="sessionRow-delete"
        onClick={() => setConfirming(true)}
        size={22}
      />
    </div>
  )
}
