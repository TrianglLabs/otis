import { EventEmitter } from "node:events"
import { app, type BrowserWindow, dialog, type WebContents } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  guardFrameNavigation,
  handleRendererFailure,
  sendToRenderer,
} from "../../../src/desktop/main/renderer.js"

const mocks = vi.hoisted(() => ({
  showMessageBox:
    vi.fn<
      (
        window: BrowserWindow,
        options: Electron.MessageBoxOptions,
      ) => Promise<Electron.MessageBoxReturnValue>
    >(),
}))

vi.mock("electron", () => ({
  app: { quit: vi.fn() },
  dialog: { showMessageBox: mocks.showMessageBox, showErrorBox: vi.fn() },
}))

function setup() {
  const frame = { isDestroyed: vi.fn(() => false), detached: false, send: vi.fn() }
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    isCrashed: vi.fn(() => false),
    mainFrame: frame,
    reload: vi.fn(),
  })
  const window = { isDestroyed: vi.fn(() => false), webContents: contents }
  const onRendererGone = vi.fn()
  const isQuitting = vi.fn(() => false)
  handleRendererFailure(window as unknown as BrowserWindow, { onRendererGone, isQuitting })
  const crash = () => contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 5 })
  const send = () =>
    sendToRenderer(contents as unknown as WebContents, "otis:event", { type: "status" })
  return { frame, contents, window, onRendererGone, isQuitting, crash, send }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.showMessageBox.mockReset()
})

describe("renderer delivery", () => {
  it("sends to the current live main frame", () => {
    const { frame, send } = setup()
    expect(send()).toBe(true)
    expect(frame.send).toHaveBeenCalledWith("otis:event", { type: "status" })
  })

  it.each([
    "destroyed",
    "crashed",
    "frame-destroyed",
    "frame-detached",
  ])("skips a %s target", (state) => {
    const { contents, frame, send } = setup()
    if (state === "destroyed") contents.isDestroyed.mockReturnValue(true)
    if (state === "crashed") contents.isCrashed.mockReturnValue(true)
    if (state === "frame-destroyed") frame.isDestroyed.mockReturnValue(true)
    if (state === "frame-detached") frame.detached = true
    expect(send()).toBe(false)
    expect(frame.send).not.toHaveBeenCalled()
  })

  it("does not hide unrelated delivery errors", () => {
    const { frame, send } = setup()
    frame.send.mockImplementation(() => {
      throw new Error("invalid payload")
    })
    expect(send).toThrow("invalid payload")
  })
})

describe("renderer recovery", () => {
  it("stops execution immediately and reloads only after the user chooses", async () => {
    let choose!: (value: Electron.MessageBoxReturnValue) => void
    vi.mocked(dialog.showMessageBox).mockImplementation(
      () =>
        new Promise((resolve) => {
          choose = resolve
        }),
    )
    const { crash, onRendererGone, contents, send } = setup()
    contents.isCrashed.mockReturnValue(true)
    crash()
    expect(onRendererGone).toHaveBeenCalledOnce()
    expect(contents.reload).not.toHaveBeenCalled()
    expect(send()).toBe(false)
    choose({ response: 0, checkboxChecked: false })
    await vi.waitFor(() => expect(contents.reload).toHaveBeenCalledOnce())
    // A replacement renderer receives future updates; its initial state comes from the existing
    // snapshot API.
    contents.isCrashed.mockReturnValue(false)
    expect(send()).toBe(true)
    expect(onRendererGone).toHaveBeenCalledOnce()
  })

  it("coalesces recovery prompts, and offers recovery again for a later crash", async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false })
    const { crash, contents } = setup()
    crash()
    crash()
    expect(dialog.showMessageBox).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(contents.reload).toHaveBeenCalledOnce())
    crash()
    await vi.waitFor(() => expect(contents.reload).toHaveBeenCalledTimes(2))
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2)
  })

  it("quits instead of reloading when requested", async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false })
    const { crash, contents } = setup()
    crash()
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce())
    expect(contents.reload).not.toHaveBeenCalled()
  })

  it.each(["quitting", "closed"])("ignores crashes while %s", (state) => {
    const { crash, window, isQuitting, onRendererGone } = setup()
    if (state === "quitting") isQuitting.mockReturnValue(true)
    else window.isDestroyed.mockReturnValue(true)
    crash()
    expect(onRendererGone).not.toHaveBeenCalled()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it("does not reload a window closed while the recovery prompt was open", async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false })
    const { crash, contents, window } = setup()
    crash()
    window.isDestroyed.mockReturnValue(true)
    await Promise.resolve()
    expect(contents.reload).not.toHaveBeenCalled()
  })

  it("handles a missing dev server without exposing URLs or allowing work to continue", async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false })
    const { contents, onRendererGone } = setup()
    contents.emit("did-fail-load", {}, -102, "private error text", "http://private-url", true)
    expect(onRendererGone).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(contents.reload).toHaveBeenCalledOnce())
    const options = mocks.showMessageBox.mock.calls[0][1]
    expect(options.detail).toContain("dev server")
    expect(JSON.stringify(options)).not.toContain("private")
  })

  it("ignores aborted navigations and failed preview subframes", () => {
    const { contents, onRendererGone } = setup()
    contents.emit("did-fail-load", {}, -3, "aborted", "", true)
    contents.emit("did-fail-load", {}, -102, "failed", "", false)
    expect(onRendererGone).not.toHaveBeenCalled()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it("offers a clean exit if recovery itself fails", async () => {
    vi.mocked(dialog.showMessageBox).mockRejectedValue(new Error("native dialog unavailable"))
    const { crash } = setup()
    crash()
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce())
    expect(dialog.showErrorBox).toHaveBeenCalledOnce()
  })
})

describe("frame navigation", () => {
  it.each([
    ["file:///app/out/renderer/index.html", "file:///app/out/renderer/webpage.html"],
    ["http://localhost:5173/?demo", "http://localhost:5173/canvas.html"],
  ])("allows only the empty frame, srcdoc, and bundled preview documents from %s", (base, own) => {
    const { contents } = setup()
    guardFrameNavigation({ webContents: contents } as unknown as BrowserWindow, base)
    const navigate = (url: string, isMainFrame = false) => {
      const details = { url, isMainFrame, preventDefault: vi.fn() }
      contents.emit("will-frame-navigate", details)
      return !details.preventDefault.mock.calls.length
    }
    expect(navigate("about:blank")).toBe(true)
    expect(navigate("about:srcdoc")).toBe(true)
    expect(navigate(own)).toBe(true)
    expect(navigate("https://example.com/")).toBe(false)
    expect(navigate("file:///etc/passwd")).toBe(false)
    expect(navigate(`${own}?x=1`)).toBe(false)
    // The main frame keeps its own will-navigate handling.
    expect(navigate("https://example.com/", true)).toBe(true)
  })
})
