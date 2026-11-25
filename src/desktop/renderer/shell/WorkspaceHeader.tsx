import {
  CalendarClock,
  ChevronsLeft,
  Folders,
  House,
  Monitor,
  Search,
  Settings,
  SquarePen,
  SquareTerminal,
} from "lucide-react"
import { Button, IconButton } from "../components/Button.js"
import { TabStrip } from "../components/TabStrip.js"
import { unseenRun } from "../features/routines/RoutinesHome.js"
import { useI18n } from "../i18n/index.js"
import { useDesktop, useDesktopSelector, useDesktopState } from "../runtime.js"
import { isChange } from "./WorkspacePanel.js"

/** What the home screen shows: recent work, the projects, or the routines. */
export type HomeView = "home" | "projects" | "routines"

/**
 * The compact bar above the conversation: session title centered (the Home / Projects / Routines control on
 * the home screen), the session's changed lines plus search and settings on the right. How full
 * the context is shows in the composer, beside the model it belongs to.
 * Session navigation lives in the ⌘K palette.
 */
export function WorkspaceHeader({
  hasViews,
  homeView,
  onHomeView,
  onOpenPalette,
  onOpenSettings,
  onOpenServer,
  onOpenTerminal,
}: {
  /** Canvas has a tab or the shell is open: the rail has something to show besides coworkers. */
  hasViews: boolean
  homeView: HomeView
  onHomeView: (view: HomeView) => void
  onOpenPalette: () => void
  onOpenSettings: () => void
  /** The Server row in Settings, where the daemon this window works on is changed. */
  onOpenServer: () => void
  onOpenTerminal: () => void
}) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const state = useDesktopState(
    "diffs",
    "session",
    "panes",
    "runtimes",
    "subagents",
    "agentsPanelVisible",
    "freshAchievements",
    "terminal",
    "remote",
    "routines",
  )
  const hasEntries = useDesktopSelector((snapshot) => (snapshot?.entries.length ?? 0) > 0)
  const hasChanges = useDesktopSelector((snapshot) => snapshot?.entries.some(isChange) ?? false)
  if (!state) return <header className="workspaceHeader" />

  const { diffs } = state
  const conversation = hasEntries || state.panes.length > 1
  const folder = foldersSpanned(state.runtimes)
    ? state.runtimes.find((entry) => entry.focused)?.workspace.label
    : undefined

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

      {conversation ? (
        state.session && state.panes.length === 1 ? (
          <div className="workspaceHeader-title">
            {state.session.title}
            {folder ? <span className="workspaceHeader-folder">{folder}</span> : null}
          </div>
        ) : null
      ) : (
        <div className="workspaceHeader-switch noDrag">
          <TabStrip
            tabs={[
              ["home", t("home.home"), House],
              ["projects", t("home.projects"), Folders],
              [
                "routines",
                <>
                  {t("home.routines")}
                  {state.routines.some(unseenRun) ? (
                    <span className="stateDot tabStrip-dot" />
                  ) : null}
                </>,
                CalendarClock,
              ],
            ]}
            selected={homeView}
            onSelect={onHomeView}
          />
        </div>
      )}

      <div className="workspaceHeader-right">
        {diffs.added + diffs.removed > 0 && state.panes.length === 1 ? (
          <span className="headerDiff noDrag" title={t("header.linesChanged")}>
            <span className="headerDiff-add">+{diffs.added}</span>
            <span className="headerDiff-remove">−{diffs.removed}</span>
          </span>
        ) : null}
        <div className="workspaceHeader-actions">
          {state.remote ? (
            <IconButton
              icon={Monitor}
              label={t("header.remote", { host: state.remote })}
              onClick={onOpenServer}
              className="noDrag"
            />
          ) : null}
          {/* Only with a conversation, until the shell runs, and only for the runtime in this
              app: a daemon has no shell to offer yet. */}
          {conversation && !state.terminal && !state.remote ? (
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
          {conversation &&
          (state.subagents.length > 0 || hasViews || hasChanges) &&
          !state.agentsPanelVisible ? (
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

/** Open sessions in more than one folder: each then says which it is in. */
export function foldersSpanned(runtimes: readonly { workspace: { path: string } }[]) {
  return new Set(runtimes.map((entry) => entry.workspace.path)).size > 1
}
