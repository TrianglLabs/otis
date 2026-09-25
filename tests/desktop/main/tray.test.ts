import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { inflateSync } from "node:zlib"
import {
  Menu,
  type MenuItemConstructorOptions,
  type NativeImage,
  nativeImage,
  Tray,
} from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  ALERT_DOT,
  renderTrayIcon,
  renderTrayIconAlpha,
  TRAY_ICON_SIZES,
  type TrayIconVariant,
} from "../../../scripts/tray-icon-render.js"
import type { DesktopStatus } from "../../../src/desktop/contracts.js"
import { createStatusTray, trayIconDir, trayStatusGate } from "../../../src/desktop/main/tray.js"
import { MARK_FACES, MARK_VIEWBOX, type MarkFace } from "../../../src/desktop/renderer/mark.js"

vi.mock("electron", () => {
  class Tray {
    static latest: Tray | undefined
    image: unknown
    on = vi.fn()
    setToolTip = vi.fn()
    setTitle = vi.fn()
    setIgnoreDoubleClickEvents = vi.fn()
    setImage = vi.fn()
    popUpContextMenu = vi.fn()
    destroy = vi.fn()
    constructor(image: unknown) {
      this.image = image
      Tray.latest = this
    }
  }
  return {
    Tray,
    Menu: { buildFromTemplate: vi.fn() },
    nativeImage: { createFromPath: vi.fn() },
  }
})

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))

type MockImage = {
  path: string
  isEmpty(): boolean
  addRepresentation: ReturnType<typeof vi.fn>
  setTemplateImage: ReturnType<typeof vi.fn>
  toPNG: () => Buffer
}

