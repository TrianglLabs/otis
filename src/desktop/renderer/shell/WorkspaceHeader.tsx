import { ChevronsLeft, Search, Settings, SquarePen } from "lucide-react"
import { Button, IconButton } from "../components/Button.js"
import { formatTokenCount } from "../format.js"
import { useI18n } from "../i18n/index.js"
import { useDesktop, useDesktopSelector, useDesktopState } from "../runtime.js"

/**
 * The compact bar above the conversation: session title centered, session metadata (diffs, context) plus search
 * and settings on the right. Session navigation lives in the ⌘K palette.
 */
export function WorkspaceHeader({
  hasCanvas,
  onOpenPalette,
  onOpenSettings,
}: {
  hasCanvas: boolean
  onOpenPalette: () => void
  onOpenSettings: () => void
}) {
  const { api } = useDesktop()
  const { locale, t } = useI18n()
  const state = useDesktopState(
    "diffs",
    "contextTokens",
    "contextLimit",
    "busy",
    "session",
    "subagents",
    "agentsPanelVisible",
  )
  const hasEntries = useDesktopSelector((snapshot) => (snapshot?.entries.length ?? 0) > 0)
  if (!state) return <header className="workspaceHeader" />

  const { diffs, contextTokens, contextLimit } = state

  return (
    <header className="workspaceHeader">
      <div className="workspaceHeader-left">
        {/* Only once a conversation exists — on the empty home screen, you are already at a fresh start. */}
        {hasEntries ? (
          <Button
            variant="ghost"
            icon={SquarePen}
            className="workspaceHeader-new noDrag"
            disabled={state.busy}
            title={state.busy ? t("header.finishBeforeStarting") : t("header.newSession")}
            onClick={() => void api.startNewSession()}
          >
            {t("header.freshStart")}
          </Button>
        ) : null}
      </div>

      {state.session ? <div className="workspaceHeader-title">{state.session.title}</div> : null}

      <div className="workspaceHeader-right">
        {diffs.added + diffs.removed > 0 ? (
          <span className="headerDiff noDrag" title={t("header.linesChanged")}>
            <span className="headerDiff-add">+{diffs.added}</span>
            <span className="headerDiff-remove">−{diffs.removed}</span>
          </span>
        ) : null}
        {hasEntries && contextTokens !== undefined ? (
          <span
            className="contextMeter noDrag"
            title={t("header.contextTokens", {
              used: contextTokens.toLocaleString(locale),
              limit: contextLimit.toLocaleString(locale),
            })}
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
          <IconButton icon={Search} label={t("header.searchSessions")} onClick={onOpenPalette} className="noDrag" />
          <IconButton icon={Settings} label={t("common.settings")} onClick={onOpenSettings} className="noDrag" />
          {/* Rightmost: it opens the rail that slides in from the right edge. */}
          {(state.subagents.length > 0 || hasCanvas) && !state.agentsPanelVisible ? (
            <IconButton
              icon={ChevronsLeft}
              label={t("header.showSidePanel")}
              onClick={() => void api.setAgentsPanelVisible(true)}
              className="noDrag"
            />
          ) : null}
        </div>
      </div>
    </header>
  )
}
