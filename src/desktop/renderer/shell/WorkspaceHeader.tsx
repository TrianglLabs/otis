import { ChevronsLeft, Search, Settings, SquarePen } from "lucide-react"
import { Button, IconButton } from "../components/Button.js"
import { formatTokenCount } from "../format.js"
import { useDesktop, useDesktopState } from "../runtime.js"

/**
 * The compact bar above the conversation: session title centered, session metadata (diffs, context) plus search
 * and settings on the right. Session navigation lives in the ⌘K palette.
 */
export function WorkspaceHeader({
  onOpenPalette,
  onOpenSettings,
}: {
  onOpenPalette: () => void
  onOpenSettings: () => void
}) {
  const { api } = useDesktop()
  const state = useDesktopState()
  if (!state) return <header className="workspaceHeader" />

  const { diffs, contextTokens, contextLimit } = state

  return (
    <header className="workspaceHeader">
      {/* Only once a conversation exists — on the empty home screen, you are already at a fresh start. */}
      {state.entries.length > 0 ? (
        <Button
          variant="ghost"
          icon={SquarePen}
          className="workspaceHeader-new noDrag"
          disabled={state.busy}
          title={state.busy ? "Finish the current work before starting over" : "New session (⌘N)"}
          onClick={() => void api.startNewSession()}
        >
          Fresh start
        </Button>
      ) : null}

      {state.session ? <div className="workspaceHeader-title">{state.session.title}</div> : null}

      <div className="workspaceHeader-right">
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
        <div className="workspaceHeader-actions">
          <IconButton icon={Search} label="Search sessions (⌘K)" onClick={onOpenPalette} className="noDrag" />
          <IconButton icon={Settings} label="Settings" onClick={onOpenSettings} className="noDrag" />
          {/* Rightmost: it opens the rail that slides in from the right edge. */}
          {state.subagents.length > 0 && !state.agentsPanelVisible ? (
            <IconButton
              icon={ChevronsLeft}
              label="Show coworkers panel"
              onClick={() => void api.setAgentsPanelVisible(true)}
              className="noDrag"
            />
          ) : null}
        </div>
      </div>
    </header>
  )
}
