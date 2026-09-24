import { afterEach, describe, expect, it, vi } from "vitest"
import type { ArtifactMetadata } from "../../../src/artifacts/types.js"
import { createDemoRuntime } from "../../../src/desktop/renderer/demo/demo-runtime.js"
import type { LocalPickerChoice } from "../../../src/inference/picker-catalog.js"

/** The Canvas tab in view: the one that last took it. */
function shown(snapshot: { artifacts: { artifact: ArtifactMetadata; activated: number }[] }) {
  return snapshot.artifacts.reduce<(typeof snapshot.artifacts)[number] | undefined>(
    (best, tab) => (!best || tab.activated > best.activated ? tab : best),
    undefined,
  )?.artifact
}

const QWEN_27B = "Qwen/Qwen3.8-27B"

async function localRow(
  api: ReturnType<typeof createDemoRuntime>,
  id: string,
): Promise<LocalPickerChoice> {
  const row = (await api.listModels()).find(
    (entry): entry is LocalPickerChoice =>
      entry.kind === "model" && entry.provider === "local" && entry.id === id,
  )
  if (!row) throw new Error(`Local model ${id} is missing from the demo catalog`)
  return row
}

/** Runs a demo operation whose simulated delays are on fake timers to completion. */
async function settle<T>(operation: Promise<T>) {
  await vi.runAllTimersAsync()
  return operation
}

describe("demo runtime sessions", () => {
  it("brings a session off screen into the focused card when its chip is clicked", async () => {
    const api = createDemoRuntime()
    const before = await api.getSnapshot()
    const hidden = before.runtimes.find((entry) => !before.panes.includes(entry.runtime))
    if (!hidden) throw new Error("The demo should list sessions off screen")
    await api.focusSession(hidden.runtime)
    const after = await api.getSnapshot()
    expect(after.panes).toEqual([hidden.runtime])
    expect(after.session?.id).toBe(hidden.session?.id)
    expect(after.runtimes.find((entry) => entry.focused)?.runtime).toBe(hidden.runtime)
  })
})

