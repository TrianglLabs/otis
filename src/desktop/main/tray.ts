import { join } from "node:path"
import { Menu, type MenuItemConstructorOptions, type NativeImage, nativeImage, Tray } from "electron"
import type { DesktopStatus } from "../contracts.js"

/**
 * The macOS status bar item (menu bar extra). The icon is a glanceable activity signal — idle, working, or
 * "needs your approval" — and the menu carries the quick actions. State comes from the same status stream the
 * renderer sees, and the menu is rebuilt from a fresh snapshot at every open, so the tray never drifts from the
 * window. Window-bound by design: under the v1 close-to-quit policy the tray lives and dies with the window.
 */

/** Which template icon the tray shows. Template images are black + alpha; the system tints them per appearance. */
export type TrayIconKey = "idle" | "working" | "alert"

const TRAY_ICON_FILES: Record<TrayIconKey, { base: string; retina: string }> = {
  idle: { base: "otisIdleTemplate.png", retina: "otisIdleTemplate@2x.png" },
  working: { base: "otisWorkingTemplate.png", retina: "otisWorkingTemplate@2x.png" },
  alert: { base: "otisAlertTemplate.png", retina: "otisAlertTemplate@2x.png" },
}

export type TrayIconLocation = { packaged: boolean; resourcesPath: string; mainDir: string }

/** Mirrors appIconPath's root: bundled extraResources when packaged, the repo's resources/ directory in dev. */
export function trayIconDir(location: TrayIconLocation): string {
  const root = location.packaged ? location.resourcesPath : join(location.mainDir, "..", "..", "resources")
  return join(root, "tray")
}

/** The status subset that drives the glanceable state. */
export type TrayState = Pick<DesktopStatus, "busy" | "phase" | "permission" | "modelLoad" | "modelState">

/**
 * The glanceable state: a pending approval outranks activity, because an agent blocked on the user is the one
 * state that needs action. Model work (a turn, a local model booting, a download in flight) reads as working.
 */
export function trayIconKey(status: TrayState): TrayIconKey {
  if (status.permission) return "alert"
  if (status.busy || status.phase !== "idle") return "working"
  if (status.modelState === "starting") return "working"
  if (status.modelLoad?.status.kind === "progress") return "working"
  return "idle"
}

export function trayTooltip(status: TrayState): string {
  const key = trayIconKey(status)
  if (key === "alert") return "Otis — needs your approval"
  if (key === "working") {
    if (status.modelLoad?.status.kind === "progress" || status.modelState === "starting") {
      return "Otis — preparing a model"
    }
    return status.phase === "thinking" ? "Otis — thinking" : "Otis — working"
  }
  return "Otis — ready"
}

export type TrayActions = {
  focusWindow(): void
  startNewSession(): void
  stop(): void
  installUpdate(): void
}

/**
 * The menu template, pure data. The status block is informational (disabled rows); the actions are the things
 * worth doing without switching apps. Quiet by default: model-load progress and update rows only appear while
 * they are actually in flight.
 */
export function buildTrayMenu(status: DesktopStatus, actions: TrayActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  if (status.session) items.push({ label: status.session.title, enabled: false })
  items.push({ label: modelLabel(status), enabled: false })
  items.push({ label: status.workspace.label, enabled: false })
  if (status.contextTokens !== undefined) {
    items.push({
      label: `Context ${formatTokenCount(status.contextTokens)} of ${formatTokenCount(status.contextLimit)}`,
      enabled: false,
    })
  }
  if (status.modelLoad?.status.kind === "progress") {
    items.push({ label: status.modelLoad.status.label, enabled: false })
  }
  const runningCoworkers = status.subagents.filter((subagent) => subagent.status === "running").length
  if (runningCoworkers > 0) items.push({ label: `Coworkers: ${runningCoworkers} running`, enabled: false })

  items.push({ type: "separator" })
  if (status.permission) {
    items.push({ label: `Needs approval: ${status.permission.label}`, click: () => actions.focusWindow() })
  }
  // Mirrors the header button: a fresh start is refused mid-turn, so it is disabled while busy.
  items.push({ label: "Fresh start", enabled: !status.busy, click: () => actions.startNewSession() })
  if (status.busy) items.push({ label: "Stop working", click: () => actions.stop() })
  items.push({ label: "Show Otis", click: () => actions.focusWindow() })

  if (status.update.status === "ready" || status.update.status === "downloading") {
    items.push({ type: "separator" })
    items.push(
      status.update.status === "ready"
        ? { label: `Restart to update — ${status.update.version}`, click: () => actions.installUpdate() }
        : { label: `Downloading update — ${status.update.version}`, enabled: false },
    )
  }
  // role: quit routes through app.quit(), so the graceful before-quit shutdown still runs.
  items.push({ type: "separator" }, { role: "quit", label: "Quit Otis" })
  return items
}