type MockTray = {
  image: unknown
  on: ReturnType<typeof vi.fn>
  setToolTip: ReturnType<typeof vi.fn>
  setTitle: ReturnType<typeof vi.fn>
  setIgnoreDoubleClickEvents: ReturnType<typeof vi.fn>
  setImage: ReturnType<typeof vi.fn>
  popUpContextMenu: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

type TrayActions = Parameters<typeof createStatusTray>[0]["actions"]

function latestTray(): MockTray {
  const tray = (Tray as unknown as { latest?: MockTray }).latest
  expect(tray).toBeDefined()
  return tray as MockTray
}

function installMissingIcons() {
  vi.mocked(nativeImage.createFromPath).mockImplementation(
    (path: string) => ({ path, isEmpty: () => true }) as unknown as NativeImage,
  )
}

function installMockIcons(): MockImage[] {
  const images: MockImage[] = []
  vi.mocked(nativeImage.createFromPath).mockImplementation((path: string) => {
    const image: MockImage = {
      path,
      isEmpty: () => false,
      addRepresentation: vi.fn(),
      setTemplateImage: vi.fn(),
      toPNG: () => Buffer.from(`png:${path}`),
    }
    images.push(image)
    return image as unknown as NativeImage
  })
  return images
}

/** A pending approval as the broker attributes it: the asking runtime and its session title. */
const approval = { resources: [], runtime: 1, sessionTitle: "Refactor" }

function statusFixture(overrides: Partial<DesktopStatus> = {}): DesktopStatus {
  return {
    busy: false,
    phase: "idle",
    speed: null,
    model: {
      id: "accounts/fireworks/models/kimi-k2",
      provider: "fireworks",
      supportsImageInput: false,
      displayName: "Kimi K2",
    },
    modelState: "ready",
    modelError: undefined,
    session: { id: "s1", title: "Fix session lock behavior" },
    artifacts: [],
    needsWorkspace: false,
    sessions: [],
    recentArtifacts: [],
    workspace: { label: "otis", path: "/Users/n/dev/otis" },
    contextTokens: 41_234,
    contextLimit: 200_000,
    diffs: { added: 12, removed: 3 },
    permission: null,
    permissionQueue: 0,
    runtimes: [],
    working: 0,
    panes: [],
    paneAxis: "row",
    stats: undefined,
    modelLoad: null,
    subagents: [],
    agentsPanelVisible: true,
    workspacePanelWidth: undefined,
    theme: "default",
    language: "system",
    thinkingVisible: true,
    notifyOnCompletion: true,
    permissionMode: "ask",
    localThinking: null,
    fastServing: { available: false, enabled: false },
    hostedConfigured: true,
    pairConfigured: false,
    pairEndpoints: {},
    debug: false,
    update: { status: "idle" },
    ...overrides,
  }
}

function actionsFixture(): TrayActions {
  return {
    focusWindow: vi.fn(),
    startNewSession: vi.fn(),
    stop: vi.fn(),
    installUpdate: vi.fn(),
    focusSession: vi.fn(),
    respondToPermission: vi.fn(),
  }
}

const byLabel = (items: MenuItemConstructorOptions[], label: string) =>
  items.find((item) => item.label === label)

/** Items without an explicit `enabled` are enabled — Electron's default; only `false` disables. */
const isEnabled = (item?: MenuItemConstructorOptions) => item?.enabled !== false

const click = (item?: MenuItemConstructorOptions) =>
  (item as { click?: () => void } | undefined)?.click?.()

/**
 * A mounted tray with real template icons, read back the way the status bar shows it: the icon
 * currently set, the tooltip, and the menu that a click opens for a given status.
 */
function mountTray(appName?: string) {
  installMockIcons()
  const actions = actionsFixture()
  const statusTray = createStatusTray({ iconDir: "/app/resources/tray", actions, appName })
  if (!statusTray) throw new Error("Expected a tray")
  const tray = latestTray()
  const iconName = (image: unknown) =>
    /otis(\w+)Template\.png$/.exec((image as MockImage).path)?.[1]?.toLowerCase()
  return {
    statusTray,
    tray,
    actions,
    /**
     * The icon variant currently shown: the last setImage, else the image the tray was built with.
     */
    icon: () => iconName(tray.setImage.mock.lastCall?.[0] ?? tray.image),
    tooltip: () => tray.setToolTip.mock.lastCall?.[0] as string,
    /** Applies the status (when given), opens the menu on click, and returns its template. */
    menu: (status?: DesktopStatus) => {
      if (status) statusTray.onStatus(status)
      const onClick = tray.on.mock.calls.find(([event]) => event === "click")?.[1] as () => void
      onClick()
      return (
        tray.popUpContextMenu.mock.lastCall?.[0] as { template: MenuItemConstructorOptions[] }
      ).template
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  installMissingIcons()
  vi.mocked(Menu.buildFromTemplate).mockImplementation(
    (template) => ({ template }) as unknown as Menu,
  )
  ;(Tray as unknown as { latest?: MockTray }).latest = undefined
})

describe("trayIconDir", () => {
  it("resolves the repo's resources/tray from the dev bundle in out/main", () => {
    const dir = trayIconDir({
      packaged: false,
      resourcesPath: "/unused",
      mainDir: join(repoRoot, "out", "main"),
    })
    expect(dir).toBe(join(repoRoot, "resources", "tray"))
    expect(existsSync(join(dir, "otisIdleTemplate.png"))).toBe(true)
  })

  it("resolves inside Electron's resources directory in a packaged build", () => {
    const resourcesPath = join("/Applications", "Otis.app", "Contents", "Resources")
    expect(
      trayIconDir({ packaged: true, resourcesPath, mainDir: join("/anywhere", "out", "main") }),
    ).toBe(join(resourcesPath, "tray"))
  })
})

describe("tray icon", () => {
  it("is idle when nothing is in flight", () => {
    const mounted = mountTray()
    mounted.statusTray.onStatus(statusFixture())
    expect(mounted.icon()).toBe("idle")
  })

  it("is working while a turn is busy or mid-phase", () => {
    for (const overrides of [
      { busy: true },
      { phase: "thinking" },
      { phase: "working" },
    ] as const) {
      const mounted = mountTray()
      mounted.statusTray.onStatus(statusFixture(overrides))
      expect(mounted.icon()).toBe("working")
    }
  })

  it("is working while the model boots or a download is in flight", () => {
    const booting = mountTray()
    booting.statusTray.onStatus(statusFixture({ modelState: "starting" }))
    expect(booting.icon()).toBe("working")
    const downloading = mountTray()
    downloading.statusTray.onStatus(
      statusFixture({
        modelLoad: { modelId: "m", status: { label: "Downloading…", kind: "progress" } },
      }),
    )
    expect(downloading.icon()).toBe("working")
  })

  it("shows the alert when a permission blocks the run, outranking active work", () => {
    const mounted = mountTray()
    mounted.statusTray.onStatus(
      statusFixture({
        busy: true,
        phase: "working",
        permission: {
          id: 4,
          label: "Edit src/app/conversation.ts",
          kind: "file_edit",
          resources: [],
          runtime: 1,
          sessionTitle: "Refactor",
        },
      }),
    )
    expect(mounted.icon()).toBe("alert")
  })

  it("treats a failed model load as quiet, not activity", () => {
    const mounted = mountTray()
    mounted.statusTray.onStatus(
      statusFixture({
        modelLoad: { modelId: "m", status: { label: "Failed: boom", kind: "error" } },
      }),
    )
    expect(mounted.icon()).toBe("idle")
  })
})

describe("tray tooltip", () => {
  it("tracks the glanceable state", () => {
    const cases: [Partial<DesktopStatus>, string][] = [
      [{}, "Otis — ready"],
      [{ busy: true, phase: "thinking" }, "Otis — thinking"],
      [{ busy: true, phase: "working" }, "Otis — working"],
      [{ modelState: "starting" }, "Otis — preparing a model"],
      [
        { modelLoad: { modelId: "m", status: { label: "Downloading…", kind: "progress" } } },
        "Otis — preparing a model",
      ],
      [
        { permission: { ...approval, id: 4, label: "Edit a file", kind: "file_edit" } },
        "Otis — needs your approval",
      ],
    ]
    for (const [overrides, expected] of cases) {
      const mounted = mountTray()
      mounted.statusTray.onStatus(statusFixture(overrides))
      expect(mounted.tooltip()).toBe(expected)
    }
  })
})

describe("tray menu", () => {
  it("leads with the session's informational state, all disabled", () => {
    const items = mountTray().menu(statusFixture())
    const labels = items.map((item) => item.label)
    expect(labels).toContain("Fix session lock behavior")
    expect(labels).toContain("Model: Kimi K2")
    expect(labels).toContain("otis")
    expect(labels).toContain("Context ~41.2k · Auto-compact at 200.0k")
    const firstSeparator = items.findIndex((item) => item.type === "separator")
    expect(firstSeparator).toBeGreaterThan(0)
    for (const item of items.slice(0, firstSeparator)) expect(item.enabled).toBe(false)
  })

  it("omits the context row until the session has one", () => {
    const items = mountTray().menu(statusFixture({ contextTokens: undefined }))
    expect(items.some((item) => item.label?.startsWith("Context"))).toBe(false)
  })

  it("describes the model by its short id when no display name is set", () => {
    const items = mountTray().menu(
      statusFixture({
        model: {
          id: "accounts/fireworks/models/kimi-k2",
          provider: "fireworks",
          supportsImageInput: false,
        },
      }),
    )
    expect(byLabel(items, "Model: kimi-k2")).toBeDefined()
  })

  it("says what is wrong instead of a model name during setup states", () => {
    const unconfigured = mountTray().menu(
      statusFixture({ model: null, modelState: "unconfigured" }),
    )
    expect(byLabel(unconfigured, "No model selected")).toBeDefined()
    const starting = mountTray().menu(statusFixture({ modelState: "starting" }))
    expect(byLabel(starting, "Starting model…")).toBeDefined()
    const failed = mountTray().menu(statusFixture({ modelState: "failed", modelError: "boom" }))
    expect(byLabel(failed, "Model failed to start")).toBeDefined()
  })

  it("offers fresh start, show, and quit — and nothing else when quiet", () => {
    const mounted = mountTray()
    const items = mounted.menu(statusFixture())
    const fresh = byLabel(items, "Fresh start")
    expect(isEnabled(fresh)).toBe(true)
    click(fresh)
    expect(mounted.actions.startNewSession).toHaveBeenCalledOnce()
    click(byLabel(items, "Show Otis"))
    expect(mounted.actions.focusWindow).toHaveBeenCalledOnce()
    expect(byLabel(items, "Stop working")).toBeUndefined()
    expect(items.some((item) => item.label?.startsWith("Needs approval"))).toBe(false)
    expect(items.some((item) => item.label?.startsWith("Coworkers"))).toBe(false)
    expect(items.some((item) => item.label?.startsWith("Restart to update"))).toBe(false)
    expect(items.some((item) => item.label?.startsWith("Downloading update"))).toBe(false)
    expect(items.at(-1)).toMatchObject({ role: "quit", label: "Quit Otis" })
  })

  it("keeps fresh start available mid-turn and offers stop", () => {
    const mounted = mountTray()
    const items = mounted.menu(statusFixture({ busy: true, phase: "working" }))
    expect(isEnabled(byLabel(items, "Fresh start"))).toBe(true)
    const stop = byLabel(items, "Stop working")
    expect(isEnabled(stop)).toBe(true)
    click(stop)
    expect(mounted.actions.stop).toHaveBeenCalledOnce()
    expect(mounted.actions.startNewSession).not.toHaveBeenCalled()
  })

  it("lists every open session as a row that shows it, marking work and completions", () => {
    const mounted = mountTray()
    const runtime = (
      runtime: number,
      title: string,
      extra: Partial<DesktopStatus["runtimes"][0]>,
    ) => ({
      runtime,
      session: { id: `s${runtime}`, title, dirName: "ws" },
      model: null,
      focused: false,
      busy: false,
      unseen: false,
      diffs: { added: 0, removed: 0 },
      contextTokens: 0,
      ...extra,
    })
    const status = statusFixture({
      runtimes: [
        runtime(1, "Refactor", { focused: true }),
        runtime(2, "Write tests", { busy: true }),
        runtime(3, "Docs", { unseen: true }),
      ],
      working: 1,
    })
    const items = mounted.menu(status)
    expect(byLabel(items, "Refactor")).toMatchObject({ type: "checkbox", checked: true })
    expect(byLabel(items, "Write tests — working")).toMatchObject({ checked: false })
    click(byLabel(items, "Docs — done"))
    expect(mounted.actions.focusSession).toHaveBeenCalledExactlyOnceWith(3)
    // Each working session stops on its own; the lone "Stop working" item is for a single one.
    expect(byLabel(items, "Stop working")).toBeUndefined()
    click(byLabel(items, "Stop Write tests"))
    expect(mounted.actions.stop).toHaveBeenCalledExactlyOnceWith(2)
    // The lone-session name row is replaced by the rows.
    expect(byLabel(items, "Fix session lock behavior")).toBeUndefined()
    // Background work keeps the icon working and counts in the tooltip; the badge counts finishes.
    expect(mounted.icon()).toBe("working")
    expect(mounted.tooltip()).toBe("Otis — working")
    expect(mounted.tray.setTitle).toHaveBeenLastCalledWith("1")
    mounted.statusTray.onStatus({ ...status, busy: true, phase: "working" })
    expect(mounted.tooltip()).toBe("Otis — 2 working")
    mounted.statusTray.onStatus(statusFixture())
    expect(mounted.icon()).toBe("idle")
    expect(mounted.tray.setTitle).toHaveBeenLastCalledWith("")
  })

  it("surfaces a pending permission as the action that needs the user", () => {
    const mounted = mountTray()
    const items = mounted.menu(
      statusFixture({
        busy: true,
        phase: "working",
        permission: {
          id: 4,
          label: "Edit src/app/conversation.ts",
          kind: "file_edit",
          resources: [],
          runtime: 1,
          sessionTitle: "Refactor",
        },
      }),
    )
    const approval = byLabel(items, "Needs approval: Edit src/app/conversation.ts")
    expect(isEnabled(approval)).toBe(true)
    click(approval)
    expect(mounted.actions.focusWindow).toHaveBeenCalledOnce()
    // The answer itself is one click away, without switching apps.
    click(byLabel(items, "Allow once"))
    click(byLabel(items, "Deny"))
    expect(vi.mocked(mounted.actions.respondToPermission).mock.calls).toEqual([
      [4, true],
      [4, false],
    ])
  })

  it("reports model download progress while it is in flight", () => {
    const items = mountTray().menu(
      statusFixture({
        modelLoad: {
          modelId: "qwen3-30b-a3b",
          status: { label: "Downloading Qwen3 30B A3B — 42%", kind: "progress" },
        },
      }),
    )
    expect(byLabel(items, "Downloading Qwen3 30B A3B — 42%")?.enabled).toBe(false)
  })

  it("counts only running coworkers", () => {
    const items = mountTray().menu(
      statusFixture({
        subagents: [
          { toolCallId: "t1", title: "Check session lock behavior", status: "running", tools: 3 },
          { toolCallId: "t2", title: "Audit storage writes", status: "running", tools: 1 },
          {
            toolCallId: "t0",
            title: "Map the workspace",
            status: "complete",
            durationMs: 4_100,
            tools: 2,
          },
        ],
      }),
    )
    expect(byLabel(items, "Coworkers: 2 running")?.enabled).toBe(false)
  })

  it("offers to restart into a ready update", () => {
    const mounted = mountTray()
    const items = mounted.menu(statusFixture({ update: { status: "ready", version: "0.2.0" } }))
    const restart = byLabel(items, "Restart to update — 0.2.0")
    expect(isEnabled(restart)).toBe(true)
    click(restart)
    expect(mounted.actions.installUpdate).toHaveBeenCalledOnce()
  })

  it("shows a disabled row while an update downloads, with no install action", () => {
    const mounted = mountTray()
    const items = mounted.menu(
      statusFixture({ update: { status: "downloading", version: "0.2.0" } }),
    )
    expect(byLabel(items, "Downloading update — 0.2.0")?.enabled).toBe(false)
    click(byLabel(items, "Downloading update — 0.2.0"))
    expect(mounted.actions.installUpdate).not.toHaveBeenCalled()
  })
})

describe("createStatusTray", () => {
  it("keeps development tray actions and status distinguishable from the installed app", () => {
    installMockIcons()
    const statusTray = createStatusTray({
      iconDir: "/app/resources/tray",
      actions: actionsFixture(),
      appName: "Otis Dev",
    })
    const tray = latestTray()
    expect(tray.setToolTip).toHaveBeenCalledWith("Otis Dev — ready")
    const openMenu = tray.on.mock.calls.find(([event]) => event === "click")?.[1]
    openMenu()
    expect(vi.mocked(Menu.buildFromTemplate).mock.lastCall?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Starting Otis Dev…" }),
        expect.objectContaining({ label: "Show Otis Dev" }),
        expect.objectContaining({ label: "Quit Otis Dev" }),
      ]),
    )
    statusTray?.onStatus(statusFixture({ busy: true, phase: "working" }))
    expect(tray.setToolTip).toHaveBeenLastCalledWith("Otis Dev — working")
    openMenu()
    expect(vi.mocked(Menu.buildFromTemplate).mock.lastCall?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Show Otis Dev" }),
        expect.objectContaining({ label: "Quit Otis Dev" }),
      ]),
    )
    statusTray?.destroy()
  })

  it("is a loud no-op when the template icons are missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const tray = createStatusTray({
        iconDir: "/missing",
        actions: actionsFixture(),
      })
      expect(tray).toBeUndefined()
      expect(warn).toHaveBeenCalledOnce()
      expect((Tray as unknown as { latest?: MockTray }).latest).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  it("builds the tray from the idle icon, marked as template with retina representations", () => {
    const images = installMockIcons()
    expect(
      createStatusTray({
        iconDir: "/app/resources/tray",
        actions: actionsFixture(),
      }),
    ).toBeDefined()
    const tray = latestTray()
    expect((tray.image as MockImage).path).toBe("/app/resources/tray/otisIdleTemplate.png")
    expect(tray.setToolTip).toHaveBeenCalledExactlyOnceWith("Otis — ready")
    expect(tray.setIgnoreDoubleClickEvents).toHaveBeenCalledExactlyOnceWith(true)
    for (const file of ["otisIdleTemplate", "otisWorkingTemplate", "otisAlertTemplate"]) {
      const base = images.find((image) => image.path === `/app/resources/tray/${file}.png`)
      const retina = images.find((image) => image.path === `/app/resources/tray/${file}@2x.png`)
      expect(base).toBeDefined()
      expect(retina).toBeDefined()
      expect(base?.setTemplateImage).toHaveBeenCalledExactlyOnceWith(true)
      expect(base?.addRepresentation).toHaveBeenCalledExactlyOnceWith({
        scaleFactor: 2,
        buffer: Buffer.from(`png:/app/resources/tray/${file}@2x.png`),
      })
    }
  })

  it("opens menus synchronously from the latest status on click and right-click", () => {
    installMockIcons()
    const statusTray = createStatusTray({
      iconDir: "/app/resources/tray",
      actions: actionsFixture(),
    })
    expect(statusTray).toBeDefined()
    const tray = latestTray()
    const onClick = tray.on.mock.calls.find(([event]) => event === "click")?.[1] as () => void
    const onRightClick = tray.on.mock.calls.find(
      ([event]) => event === "right-click",
    )?.[1] as () => void
    expect(onClick).toBeTypeOf("function")
    expect(onRightClick).toBeTypeOf("function")
    statusTray?.onStatus(statusFixture())
    onClick()
    expect(tray.popUpContextMenu).toHaveBeenCalledOnce()
    expect(Menu.buildFromTemplate).toHaveBeenCalledOnce()
    const firstMenu = tray.popUpContextMenu.mock.lastCall?.[0] as {
      template: MenuItemConstructorOptions[]
    }
    expect(firstMenu.template.map((item) => item.label)).toContain("Fix session lock behavior")

    // Menu-only changes must be retained even when the icon and tooltip stay idle.
    statusTray?.onStatus(statusFixture({ session: { id: "s2", title: "Latest session" } }))
    expect(Menu.buildFromTemplate).toHaveBeenCalledOnce()
    onRightClick()
    expect(tray.popUpContextMenu).toHaveBeenCalledTimes(2)
    const secondMenu = tray.popUpContextMenu.mock.lastCall?.[0] as {
      template: MenuItemConstructorOptions[]
    }
    expect(secondMenu.template.map((item) => item.label)).toContain("Latest session")
    expect(secondMenu.template.map((item) => item.label)).not.toContain("Fix session lock behavior")
    expect(tray.setImage).not.toHaveBeenCalled()
    expect(tray.setToolTip).toHaveBeenCalledOnce()
  })

  it("offers safe startup actions before the initial status arrives", () => {
    installMockIcons()
    const actions = actionsFixture()
    createStatusTray({ iconDir: "/app/resources/tray", actions })
    const tray = latestTray()
    const onClick = tray.on.mock.calls.find(([event]) => event === "click")?.[1] as () => void
    onClick()
    expect(tray.popUpContextMenu).toHaveBeenCalledOnce()
    const menu = tray.popUpContextMenu.mock.lastCall?.[0] as {
      template: MenuItemConstructorOptions[]
    }
    expect(byLabel(menu.template, "Starting Otis…")?.enabled).toBe(false)
    expect(byLabel(menu.template, "Fresh start")).toBeUndefined()
    expect(byLabel(menu.template, "Quit Otis")?.role).toBe("quit")
    click(byLabel(menu.template, "Show Otis"))
    expect(actions.focusWindow).toHaveBeenCalledOnce()
  })

  it("does not rewrite the native icon or tooltip for repeated status flushes", () => {
    installMockIcons()
    const statusTray = createStatusTray({
      iconDir: "/app/resources/tray",
      actions: actionsFixture(),
    })
    const tray = latestTray()
    for (let i = 0; i < 100; i++) statusTray?.onStatus(statusFixture({ contextTokens: i }))
    expect(tray.setImage).not.toHaveBeenCalled()
    expect(tray.setToolTip).toHaveBeenCalledExactlyOnceWith("Otis — ready")

    for (let i = 0; i < 100; i++)
      statusTray?.onStatus(statusFixture({ busy: true, phase: "thinking" }))
    expect(tray.setImage).toHaveBeenCalledOnce()
    expect(tray.setToolTip).toHaveBeenCalledTimes(2)
    expect(tray.setToolTip).toHaveBeenLastCalledWith("Otis — thinking")

    // Thinking and working share an icon, but have different tooltips.
    statusTray?.onStatus(statusFixture({ busy: true, phase: "working" }))
    expect(tray.setImage).toHaveBeenCalledOnce()
    expect(tray.setToolTip).toHaveBeenCalledTimes(3)
    expect(tray.setToolTip).toHaveBeenLastCalledWith("Otis — working")

    statusTray?.onStatus(statusFixture())
    expect(tray.setImage).toHaveBeenCalledTimes(2)
    expect(tray.setToolTip).toHaveBeenCalledTimes(4)
    expect(tray.setToolTip).toHaveBeenLastCalledWith("Otis — ready")
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it("keeps menu state from regressing when the seed arrives after a live status", () => {
    installMockIcons()
    const statusTray = createStatusTray({
      iconDir: "/app/resources/tray",
      actions: actionsFixture(),
    })
    if (!statusTray) throw new Error("Expected a tray")
    const gate = trayStatusGate(statusTray)
    gate.applyLive(statusFixture({ busy: true, session: { id: "s2", title: "Current session" } }))
    gate.applySeed(statusFixture())
    const tray = latestTray()
    const onClick = tray.on.mock.calls.find(([event]) => event === "click")?.[1] as () => void
    onClick()
    const menu = tray.popUpContextMenu.mock.lastCall?.[0] as {
      template: MenuItemConstructorOptions[]
    }
    expect(menu.template.map((item) => item.label)).toContain("Current session")
    expect(byLabel(menu.template, "Stop working")).toBeDefined()
  })

  it("swaps icon and tooltip as the status stream changes", () => {
    const images = installMockIcons()
    const statusTray = createStatusTray({
      iconDir: "/app/resources/tray",
      actions: actionsFixture(),
    })
    const tray = latestTray()
    statusTray?.onStatus(statusFixture({ busy: true, phase: "working" }))
    const workingImage = images.find((image) => image.path.endsWith("otisWorkingTemplate.png"))
    expect(workingImage).toBeDefined()
    expect(tray.setImage).toHaveBeenCalledExactlyOnceWith(workingImage)
    expect(tray.setToolTip).toHaveBeenLastCalledWith("Otis — working")
    statusTray?.onStatus(
      statusFixture({
        busy: true,
        phase: "working",
        permission: {
          id: 4,
          label: "Edit src/app/conversation.ts",
          kind: "file_edit",
          resources: [],
          runtime: 1,
          sessionTitle: "Refactor",
        },
      }),
    )
    const alertImage = images.find((image) => image.path.endsWith("otisAlertTemplate.png"))
    expect(alertImage).toBeDefined()
    expect(tray.setImage).toHaveBeenLastCalledWith(alertImage)
    expect(tray.setToolTip).toHaveBeenLastCalledWith("Otis — needs your approval")
  })
})

