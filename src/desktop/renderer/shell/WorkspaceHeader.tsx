import { ChevronsLeft, Search, Settings, SquarePen, SquareTerminal } from "lucide-react"
import { Button, IconButton } from "../components/Button.js"
import { formatTokenCount } from "../format.js"
import { useI18n } from "../i18n/index.js"
import { useDesktop, useDesktopSelector, useDesktopState } from "../runtime.js"

/**
 * The compact bar above the conversation: session title centered, session metadata (diffs, context)
 * plus search and settings on the right. Session navigation lives in the ⌘K palette.
 */
export function WorkspaceHeader({
  hasViews,
  onOpenPalette,
  onOpenSettings,
  onOpenTerminal,
}: {
  /** Canvas has a tab or the shell is open: the rail has something to show besides coworkers. */
  hasViews: boolean
  onOpenPalette: () => void
  onOpenSettings: () => void
  onOpenTerminal: () => void
}) {
  const { api } = useDesktop()
  const { locale, t } = useI18n()
  const state = useDesktopState(
    "diffs",
    "contextTokens",
    "contextLimit",
    "session",
    "panes",
    "subagents",
    "agentsPanelVisible",
    "freshAchievements",
    "terminal",
  )
  const hasEntries = useDesktopSelector((snapshot) => (snapshot?.entries.length ?? 0) > 0)
  if (!state) return <header className="workspaceHeader" />

  const { diffs, contextTokens, contextLimit } = state
  const conversation = hasEntries || state.panes.length > 1
  const contextPercent =
    contextTokens === undefined
      ? 0
      : Math.min(100, Math.round((contextTokens / Math.max(1, contextLimit)) * 100))

  return (
    <header className="workspaceHeader">
      <div className="workspaceHeader-left">
        {/* Hidden on the empty single-card home screen, where you already are at a fresh start. */}
        {conversation ? (
          <Button
            variant="ghost"
            icon={SquarePen}
            className="workspaceHeader-new noDrag"
            title={t("header.newSession")}
            onClick={() => void api.startNewSession()}
          >
            {t("header.freshStart")}
          </Button>
        ) : null}
      </div>

      {state.session && state.panes.length === 1 ? (
        <div className="workspaceHeader-title">{state.session.title}</div>
      ) : null}

      <div className="workspaceHeader-right">
        {diffs.added + diffs.removed > 0 && state.panes.length === 1 ? (
          <span className="headerDiff noDrag" title={t("header.linesChanged")}>
            <span className="headerDiff-add">+{diffs.added}</span>
            <span className="headerDiff-remove">−{diffs.removed}</span>
          </span>
        ) : null}
        {hasEntries && contextTokens !== undefined && state.panes.length === 1 ? (
          <span
            className="contextMeter noDrag"
            title={t("header.contextTokens", {
              used: contextTokens.toLocaleString(locale),
              limit: contextLimit.toLocaleString(locale),
            })}
          >
            <span className="contextMeter-track">
              <span className="contextMeter-fill" style={{ width: `${contextPercent}%` }} />
            </span>
            <span className="contextMeter-text">{formatTokenCount(contextTokens)}</span>
          </span>
        ) : null}
        <div className="workspaceHeader-actions">
          {/* Only with a conversation, and only until the shell runs. */}
          {conversation && !state.terminal ? (
            <IconButton
              icon={SquareTerminal}
              label={t("header.openTerminal")}
              onClick={onOpenTerminal}
              className="noDrag"
            />
          ) : null}
          <IconButton
            icon={Search}
            label={t("header.searchSessions")}
            onClick={onOpenPalette}
            className="noDrag"
          />
          <IconButton
            icon={Settings}
            label={t("common.settings")}
            onClick={onOpenSettings}
            className={`noDrag${state.freshAchievements.length ? " iconBtn-dot" : ""}`}
          />
          {/* Rightmost: it opens the rail that slides in from the right edge; not on the home
              screen. */}
          {conversation && (state.subagents.length > 0 || hasViews) && !state.agentsPanelVisible ? (
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