function modelLabel(status: DesktopStatus): string {
  if (!status.model || status.modelState === "unconfigured") return "No model selected"
  if (status.modelState === "starting") return "Starting model…"
  if (status.modelState === "failed") return "Model failed to start"
  return `Model: ${status.model.displayName ?? shortModelId(status.model.id)}`
}

/** Mirrors formatTokenCount in the renderer (main must not import renderer modules). */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

/** Mirrors shortModelId in the renderer: `accounts/fireworks/models/x` → `x`. */
function shortModelId(id: string): string {
  const segments = id.split("/")
  return segments[segments.length - 1] ?? id
}

export type StatusTray = {
  /** Applies a status event to the icon and tooltip; cheap enough for every status flush. */
  onStatus(status: TrayState): void
  destroy(): void
}

/**
 * Orders the two writers that feed the status bar item: the live status stream and the one-shot seed snapshot.
 * The seed's `busy`/`phase` are captured before its session listing finishes resolving, so when a live status
 * lands while the seed is still in flight, the seed describes an older moment by the time it arrives — applying
 * it would drag the icon back to a stale state until the next event. Every live status applies; the seed applies
 * only while nothing live has been seen yet.
 */
export function trayStatusGate(tray: Pick<StatusTray, "onStatus">) {
  let live = false
  return {
    applyLive(status: TrayState) {
      live = true
      tray.onStatus(status)
    },
    applySeed(status: TrayState) {
      if (!live) tray.onStatus(status)
    },
  }
}

export type StatusTrayOptions = {
  iconDir: string
  /** Fresh state for each menu open; menus are rebuilt from it so they never go stale. */
  snapshot: () => Promise<DesktopStatus>
  actions: TrayActions
}

/**
 * Creates the status bar item, or undefined when the template images are missing (the tray is a convenience,
 * never a launch dependency — the same posture as the app icon). The menu opens on click and right-click; the
 * click handler rebuilds it from a snapshot first, so an open menu always reflects the moment it was opened.
 */
export function createStatusTray(options: StatusTrayOptions): StatusTray | undefined {
  const icons = loadTrayIcons(options.iconDir)
  if (!icons) {
    console.warn(`Unable to load the tray icons from ${options.iconDir}; the status bar item is disabled.`)
    return undefined
  }
  const tray = new Tray(icons.idle)
  tray.setToolTip("Otis — ready")
  tray.setIgnoreDoubleClickEvents(true)
  const openMenu = () => {
    void options
      .snapshot()
      .then((status) => tray.popUpContextMenu(Menu.buildFromTemplate(buildTrayMenu(status, options.actions))))
      .catch((error) => console.warn(`Unable to open the tray menu: ${String(error)}`))
  }
  tray.on("click", openMenu)
  tray.on("right-click", openMenu)
  return {
    onStatus(status) {
      tray.setImage(icons[trayIconKey(status)])
      tray.setToolTip(trayTooltip(status))
    },
    destroy() {
      tray.destroy()
    },
  }
}

function loadTrayIcons(dir: string): Record<TrayIconKey, NativeImage> | undefined {
  const icons = {} as Record<TrayIconKey, NativeImage>
  for (const [key, files] of Object.entries(TRAY_ICON_FILES) as [TrayIconKey, (typeof TRAY_ICON_FILES)["idle"]][]) {
    const base = nativeImage.createFromPath(join(dir, files.base))
    if (base.isEmpty()) return undefined
    const retina = nativeImage.createFromPath(join(dir, files.retina))
    if (!retina.isEmpty()) base.addRepresentation({ scaleFactor: 2, buffer: retina.toPNG() })
    base.setTemplateImage(true)
    icons[key] = base
  }
  return icons
}
