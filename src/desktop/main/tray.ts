import { join } from "node:path"
import {
  Menu,
  type MenuItemConstructorOptions,
  type NativeImage,
  nativeImage,
  Tray,
} from "electron"
import type { DesktopStatus } from "../contracts.js"

/**
 * The macOS status bar item (menu bar extra). The icon is a glanceable activity signal — idle,
 * working, or "needs your approval" — and the menu carries the quick actions. State comes from the
 * same status stream the renderer sees, and the menu is rebuilt from the latest status at every
 * open, so the tray never drifts from the window. Window-bound by design: under the v1
 * close-to-quit policy the tray lives and dies with the window.
 */

/** Which template icon the tray shows. Template images are black + alpha; the system tints them. */
type TrayIconKey = "idle" | "working" | "alert"

const TRAY_ICON_FILES: Record<TrayIconKey, string> = {
  idle: "otisIdleTemplate",
  working: "otisWorkingTemplate",
  alert: "otisAlertTemplate",
}

/**
 * Mirrors the app icon's root: bundled extraResources when packaged, the repo's resources/ in dev.
 */
export function trayIconDir(location: {
  packaged: boolean
  resourcesPath: string
  mainDir: string
}): string {
  const root = location.packaged
    ? location.resourcesPath
    : join(location.mainDir, "..", "..", "resources")
  return join(root, "tray")
}

/**
 * The glanceable state: a pending approval outranks activity, because an agent blocked on the user
 * is the one state that needs action. Model work (a turn in any open session, a local model
 * booting, a download in flight) reads as working.
 */
function trayIconKey(status: DesktopStatus): TrayIconKey {
  if (status.permission) return "alert"
  if (status.busy || status.working > 0 || status.phase !== "idle") return "working"
  if (status.modelState === "starting") return "working"
  if (status.modelLoad?.status.kind === "progress") return "working"
  return "idle"
}

type StatusTray = {
  /** Keeps menu state current and updates the native icon and tooltip only when they change. */
  onStatus(status: DesktopStatus): void
  destroy(): void
}

/**
 * Orders the two writers that feed the status bar item: the live status stream and the one-shot
 * seed snapshot. The seed's `busy`/`phase` are captured before its session listing finishes
 * resolving, so when a live status lands while the seed is still in flight, the seed describes an
 * older moment by the time it arrives — applying it would drag the icon back to a stale state until
 * the next event. Every live status applies; the seed applies only while nothing live has been seen
 * yet.
 */
export function trayStatusGate(tray: Pick<StatusTray, "onStatus">) {
  // Events carry what changed and are newer than any seed, so they overlay it whenever it lands;
  // the icon shows nothing until a whole status exists.
  let live: Partial<DesktopStatus> = {}
  let whole: DesktopStatus | undefined
  return {
    applyLive(status: Partial<DesktopStatus>) {
      live = { ...live, ...status }
      if (!whole) return
      whole = { ...whole, ...live }
      tray.onStatus(whole)
    },
    applySeed(status: DesktopStatus) {
      whole = { ...status, ...live }
      tray.onStatus(whole)
    },
  }
}

/**
 * Creates the status bar item, or undefined when the template images are missing (the tray is a
 * convenience, never a launch dependency — the same posture as the app icon). The menu opens on
 * click and right-click; the click handler uses the latest delivered status synchronously, without
 * a delayed popup or a session-history read.
 */
