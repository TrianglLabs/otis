import { describe, expect, it } from "vitest"
import { createDemoRuntime } from "../../../src/desktop/renderer/demo/demo-runtime.js"
import type { LocalPickerChoice } from "../../../src/inference/picker-catalog.js"

const QWEN_27B = "Qwen/Qwen3.8-27B"

async function localRow(api: ReturnType<typeof createDemoRuntime>, id: string): Promise<LocalPickerChoice> {
  const row = (await api.listModels()).find(
    (entry): entry is LocalPickerChoice => entry.kind === "model" && entry.provider === "local" && entry.id === id,
  )
  if (!row) throw new Error(`Local model ${id} is missing from the demo catalog`)
  return row
}

describe("demo runtime model lifecycle", () => {
  it("switches saved Word versions and reopens the latest independently of the working file", async () => {
    const api = createDemoRuntime()
    const initial = await api.getSnapshot()
    const initialArtifact = initial.artifact
    if (!initialArtifact?.publication) throw new Error("Expected a saved artifact in the initial demo")
    const reference = initialArtifact.publication.reference
    expect(initial.artifact?.publication).toMatchObject({
      versions: [1, 2, 3],
      followingLatest: true,
      reference: { version: 3 },
    })
    expect((await api.getArtifact(initialArtifact.revision))?.content).toContain("October 19")

    for (const [version, date] of [
      [1, "October 5"],
      [2, "October 12"],
      [3, "October 19"],
    ] as const) {
      expect(await api.openArtifact(reference, version)).toEqual({ ok: true })
      const selected = (await api.getSnapshot()).artifact
      if (!selected) throw new Error("Expected the selected saved artifact")
      expect(selected.publication).toMatchObject({ followingLatest: false, reference: { version } })
      expect((await api.getArtifact(selected.revision))?.content).toContain(date)
      expect(await api.getArtifact(initialArtifact.revision)).toBeUndefined()
    }

    const beforeInvalid = (await api.getSnapshot()).artifact
    expect(await api.openArtifact(reference, 99)).toMatchObject({ ok: false })
    expect(await api.openArtifact({ ...reference, artifactId: "unknown" })).toMatchObject({ ok: false })
    expect((await api.getSnapshot()).artifact).toEqual(beforeInvalid)

    expect(await api.openArtifact({ source: "workspace", path: "launch-plan.docx", kind: "docx" })).toEqual({
      ok: true,
    })
    const working = (await api.getSnapshot()).artifact
    expect(working?.source).toBe("workspace")
    expect(working?.publication).toBeUndefined()
    expect(await api.openArtifact(reference)).toEqual({ ok: true })
    expect((await api.getSnapshot()).artifact?.publication).toMatchObject({
      followingLatest: true,
      reference: { version: 3 },
    })

    await api.selectSession("session_pdf")
    await api.selectSession("session_versions")
    const restored = await api.getSnapshot()
    expect(restored.artifact?.publication).toMatchObject({ followingLatest: true, reference: { version: 3 } })
    expect(restored.entries.flatMap((entry) => entry.artifacts ?? [])).toContainEqual(reference)
  })

  it("exposes PDF, Word, webpage, and Markdown Canvas fixtures without embedding their content in status", async () => {
    const api = createDemoRuntime()
    const snapshot = await api.getSnapshot()
    expect(snapshot.artifact).toMatchObject({ kind: "docx", title: "launch-plan.docx", editable: false })
    expect(JSON.stringify(snapshot.artifact)).not.toContain("Release checklist")
    expect(await api.getArtifact(snapshot.artifact?.revision ?? 0)).toMatchObject({
      kind: "docx",
      encoding: "html",
    })

    await api.selectSession("session_pdf")
    let selected = await api.getSnapshot()
    expect(selected.artifact).toMatchObject({ kind: "pdf", title: "product-brief.pdf" })
    expect(await api.getArtifact(selected.artifact?.revision ?? 0)).toMatchObject({ encoding: "base64" })

    await api.selectSession("session_webpage")
    selected = await api.getSnapshot()
    expect(selected.artifact).toMatchObject({ kind: "html", title: "canvas-overview.html", editable: true })
    expect((await api.getArtifact(selected.artifact?.revision ?? 0))?.content).toContain("Your work stays in view")

    await api.selectSession("session_demo1")
    selected = await api.getSnapshot()
    expect(selected.artifact).toMatchObject({ kind: "markdown", title: "canvas-demo.md", editable: true })
    expect((await api.getArtifact(selected.artifact?.revision ?? 0))?.content).toContain("Native workflow")
  })

  it("restores the deletable state after a deleted model is downloaded again", async () => {
    const api = createDemoRuntime()

    expect(await localRow(api, QWEN_27B)).toMatchObject({ downloaded: true, hasDownloadedPacking: true })

    expect(await api.deleteLocalModel(QWEN_27B)).toEqual({ ok: true })
    // An available row stays listed and returns to its downloadable state.
    expect(await localRow(api, QWEN_27B)).toMatchObject({ downloaded: false, hasDownloadedPacking: false })

    // Re-selecting runs the simulated download; success means the weights are cached on disk again,
    // so the row must report as downloaded — and be deletable — once more.
    expect(await api.selectModel(QWEN_27B)).toEqual({ ok: true })
    const restored = await localRow(api, QWEN_27B)
    expect(restored.downloaded).toBe(true)
    expect(restored.hasDownloadedPacking).toBe(true)
    expect(restored.active).toBe(true)
  }, 15_000) // The delete settle and the four-step download simulation run on real timers (~4s total).

  it("marks a newly downloaded model as cached and deletable", async () => {
    const api = createDemoRuntime()
    const id = "openai/gpt-oss-120b"
    expect(await localRow(api, id)).toMatchObject({ downloaded: false, hasDownloadedPacking: false })
    expect(await api.selectModel(id)).toEqual({ ok: true })
    expect(await localRow(api, id)).toMatchObject({ downloaded: true, hasDownloadedPacking: true })
  }, 10_000)
})
