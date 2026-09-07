import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { Application } from "../../../src/app/application.js"
import { compactionSummaryMessage } from "../../../src/core/compaction.js"
import type { DesktopEvent } from "../../../src/desktop/contracts.js"
import { DesktopRuntime } from "../../../src/desktop/main/runtime.js"
import type { ChatMessage, InferenceClient } from "../../../src/inference/types.js"
import { useOtisHome } from "../../app/support/otis-home.js"
import { summaryFixture } from "../../support/compaction.js"

describe("desktop compaction through the shared runtime", () => {
  const isolate = useOtisHome()

  it("checkpoints, continues tools without another prompt, and keeps summaries hidden live and after reload", async () => {
    const cwd = await isolate("otis-desktop-compaction-")
    await writeFile(join(cwd, "note.txt"), "remaining work")
    const app = await Application.create({ cwd })
    const session = await app.sessions.ensure()
    const admission = await session.admitPrompt("Build the GUI")
    const history: ChatMessage[] = [
      admission.message,
      {
        role: "assistant",
        content: [
          { type: "reasoning", field: "reasoning_content", text: "Earlier reasoning. ".repeat(6_000) },
          { type: "text", text: "Earlier visible answer." },
        ],
      },
    ]
    await session.completeTurn(admission, history)
    app.transcript.replaceMessages(history)
    const summary = summaryFixture("PRIVATE_COMPACTION_CONTEXT")
    let requests = 0
    const client: InferenceClient = {
      model: "fake",
      complete: vi.fn(),
      streamChat: async function* (request) {
        requests += 1
        if (requests === 1) {
          expect(request.systemPrompt).toContain("You are a conversation summarizer")
          yield { type: "text_delta", text: summary }
        } else {
          expect(session.events.some((event) => event.type === "compacted")).toBe(true)
          expect(request.messages[0]).toEqual(compactionSummaryMessage(summary))
          expect(request.systemPrompt).toBeUndefined()
          if (requests === 2) {
            yield { type: "text_delta", text: "Continuing the task." }
            yield { type: "tool_call", toolCall: { id: "read_1", name: "read", arguments: '{"path":"note.txt"}' } }
          } else yield { type: "text_delta", text: "Finished the task." }
        }
      },
    }
    app.models.client = client
    app.models.selectedId = "fake"
    app.models.selectedProvider = "fireworks"
    app.models.autoCompactAtTokens = 20_000
    const sent: DesktopEvent[] = []
    const runtime = DesktopRuntime.forApplication(app, {
      cwd,
      version: "test",
      platform: "darwin",
      send: (event) => sent.push(event),
    })
    try {
      expect(await runtime.sendPrompt("Continue")).toEqual({ accepted: true, delivery: "started" })
      await app.conversation.wait()
      await vi.waitFor(async () => expect((await runtime.snapshot()).busy).toBe(false))
      expect(requests).toBe(3)
      expect(session.events.filter((event) => event.type === "compacted")).toHaveLength(1)

      const texts = (await runtime.snapshot()).entries.map((entry) => entry.text)
      expect(texts).toEqual(
        expect.arrayContaining(["Earlier visible answer.", "Continuing the task.", "Finished the task."]),
      )
      expect(texts.some((text) => text.includes("PRIVATE_COMPACTION_CONTEXT"))).toBe(false)
      expect(JSON.stringify(sent)).not.toContain("PRIVATE_COMPACTION_CONTEXT")

      expect(runtime.startNewSession()).toEqual({ ok: true })
      expect(await runtime.selectSession(session.id)).toEqual({ ok: true })
      const reopened = (await runtime.snapshot()).entries.map((entry) => entry.text)
      expect(reopened).toEqual(
        expect.arrayContaining(["Earlier visible answer.", "Continuing the task.", "Finished the task."]),
      )
      expect(reopened.some((text) => text.includes("PRIVATE_COMPACTION_CONTEXT"))).toBe(false)
    } finally {
      await runtime.shutdown()
    }
  })
})