describe("trayStatusGate", () => {
  /**
   * Records the icon each applied status shows on a real tray, the way the desktop main drives it.
   */
  function recordingTray() {
    const mounted = mountTray()
    const icons: string[] = []
    const tray = {
      onStatus(status: DesktopStatus) {
        mounted.statusTray.onStatus(status)
        icons.push(mounted.icon() ?? "")
      },
    }
    return { icons, tray }
  }

  const liveCases: Array<{ live: string; overrides: Partial<DesktopStatus>; icon: string }> = [
    { live: "status", overrides: { phase: "thinking" }, icon: "working" },
    {
      live: "approval request",
      overrides: { permission: { ...approval, id: 4, label: "Edit a file", kind: "file_edit" } },
      icon: "alert",
    },
  ]

  it.each(
    liveCases,
  )("drops a seed that resolves after a live $live, keeping the newer $icon icon", ({
    overrides,
    icon,
  }) => {
    const { icons, tray } = recordingTray()
    const gate = trayStatusGate(tray)
    // The seed's busy/phase were captured before the turn started, so it is stale by the time it
    // resolves.
    const staleSeed = statusFixture()
    gate.applyLive(statusFixture(overrides))
    gate.applySeed(staleSeed)
    expect(icons).toEqual([icon])
  })

  it("applies every live status; only a pre-live seed applies, and only once", () => {
    const { icons, tray } = recordingTray()
    const gate = trayStatusGate(tray)
    gate.applySeed(statusFixture())
    gate.applyLive(statusFixture({ phase: "thinking" }))
    gate.applySeed(statusFixture()) // a second seed is stale by construction and must be ignored
    gate.applyLive(statusFixture())
    expect(icons).toEqual(["idle", "working", "idle"])
  })
})

