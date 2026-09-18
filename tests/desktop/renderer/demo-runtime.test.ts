import { describe, expect, it } from "vitest"
import { createDemoRuntime } from "../../../src/desktop/renderer/demo/demo-runtime.js"
import type { LocalPickerChoice } from "../../../src/inference/picker-catalog.js"

const QWEN_CODER = "Qwen/Qwen3-Coder-30B-A3B-Instruct"

async function localRow(api: ReturnType<typeof createDemoRuntime>, id: string): Promise<LocalPickerChoice> {
  const row = (await api.listModels()).find(
    (entry): entry is LocalPickerChoice => entry.kind === "model" && entry.provider === "local" && entry.id === id,
  )
  if (!row) throw new Error(`Local model ${id} is missing from the demo catalog`)
  return row
}

describe("demo runtime model lifecycle", () => {
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

    expect(await localRow(api, QWEN_CODER)).toMatchObject({ downloaded: true, hasDownloadedPacking: true })

    expect(await api.deleteLocalModel(QWEN_CODER)).toEqual({ ok: true })
    // An available row stays listed and returns to its downloadable state.
    expect(await localRow(api, QWEN_CODER)).toMatchObject({ downloaded: false, hasDownloadedPacking: false })

    // Re-selecting runs the simulated download; success means the weights are cached on disk again,
    // so the row must report as downloaded — and be deletable — once more.
    expect(await api.selectModel(QWEN_CODER)).toEqual({ ok: true })
    const restored = await localRow(api, QWEN_CODER)
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
