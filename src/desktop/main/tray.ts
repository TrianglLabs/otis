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

/** Mirrors formatTokenCount in the renderer (main must not import renderer modules). */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
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
  let live = false
  return {
    applyLive(status: DesktopStatus) {
      live = true
      tray.onStatus(status)
    },
    applySeed(status: DesktopStatus) {
      if (!live) tray.onStatus(status)
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
  // The menu template is rebuilt from the latest status at every open. The status block is
  // informational (disabled rows); the actions are the things worth doing without switching apps.
  // Quiet by default: model-load progress and update rows only appear while they are in flight.
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
    // Several open sessions list as rows that show them; a lone session is just named.
    if (status.runtimes.length > 1) {
      for (const runtime of status.runtimes) {
        if (!runtime.session) continue
        const state = runtime.busy ? " — working" : runtime.unseen ? " — done" : ""
        items.push({
          label: `${runtime.session.title}${state}`,
          type: "checkbox",
          checked: runtime.focused,
          click: () => actions.focusSession(runtime.runtime),
        })
      }
    } else if (status.session) items.push({ label: status.session.title, enabled: false })
    // Mirrors shortModelId in the renderer (main must not import renderer modules):
    // `accounts/.../x` → `x`.
    const model = status.model
    const modelLabel =
      !model || status.modelState === "unconfigured"
        ? "No model selected"
        : status.modelState === "starting"
          ? "Starting model…"
          : status.modelState === "failed"
            ? "Model failed to start"
            : `Model: ${model.displayName ?? model.id.split("/").at(-1) ?? model.id}`
    items.push({ label: modelLabel, enabled: false })
    items.push({ label: status.workspace.label, enabled: false })
    if (status.contextTokens !== undefined) {
      const context = formatTokenCount(status.contextTokens)
      const limit = formatTokenCount(status.contextLimit)
      items.push({ label: `Context ~${context} · Auto-compact at ${limit}`, enabled: false })
    }
    if (status.modelLoad?.status.kind === "progress") {
      items.push({ label: status.modelLoad.status.label, enabled: false })
    }
    const runningCoworkers = status.subagents.filter(
      (subagent) => subagent.status === "running",
    ).length
    if (runningCoworkers > 0)
      items.push({ label: `Coworkers: ${runningCoworkers} running`, enabled: false })

    items.push({ type: "separator" })
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