const iconCases = [
  { variant: "idle" as TrayIconVariant, label: "1×", size: TRAY_ICON_SIZES.base, suffix: "" },
  { variant: "idle" as TrayIconVariant, label: "2×", size: TRAY_ICON_SIZES.retina, suffix: "@2x" },
  { variant: "working" as TrayIconVariant, label: "1×", size: TRAY_ICON_SIZES.base, suffix: "" },
  {
    variant: "working" as TrayIconVariant,
    label: "2×",
    size: TRAY_ICON_SIZES.retina,
    suffix: "@2x",
  },
  { variant: "alert" as TrayIconVariant, label: "1×", size: TRAY_ICON_SIZES.base, suffix: "" },
  { variant: "alert" as TrayIconVariant, label: "2×", size: TRAY_ICON_SIZES.retina, suffix: "@2x" },
]

const iconName = (case_: (typeof iconCases)[number]) =>
  `otis${case_.variant.charAt(0).toUpperCase()}${case_.variant.slice(1)}Template${case_.suffix}.png`

describe("committed tray icons", () => {
  it.each(iconCases)("otis $variant ($label) matches the generator byte-for-byte", (case_) => {
    const committed = readFileSync(join(repoRoot, "resources", "tray", iconName(case_)))
    expect(committed.equals(renderTrayIcon(case_.size, case_.variant))).toBe(true)
    expect(committed.readUInt32BE(16)).toBe(case_.size.width)
    expect(committed.readUInt32BE(20)).toBe(case_.size.height)
  })

  it.each(
    iconCases,
  )("otis $variant ($label) is a template image: black pixels, artwork present", (case_) => {
    const { width, height, rgba } = decodePng(
      readFileSync(join(repoRoot, "resources", "tray", iconName(case_))),
    )
    expect(width).toBe(case_.size.width)
    expect(height).toBe(case_.size.height)
    const nonBlack: number[] = []
    let opaque = 0
    for (let pixel = 0; pixel < width * height; pixel++) {
      if (rgba[pixel * 4 + 3] === 0) continue
      opaque += 1
      if (rgba[pixel * 4] !== 0 || rgba[pixel * 4 + 1] !== 0 || rgba[pixel * 4 + 2] !== 0)
        nonBlack.push(pixel)
    }
    expect(nonBlack).toEqual([])
    expect(opaque).toBeGreaterThan(0)
  })
})

