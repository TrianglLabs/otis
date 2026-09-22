import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dialog, ipcMain } from "electron"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DESKTOP_CHANNELS } from "../../../src/desktop/contracts.js"
import { registerDesktopIpc } from "../../../src/desktop/main/ipc.js"
import type { DesktopRuntime } from "../../../src/desktop/main/runtime.js"

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  BrowserWindow: { fromWebContents: () => undefined, getAllWindows: () => [] },
  shell: { openExternal: vi.fn() },
}))

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

/** The handler registered for a channel, invoked as our own renderer would. */
function handlerFor(channel: string, runtime: Partial<DesktopRuntime>) {
  vi.mocked(ipcMain.handle).mockClear()
  registerDesktopIpc(runtime as DesktopRuntime)
  const registered = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)?.[1] as
    | Handler
    | undefined
  if (!registered) throw new Error(`no handler for ${channel}`)
  const sender = { sender: {}, senderFrame: { url: "file:///app/out/renderer/index.html" } }
  return (...args: unknown[]) => registered(sender, ...args)
}

const directories: string[] = []
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("ELECTRON_RENDERER_URL", "")
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "otis-export-"))
  directories.push(root)
  return root
}

/** The native Save dialog resolves to `path`, or is cancelled when `path` is undefined. */
function saveDialogChooses(path: string | undefined) {
  vi.mocked(dialog.showSaveDialog).mockImplementationOnce(async () =>
    path ? { canceled: false, filePath: path } : { canceled: true, filePath: "" },
  )
}

describe("saveArtifact", () => {
  const save = (file: { name: string; bytes: Uint8Array } | undefined) =>
    handlerFor(DESKTOP_CHANNELS.saveArtifact, { getArtifactFile: async () => file })

  it("saves the exact captured bytes at the chosen path and replaces only the approved destination", async () => {
    const root = await setup()
    const path = join(root, "saved.docx")
    const file = { name: "original.docx", bytes: new Uint8Array([0x50, 0x4b, 0, 255, 17]) }
    await writeFile(path, "previous copy")
    saveDialogChooses(path)
    expect(await save(file)("artifact-1", 3)).toEqual({ ok: true })
    expect(dialog.showSaveDialog).toHaveBeenLastCalledWith(
      undefined,
      expect.objectContaining({
        defaultPath: "original.docx",
        filters: [{ name: "DOCX", extensions: ["docx"] }],
      }),
    )
    expect(await readFile(path)).toEqual(Buffer.from(file.bytes))
    expect(await readdir(root)).toEqual(["saved.docx"])
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it("cancels without writes and refuses extension changes without damaging an existing file", async () => {
    const root = await setup()
    const file = { name: "report.pdf", bytes: Buffer.from("captured PDF") }
    saveDialogChooses(undefined)
    expect(await save(file)("artifact-1", 3)).toEqual({ ok: true })
    expect(await readdir(root)).toEqual([])
    const path = join(root, "report.docx")
    await writeFile(path, "original Word file")
    saveDialogChooses(path)
    expect(await save(file)("artifact-1", 3)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("extension"),
    })
    expect(await readFile(path, "utf8")).toBe("original Word file")
  })

  it("cleans up a failed save and reports the failure", async () => {
    const root = await setup()
    const path = join(root, "directory.pdf")
    await mkdir(path)
    saveDialogChooses(path)
    expect(await save({ name: "report.pdf", bytes: Buffer.from("PDF") })("a", 1)).toMatchObject({
      ok: false,
    })
    expect(await readdir(root)).toEqual(["directory.pdf"])
    expect((await stat(path)).isDirectory()).toBe(true)
  })

  it("refuses a revision that no longer exists before opening any dialog", async () => {
    expect(await save(undefined)("artifact-1", 3)).toEqual({
      ok: false,
      reason: "This preview changed. Try saving the current version again.",
    })
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
  })

  it("validates the payload at the boundary", async () => {
    const file = { name: "report.pdf", bytes: Buffer.from("PDF") }
    await expect(save(file)("", 3)).rejects.toThrow("artifact id")
    await expect(save(file)("artifact-1", -1)).rejects.toThrow("numeric revision")
    await expect(save(file)("artifact-1", 1.5)).rejects.toThrow("numeric revision")
  })
})

it("rejects calls from anything but our own renderer", async () => {
  const handler = handlerFor(DESKTOP_CHANNELS.stop, { stop: async () => {} })
  await expect(handler()).resolves.toBeUndefined()
  const stop = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([name]) => name === DESKTOP_CHANNELS.stop)?.[1] as Handler
  for (const url of ["https://evil.example/index.html", "not a url", ""]) {
    expect(() => stop({ sender: {}, senderFrame: { url } })).toThrow("untrusted sender")
  }
})
