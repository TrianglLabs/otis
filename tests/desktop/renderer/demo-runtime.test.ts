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
  it("restores the deletable state after a deleted model is downloaded again", async () => {
    const api = createDemoRuntime()

    expect((await localRow(api, QWEN_CODER)).downloaded).toBe(true)

    expect(await api.deleteLocalModel(QWEN_CODER)).toEqual({ ok: true })
    // An available row stays listed and returns to its downloadable state.
    expect((await localRow(api, QWEN_CODER)).downloaded).toBe(false)

    // Re-selecting runs the simulated download; success means the weights are cached on disk again,
    // so the row must report as downloaded — and be deletable — once more.
    expect(await api.selectModel(QWEN_CODER)).toEqual({ ok: true })
    const restored = await localRow(api, QWEN_CODER)
    expect(restored.downloaded).toBe(true)
    expect(restored.active).toBe(true)
  }, 15_000) // The delete settle and the four-step download simulation run on real timers (~4s total).
})