describe("demo runtime model lifecycle", () => {
  afterEach(() => vi.useRealTimers())

  it("uses the native folder picker while keeping workspace changes inside the demo", async () => {
    const snapshot = await createDemoRuntime().getSnapshot()
    const pickWorkspaceFolder = vi.fn(async (): Promise<string | undefined> => "/picked/demo")
    const api = createDemoRuntime({
      getSnapshot: async () => snapshot,
      getWindowState: async () => ({ fullscreen: false }),
      subscribeWindowState: () => () => {},
      pickWorkspaceFolder,
    })
    expect(await api.pickWorkspaceFolder()).toBe("/picked/demo")
    expect(pickWorkspaceFolder).toHaveBeenCalledOnce()
    expect(await api.openWorkspace("/picked/demo")).toEqual({ ok: true })
    expect((await api.getSnapshot()).workspace.path).toBe("/picked/demo")
    expect(snapshot.workspace.path).toBe("/Users/dev/Projects/otis")
    pickWorkspaceFolder.mockResolvedValue(undefined)
    expect(await api.pickWorkspaceFolder()).toBeUndefined()
    expect((await api.getSnapshot()).workspace.path).toBe("/picked/demo")
  })

  it("can preview onboarding and complete setup without provider access", async () => {
    vi.useFakeTimers()
    const api = createDemoRuntime(undefined, true)
    expect(await api.getSnapshot()).toMatchObject({
      model: null,
      modelState: "unconfigured",
      hostedConfigured: false,
    })
    expect(await api.setFireworksApiKey("")).toMatchObject({ ok: false })
    expect(await settle(api.setFireworksApiKey("demo-key"))).toEqual({ ok: true })
    expect(await api.getSnapshot()).toMatchObject({ model: null, hostedConfigured: true })
    const id = "accounts/fireworks/models/kimi-k3"
    expect(await settle(api.selectModel(id))).toEqual({ ok: true })
    expect(await api.getSnapshot()).toMatchObject({ model: { id }, modelState: "ready" })
  })

  it("switches saved Word versions and reopens the latest independently of the working file", async () => {
    const api = createDemoRuntime()
    const initial = await api.getSnapshot()
    const initialArtifact = shown(initial)
    if (!initialArtifact?.publication)
      throw new Error("Expected a saved artifact in the initial demo")
    const reference = initialArtifact.publication.reference
    expect(shown(initial)?.publication).toMatchObject({
      versions: [1, 2, 3],
      followingLatest: true,
      reference: { version: 3 },
    })
    expect(await api.getArtifact(1, initialArtifact.id, initialArtifact.revision)).toMatchObject({
      ok: true,
      payload: { content: expect.stringContaining("October 19") },
    })

    for (const [version, date] of [
      [1, "October 5"],
      [2, "October 12"],
      [3, "October 19"],
    ] as const) {
      expect(await api.openArtifact(reference, version)).toEqual({ ok: true })
      const selected = shown(await api.getSnapshot())
      if (!selected) throw new Error("Expected the selected saved artifact")
      expect(selected.publication).toMatchObject({ followingLatest: false, reference: { version } })
      expect(await api.getArtifact(1, selected.id, selected.revision)).toMatchObject({
        ok: true,
        payload: { content: expect.stringContaining(date) },
      })
      expect(await api.getArtifact(1, initialArtifact.id, initialArtifact.revision)).toMatchObject({
        ok: false,
        stale: true,
      })
    }

    const beforeInvalid = shown(await api.getSnapshot())
    expect(await api.openArtifact(reference, 99)).toMatchObject({ ok: false })
    expect(await api.openArtifact({ ...reference, artifactId: "unknown" })).toMatchObject({
      ok: false,
    })
    expect(shown(await api.getSnapshot())).toEqual(beforeInvalid)

    expect(
      await api.openArtifact({ source: "workspace", path: "launch-plan.docx", kind: "docx" }),
    ).toEqual({
      ok: true,
    })
    const working = shown(await api.getSnapshot())
    expect(working?.source).toBe("workspace")
    expect(working?.publication).toBeUndefined()
    expect(await api.openArtifact(reference)).toEqual({ ok: true })
    expect(shown(await api.getSnapshot())?.publication).toMatchObject({
      followingLatest: true,
      reference: { version: 3 },
    })

    await api.selectSession("session_pdf")
    await api.selectSession("session_versions")
    const restored = await api.getSnapshot()
    expect(shown(restored)?.publication).toMatchObject({
      followingLatest: true,
      reference: { version: 3 },
    })
    expect(restored.entries.flatMap((entry) => entry.artifacts ?? [])).toContainEqual(reference)
  })

  it("exposes PDF, Word, webpage, and Markdown Canvas fixtures without embedding their content in status", async () => {
    const api = createDemoRuntime()
    const snapshot = await api.getSnapshot()
    expect(shown(snapshot)).toMatchObject({
      kind: "docx",
      title: "launch-plan.docx",
      editable: false,
    })
    expect(JSON.stringify(shown(snapshot))).not.toContain("Release checklist")
    expect(
      await api.getArtifact(1, shown(snapshot)?.id ?? "", shown(snapshot)?.revision ?? 0),
    ).toMatchObject({
      payload: { kind: "docx", encoding: "html" },
    })

    await api.selectSession("session_pdf")
    let selected = await api.getSnapshot()
    expect(shown(selected)).toMatchObject({
      kind: "pdf",
      title: "product-brief.pdf",
    })
    expect(
      await api.getArtifact(1, shown(selected)?.id ?? "", shown(selected)?.revision ?? 0),
    ).toMatchObject({
      payload: { encoding: "bytes", content: expect.any(Uint8Array) },
    })

    await api.selectSession("session_webpage")
    selected = await api.getSnapshot()
    expect(shown(selected)).toMatchObject({
      kind: "html",
      title: "canvas-overview.html",
      editable: true,
    })
    expect(
      await api.getArtifact(1, shown(selected)?.id ?? "", shown(selected)?.revision ?? 0),
    ).toMatchObject({
      payload: { content: expect.stringContaining("Your work stays in view") },
    })

    await api.selectSession("session_demo1")
    selected = await api.getSnapshot()
    expect(shown(selected)).toMatchObject({
      kind: "markdown",
      title: "canvas-demo.md",
      editable: true,
    })
    expect(
      await api.getArtifact(1, shown(selected)?.id ?? "", shown(selected)?.revision ?? 0),
    ).toMatchObject({
      payload: { content: expect.stringContaining("Native workflow") },
    })
  })

  it("restores the deletable state after a deleted model is downloaded again", async () => {
    vi.useFakeTimers()
    const api = createDemoRuntime()

    expect(await localRow(api, QWEN_27B)).toMatchObject({
      downloaded: true,
      hasDownloadedPacking: true,
    })

    expect(await settle(api.deleteLocalModel(QWEN_27B))).toEqual({ ok: true })
    // An available row stays listed and returns to its downloadable state.
    expect(await localRow(api, QWEN_27B)).toMatchObject({
      downloaded: false,
      hasDownloadedPacking: false,
    })

    // Re-selecting runs the simulated download; success means the weights are cached on disk again,
    // so the row must report as downloaded — and be deletable — once more.
    expect(await settle(api.selectModel(QWEN_27B))).toEqual({ ok: true })
    const restored = await localRow(api, QWEN_27B)
    expect(restored.downloaded).toBe(true)
    expect(restored.hasDownloadedPacking).toBe(true)
    expect(restored.active).toBe(true)
  })

  it("marks a newly downloaded model as cached and deletable", async () => {
    vi.useFakeTimers()
    const api = createDemoRuntime()
    const id = "google/gemma-4-31B-it"
    expect(await localRow(api, id)).toMatchObject({
      downloaded: false,
      hasDownloadedPacking: false,
    })
    expect(await settle(api.selectModel(id))).toEqual({ ok: true })
    expect(await localRow(api, id)).toMatchObject({ downloaded: true, hasDownloadedPacking: true })
  })
})