export function createStatusTray(options: {
  iconDir: string
  actions: {
    focusWindow(): void
    startNewSession(): void
    /** Stops the active session's turn, or a given session's. */
    stop(runtime?: number): void
    installUpdate(): void
    /** Shows an open session in the window. */
    focusSession(runtime: number): void
    /** Opens a session from history in the window. */
    openSession(id: string, dirName: string): void
    /** Opens a finished routine run's session in the window. */
    openSessionAt(workspacePath: string, sessionId: string, dirName?: string): void
    runRoutine(id: string): void
    respondToPermission(id: number, allow: boolean): void
  }
  appName?: string
}): StatusTray | undefined {
  const appName = options.appName ?? "Otis"
  const { actions } = options
  const icons = {} as Record<TrayIconKey, NativeImage>
  for (const [key, file] of Object.entries(TRAY_ICON_FILES) as [TrayIconKey, string][]) {
    const base = nativeImage.createFromPath(join(options.iconDir, `${file}.png`))
    if (base.isEmpty()) {
      console.warn(
        `Unable to load the tray icons from ${options.iconDir}; the status bar item is disabled.`,
      )
      return undefined
    }
    const retina = nativeImage.createFromPath(join(options.iconDir, `${file}@2x.png`))
    if (!retina.isEmpty()) base.addRepresentation({ scaleFactor: 2, buffer: retina.toPNG() })
    base.setTemplateImage(true)
    icons[key] = base
  }
  const tray = new Tray(icons.idle)
  let iconKey: TrayIconKey = "idle"
  let tooltip = `${appName} — ready`
  // The count beside the icon: sessions that finished while another was on screen.
  let badge = ""
  let latestStatus: DesktopStatus | undefined
  tray.setToolTip(tooltip)
  tray.setIgnoreDoubleClickEvents(true)
  // The menu template is rebuilt from the latest status at every open. Every row is something to
  // act on or wait for; nothing describes the state for its own sake. Quiet by default: model-load
  // progress and update rows only appear while they are in flight.
  const openMenu = () => {
    const status = latestStatus
    if (!status) {
      tray.popUpContextMenu(
        Menu.buildFromTemplate([
          { label: `Starting ${appName}…`, enabled: false },
          { label: `Show ${appName}`, click: () => actions.focusWindow() },
          { role: "quit", label: `Quit ${appName}` },
        ]),
      )
      return
    }
    const items: MenuItemConstructorOptions[] = []
    // Open sessions list as rows that show them.
    if (status.runtimes.length > 1) {
      for (const runtime of status.runtimes) {
        if (!runtime.session) continue
        const state = runtime.busy
          ? " — working"
          : !runtime.unseen
            ? ""
            : runtime.failed
              ? " — failed"
              : " — done"
        items.push({
          label: `${runtime.session.title}${state}`,
          type: "checkbox",
          checked: runtime.focused,
          click: () => actions.focusSession(runtime.runtime),
        })
      }
    } else if (status.session)
      items.push({ label: status.session.title, click: () => actions.focusWindow() })
    if (status.modelLoad?.status.kind === "progress") {
      items.push({ label: status.modelLoad.status.label, enabled: false })
    }
    // Routines run with nobody watching: the one due next, then finished runs not looked at yet,
    // which open their session. A run on now is listed with the sessions above.
    const due = status.routines
      .flatMap((routine) =>
        routine.runtime === undefined && routine.nextRunAt
          ? [{ name: routine.name, at: routine.nextRunAt }]
          : [],
      )
      .sort((a, b) => a.at.localeCompare(b.at))[0]
    if (due) {
      // Due today reads as a time; later carries its day. Mirrors the renderer's `when`.
      const date = new Date(due.at)
      const when = new Intl.DateTimeFormat(undefined, {
        ...(date.toDateString() === new Date().toDateString()
          ? {}
          : { month: "short", day: "numeric" }),
        hour: "numeric",
        minute: "2-digit",
      }).format(date)
      items.push({ label: `Next routine: ${due.name} · ${when}`, enabled: false })
    }
    for (const routine of status.routines) {
      const run = routine.lastRun
      if (!run?.finishedAt || run.seen || !run.sessionId) continue
      const { sessionId, dirName } = run
      const outcome =
        run.status === "error" ? "failed" : run.status === "interrupted" ? "stopped" : "done"
      items.push({
        label: `${routine.name} — ${outcome}`,
        click: () => actions.openSessionAt(routine.cwd, sessionId, dirName),
      })
    }
    if (items.length) items.push({ type: "separator" })
    // An approval is answered here; opening the window shows what it asks for.
    if (status.permission) {
      const { id, label } = status.permission
      items.push(
        { label: `Needs approval: ${label}`, click: () => actions.focusWindow() },
        { label: "Allow once", click: () => actions.respondToPermission(id, true) },
        { label: "Deny", click: () => actions.respondToPermission(id, false) },
        { type: "separator" },
      )
    }
    // The last few conversations not open in the window, from every workspace; one elsewhere
    // names its workspace.
    const recent = status.sessions.filter((item) => !item.open).slice(0, 3)
    if (recent.length) {
      items.push({ label: "Recent", enabled: false })
      for (const item of recent) {
        const where =
          item.workspaceLabel === status.workspace.label ? "" : ` — ${item.workspaceLabel}`
        items.push({
          label: `${item.title}${where}`,
          click: () => actions.openSession(item.id, item.dirName),
        })
      }
      items.push({ type: "separator" })
    }
    // A fresh start mid-turn opens beside the working session, as the header button does.
    items.push({ label: "Fresh start", click: () => actions.startNewSession() })
    // With several sessions open each working one stops on its own; alone, the active one does.
    if (status.runtimes.length > 1) {
      for (const runtime of status.runtimes.filter((entry) => entry.busy))
        items.push({
          label: `Stop ${runtime.session?.title ?? "new session"}`,
          click: () => actions.stop(runtime.runtime),
        })
    } else if (status.busy) items.push({ label: "Stop working", click: () => actions.stop() })
    if (status.routines.length)
      items.push({
        label: "Run routine",
        submenu: status.routines.map((routine) => ({
          label: routine.name,
          enabled: routine.runtime === undefined,
          click: () => actions.runRoutine(routine.id),
        })),
      })
    items.push({ label: `Show ${appName}`, click: () => actions.focusWindow() })

    if (status.update.status === "ready" || status.update.status === "downloading") {
      items.push({ type: "separator" })
      items.push(
        status.update.status === "ready"
          ? {
              label: `Restart to update — ${status.update.version}`,
              click: () => actions.installUpdate(),
            }
          : { label: `Downloading update — ${status.update.version}`, enabled: false },
      )
    }
    // role: quit routes through app.quit(), so the graceful before-quit shutdown still runs.
    items.push({ type: "separator" }, { role: "quit", label: `Quit ${appName}` })
    tray.popUpContextMenu(Menu.buildFromTemplate(items))
  }
  tray.on("click", openMenu)
  tray.on("right-click", openMenu)
  return {
    onStatus(status) {
      latestStatus = status
      const nextIconKey = trayIconKey(status)
      const preparing =
        status.modelLoad?.status.kind === "progress" || status.modelState === "starting"
      const working = status.working + (status.busy ? 1 : 0)
      const nextTooltip =
        nextIconKey === "alert"
          ? `${appName} — needs your approval`
          : nextIconKey === "idle"
            ? `${appName} — ready`
            : preparing
              ? `${appName} — preparing a model`
              : working > 1
                ? `${appName} — ${working} working`
                : status.phase === "thinking"
                  ? `${appName} — thinking`
                  : `${appName} — working`
      if (nextIconKey !== iconKey) {
        tray.setImage(icons[nextIconKey])
        iconKey = nextIconKey
      }
      if (nextTooltip !== tooltip) {
        tray.setToolTip(nextTooltip)
        tooltip = nextTooltip
      }
      const unseen = status.runtimes.filter((runtime) => runtime.unseen).length
      const nextBadge = unseen > 0 ? String(unseen) : ""
      if (nextBadge !== badge) {
        tray.setTitle(nextBadge)
        badge = nextBadge
      }
    },
    destroy() {
      tray.destroy()
    },
  }
}
