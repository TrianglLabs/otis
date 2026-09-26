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

  it("drops a history session on a side, or in a card's place", async () => {
    const api = createDemoRuntime()
    expect(await api.selectSession("session_notes", undefined, { side: "right" })).toEqual({
      ok: true,
    })
    const split = await api.getSnapshot()
    const shown = (snapshot: typeof split, pane: number | undefined) =>
      snapshot.runtimes.find((entry) => entry.runtime === pane)?.session?.id
    expect(split.panes).toHaveLength(2)
    expect(shown(split, split.panes[1])).toBe("session_notes")

    const card = split.panes[1] ?? 0
    expect(await api.selectSession("session_pdf", undefined, { replace: card })).toEqual({
      ok: true,
    })
    const replaced = await api.getSnapshot()
    expect(replaced.panes).toEqual(split.panes)
    expect(shown(replaced, card)).toBe("session_pdf")

    // Picked from history without company, a session takes the screen.
    expect(await api.selectSession("session_notes")).toEqual({ ok: true })
    const alone = await api.getSnapshot()
    expect(alone.panes).toHaveLength(1)
    expect(shown(alone, alone.panes[0])).toBe("session_notes")
  })

  it("brings a session back with its company, and a fresh start takes the screen alone", async () => {
    const api = createDemoRuntime()
    expect(await api.selectSession("session_demo2")).toEqual({ ok: true })
    const paired = await api.getSnapshot()
    const onScreen = paired.panes.map(
      (pane) => paired.runtimes.find((entry) => entry.runtime === pane)?.session?.id,
    )
    expect(onScreen).toEqual(["session_demo2", "session_demo3"])
    expect(paired.paneAxis).toBe("row")
    expect(paired.session?.id).toBe("session_demo2")
    expect(paired.sessions.filter((item) => item.active).map((item) => item.id)).toEqual([
      "session_demo2",
      "session_demo3",
    ])

    expect(await api.startNewSession()).toEqual({ ok: true })
    const fresh = await api.getSnapshot()
    expect(fresh.panes).toHaveLength(1)
    expect(fresh.session).toBeNull()
    // The header reads the top-level counters, not the pane's.
    expect(fresh.diffs).toEqual({ added: 0, removed: 0 })
    expect(fresh.contextTokens).toBe(0)
    expect(fresh.runtimes.map((entry) => entry.session?.id)).toEqual(
      expect.arrayContaining(["session_demo2", "session_demo3"]),
    )
  })

  it("opens a session from an unregistered folder with its history and the locate banner", async () => {
    const api = createDemoRuntime()
    expect(await api.selectSession("session_old", "oldstuff-demo")).toEqual({ ok: true })
    const opened = await api.getSnapshot()
    expect(opened.session?.id).toBe("session_old")
    expect(opened.entries.length).toBeGreaterThan(0)
    expect(opened.needsWorkspace).toBe(true)

    expect(await api.locateWorkspace("/Users/dev/Projects/oldstuff")).toEqual({ ok: true })
    const located = await api.getSnapshot()
    expect(located.needsWorkspace).toBe(false)
    expect(located.sessions.find((item) => item.id === "session_old")?.workspacePath).toBe(
      "/Users/dev/Projects/oldstuff",
    )
  })

  it("grows a group by a drop, and dissolves it for a session closed out of it", async () => {
    const api = createDemoRuntime()
    await api.selectSession("session_demo2")
    expect(await api.selectSession("session_old", undefined, { side: "right" })).toEqual({
      ok: true,
    })
    const trio = await api.getSnapshot()
    expect(trio.panes).toHaveLength(3)
    const viewOf = (snapshot: typeof trio, id: string) =>
      snapshot.sessions.find((entry) => entry.id === id)?.view?.members.map((m) => m.id)
    const ids = ["session_demo2", "session_demo3", "session_old"]
    for (const id of ids) expect(viewOf(trio, id)).toEqual(ids)

    await api.closePane(trio.panes[2] ?? 0)
    const closed = await api.getSnapshot()
    expect(viewOf(closed, "session_old")).toBeUndefined()
    expect(viewOf(closed, "session_demo2")).toEqual(["session_demo2", "session_demo3"])
    await api.selectSession("session_old")
    expect((await api.getSnapshot()).panes).toHaveLength(1)
  })
})

describe("demo runtime skills", () => {
  it("lists bundled, project and collection skills, and installs or removes a collection", async () => {
    const api = createDemoRuntime()
    const before = await api.listSkills()
    expect(before.sources.map((source) => source.id)).toEqual(["superpowers", "gstack", "pstack"])
    const origin = (name: string) => before.skills.find((skill) => skill.name === name)?.origin
    expect(origin("documents")).toBe("bundled")
    expect(origin("release-notes")).toBe("project")
    expect(origin("brainstorming")).toEqual({ collection: "superpowers" })
    expect(origin("poteto-mode")).toEqual({ collection: "pstack" })
    expect(before.skills.map((skill) => skill.name)).toEqual(
      [...before.skills.map((skill) => skill.name)].sort(),
    )

    expect(await api.installSkills("https://github.com/acme/skills.git")).toEqual({ ok: true })
    expect(await api.installSkills("https://github.com/acme/skills")).toEqual({
      ok: false,
      reason: "A source named skills is already installed.",
    })
    const installed = await api.listSkills()
    expect(installed.sources.map((source) => source.id)).toEqual([
      "superpowers",
      "gstack",
      "pstack",
      "skills",
    ])
    const from = (skill: (typeof before.skills)[number]) =>
      typeof skill.origin === "object" ? skill.origin.collection : undefined
    expect(installed.skills.some((skill) => from(skill) === "skills")).toBe(true)

    expect(await api.removeSkills("superpowers")).toEqual({ ok: true })
    const removed = await api.listSkills()
    expect(removed.sources.map((source) => source.id)).toEqual(["gstack", "pstack", "skills"])
    expect(removed.skills.some((skill) => from(skill) === "superpowers")).toBe(false)
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