/**
 * Minimal PNG reader for the committed assets: filter-free RGBA scanlines, exactly what the
 * generator emits.
 */
function decodePng(bytes: Buffer): { width: number; height: number; rgba: Buffer } {
  expect(
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ).toBe(true)
  let offset = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString("ascii", offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
    } else if (type === "IDAT") {
      idat.push(data)
    }
    offset += 12 + length
  }
  const inflated = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const rgba = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    expect(inflated[y * (stride + 1)]).toBe(0) // filter type: none
    inflated.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return { width, height, rgba }
}

describe("tray icon artwork", () => {
  const size = { width: TRAY_ICON_SIZES.retina.width, height: TRAY_ICON_SIZES.retina.height }
  const scale = Math.min(size.width / MARK_VIEWBOX.width, size.height / MARK_VIEWBOX.height)
  const offsetX = (size.width - MARK_VIEWBOX.width * scale) / 2
  const offsetY = (size.height - MARK_VIEWBOX.height * scale) / 2

  const alpha = (variant: TrayIconVariant) => renderTrayIconAlpha(size, variant)
  const alphaAt = (grid: Uint8Array, x: number, y: number) => grid[y * size.width + x]

  const pixelForViewBox = (vx: number, vy: number) => ({
    x: Math.floor(vx * scale + offsetX),
    y: Math.floor(vy * scale + offsetY),
  })

  const facePixel = (face: MarkFace, localX: number, localY: number) => {
    const [a, b, c, d, e, f] = face.matrix
    return pixelForViewBox(a * localX + c * localY + e, b * localX + d * localY + f)
  }

  it("idle draws the O open: the front face's center cell is empty, its ring solid", () => {
    const idle = alpha("idle")
    const hole = facePixel(MARK_FACES.front, 30, 30)
    const ring = facePixel(MARK_FACES.front, 30, 50)
    expect(alphaAt(idle, hole.x, hole.y)).toBe(0)
    expect(alphaAt(idle, ring.x, ring.y)).toBe(255)
  })

  it("working flattens the cube: the O closes and the 45% left face renders solid", () => {
    const idle = alpha("idle")
    const working = alpha("working")
    const hole = facePixel(MARK_FACES.front, 30, 30)
    expect(alphaAt(working, hole.x, hole.y)).toBe(255)
    const shade = facePixel(MARK_FACES.left, 30, 30)
    expect(alphaAt(idle, shade.x, shade.y)).toBe(115) // the left face's 0.45 opacity
    expect(alphaAt(working, shade.x, shade.y)).toBe(255)
  })

  it("alert adds a solid badge where the plain mark is empty", () => {
    const dot = pixelForViewBox(ALERT_DOT.cx, ALERT_DOT.cy)
    expect(alphaAt(alpha("idle"), dot.x, dot.y)).toBe(0)
    expect(alphaAt(alpha("alert"), dot.x, dot.y)).toBe(255)
  })

  it("alert's transparent ring punches through the cube around the badge", () => {
    const idle = alpha("idle")
    const alert = alpha("alert")
    let punched = 0
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        if (alphaAt(idle, x, y) === 255 && alphaAt(alert, x, y) === 0) punched += 1
      }
    }
    expect(punched).toBeGreaterThan(2)
  })

  it("alert changes nothing outside the badge and its ring", () => {
    const idle = alpha("idle")
    const alert = alpha("alert")
    // A 2px halo around the badge absorbs anti-aliasing bleed; beyond it the grids must be
    // identical.
    const guard = ALERT_DOT.radius + ALERT_DOT.border + 2 / scale
    const changed: number[] = []
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        const vx = (x + 0.5 - offsetX) / scale
        const vy = (y + 0.5 - offsetY) / scale
        if ((vx - ALERT_DOT.cx) ** 2 + (vy - ALERT_DOT.cy) ** 2 <= guard ** 2) continue
        if (alphaAt(idle, x, y) !== alphaAt(alert, x, y)) changed.push(y * size.width + x)
      }
    }
    expect(changed).toEqual([])
  })
})
