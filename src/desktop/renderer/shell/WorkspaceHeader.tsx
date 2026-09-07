import { Folder, PanelLeftOpen, PanelRightOpen } from "lucide-react"
import { IconButton } from "../components/Button.js"
import { Icon } from "../components/Icon.js"
import { formatTokenCount } from "../format.js"
import { useDesktop, useDesktopState } from "../runtime.js"

/**
 * The compact bar above the conversation. The session title lives here; the workspace path lives in the sidebar
 * (sessions are per-workspace) and surfaces here only when the sidebar is collapsed.
 */
export function WorkspaceHeader({
  sidebarCollapsed,
  onShowSidebar,
}: {
  sidebarCollapsed: boolean
  onShowSidebar: () => void
}) {
  const { api } = useDesktop()
  const state = useDesktopState()
  if (!state) return <header className="workspaceHeader" />

  const { diffs, contextTokens, contextLimit } = state

  return (
    <header className="workspaceHeader">
      <div className="workspaceHeader-left">
        {sidebarCollapsed ? (
          <>
            <IconButton icon={PanelLeftOpen} label="Show sidebar (⌘B)" onClick={onShowSidebar} className="noDrag" />
            <span className="workspaceHeader-folder noDrag" title={state.workspace.path}>
              <Icon icon={Folder} size={13} />
              <span className="workspaceHeader-label">{state.workspace.label}</span>
            </span>
          </>
        ) : null}
      </div>

      {state.session ? <div className="workspaceHeader-title">{state.session.title}</div> : null}

      <div className="workspaceHeader-right">
        {state.subagents.length > 0 && !state.agentsPanelVisible ? (
          <IconButton
            icon={PanelRightOpen}
            label="Show subagents panel"
            onClick={() => void api.setAgentsPanelVisible(true)}
            className="noDrag"
          />
        ) : null}
        {diffs.added + diffs.removed > 0 ? (
          <span className="headerDiff noDrag" title="Lines changed this session">
            <span className="headerDiff-add">+{diffs.added}</span>
            <span className="headerDiff-remove">−{diffs.removed}</span>
          </span>
        ) : null}
        {contextTokens !== undefined ? (
          <span
            className="contextMeter noDrag"
            title={`${contextTokens.toLocaleString()} of ~${contextLimit.toLocaleString()} tokens`}
          >
            <span className="contextMeter-track">
              <span
                className="contextMeter-fill"
                style={{ width: `${Math.min(100, Math.round((contextTokens / Math.max(1, contextLimit)) * 100))}%` }}
              />
            </span>
            <span className="contextMeter-text">{formatTokenCount(contextTokens)}</span>
          </span>
        ) : null}
      </div>
    </header>
  )
}
