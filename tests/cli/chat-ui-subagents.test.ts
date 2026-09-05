import type { BoxRenderable, TextRenderable } from "@opentui/core"
import { describe, expect, it, vi } from "vitest"
import { SubagentTraces } from "../../src/app/subagents.js"
import { TranscriptStore } from "../../src/app/transcript.js"
import { TEXT_SHIMMER_PERIOD_MS } from "../../src/cli/ui/color-pulse.js"
import { subagentRowId } from "../../src/cli/ui/subagent-panel.js"
import type { AgentEvent } from "../../src/core/agent.js"
import type { ChatMessage } from "../../src/inference/types.js"
import { useChatHarness } from "./support/chat-ui-harness.js"

const childMessages: ChatMessage[] = [
  { role: "user", content: "Map the notes." },
  {
    role: "assistant",
    content: [{ type: "tool_call", toolCall: { id: "read_1", name: "read", arguments: '{"path":"note.txt"}' } }],
  },
  { role: "tool", toolCallId: "read_1", content: "note" },
  { role: "assistant", content: [{ type: "text", text: "Report: two notes." }] },
]

function envelope(toolCallId: string, title: string, event: AgentEvent): Extract<AgentEvent, { type: "subagent" }> {
  return { type: "subagent", toolCallId, title, event }
}

function startedTraces() {
  const traces = new SubagentTraces()
  traces.apply(envelope("call_a", "Map the notes", { type: "model", phase: "start" }))
  traces.apply(
    envelope("call_a", "Map the notes", {
      type: "tool",
      phase: "start",
      toolCallId: "read_1",
      name: "read",
      activityKind: "file_read",
      label: "Reading files: note.txt",
    }),
  )
  traces.apply(envelope("call_a", "Map the notes", { type: "delta", text: "Report: two notes." }))
  traces.apply(envelope("call_b", "Check the docs", { type: "model", phase: "start" }))
  return traces
}

describe("chat UI subagents", () => {
  const setup = useChatHarness()

  it("lists delegated runs beside the transcript only while there are any and the terminal is wide", async () => {
    const harness = await setup()
    harness.ui.showChatLayout()
    expect(harness.childIds("chat-body")).toEqual(["messages"])

    const traces = startedTraces()
    harness.ui.renderSubagents(traces.all)
    await harness.renderOnce()

    expect(harness.childIds("chat-body")).toEqual(["messages", "subagent-panel"])
    expect(harness.childIds("subagent-rows")).toEqual([
      `${subagentRowId("call_a")}-box`,
      `${subagentRowId("call_b")}-box`,
    ])
    expect(harness.text(subagentRowId("call_a"))).toBe("  ◇ Map the notes")
    expect(harness.text(`${subagentRowId("call_a")}-meta`)).toBe("   1 tool · running")
    expect(harness.text(`${subagentRowId("call_b")}-meta`)).toBe("   0 tools · running")
    expect(harness.captureCharFrame()).toContain("Subagents")

    harness.resize(80, 30)
    expect(harness.childIds("chat-body")).toEqual(["messages"])
    harness.resize(120, 30)
    expect(harness.childIds("chat-body")).toEqual(["messages", "subagent-panel"])

    harness.ui.renderSubagents([])
    expect(harness.childIds("chat-body")).toEqual(["messages"])
  })

  it("shimmers running titles and settles them with a status glyph, tool count, and duration", async () => {
    const harness = await setup()
    vi.useFakeTimers()
    vi.setSystemTime(0)
    harness.ui.showChatLayout()
    const traces = startedTraces()
    harness.ui.renderSubagents(traces.all)

    const row = harness.get<TextRenderable>(subagentRowId("call_a"))
    const first = titleColors(row, "Map the notes")
    expect(new Set(first).size).toBeGreaterThan(1)
    vi.advanceTimersByTime(TEXT_SHIMMER_PERIOD_MS / 2)
    expect(titleColors(row, "Map the notes")).not.toEqual(first)

    vi.setSystemTime(1_500)
    traces.apply(envelope("call_a", "Map the notes", { type: "complete", messages: childMessages }))
    traces.apply(envelope("call_b", "Check the docs", { type: "error", message: "boom" }))
    harness.ui.renderSubagents(traces.all)

    expect(harness.text(subagentRowId("call_a"))).toBe("  ✓ Map the notes")
    expect(harness.text(`${subagentRowId("call_a")}-meta`)).toBe("   1 tool · 1.5s")
    // A settled title is one uniformly colored chunk instead of per-letter shimmer.
    expect(row.chunks.at(-1)?.text).toBe("Map the notes")
    expect(harness.text(subagentRowId("call_b"))).toBe("  ✗ Check the docs")
    expect(harness.text(`${subagentRowId("call_b")}-meta`)).toBe("   0 tools · 1.5s · failed")
  })

  it("opens a run's full trace in place of the conversation and returns on escape", async () => {
    const harness = await setup()
    harness.ui.showChatLayout()
    const transcript = new TranscriptStore()
    transcript.addToolMessage("Delegating: Map the notes", "agent", { toolCallId: "call_a" })
    harness.ui.renderTranscript(transcript.entries)
    const traces = startedTraces()
    harness.ui.renderSubagents(traces.all)
    await harness.renderOnce()

    const row = harness.get<BoxRenderable>(`${subagentRowId("call_a")}-box`)
    await harness.mockMouse.click(row.x + 2, row.y)
    await harness.renderOnce()

    expect(harness.childIds("chat-body")).toEqual(["subagent-trace", "subagent-panel"])
    expect(harness.text("subagent-trace-header")).toBe("◇ Map the notes · 1 tool · running")
    expect(harness.text(subagentRowId("call_a"))).toBe("› ◇ Map the notes")
    expect(harness.text("subagent-panel-footer")).toBe("[esc] back to chat")
    const frame = harness.captureCharFrame()
    expect(frame).toContain("Reading files: note.txt")
    expect(frame).toContain("Report: two notes.")
    expect(frame).not.toContain("Delegating: Map the notes")

    // Live progress keeps flowing into the open trace.
    traces.apply(envelope("call_a", "Map the notes", { type: "complete", messages: childMessages }))
    harness.ui.renderSubagents(traces.all)
    expect(harness.text("subagent-trace-header")).toMatch(/^✓ Map the notes · 1 tool · \d+ms$/)

    harness.press("escape")
    await harness.renderOnce()
    expect(harness.childIds("chat-body")).toEqual(["messages", "subagent-panel"])
    expect(harness.text(subagentRowId("call_a"))).toBe("  ✓ Map the notes")
    expect(harness.text("subagent-panel-footer")).toBe("click a run to inspect")
    expect(harness.captureCharFrame()).toContain("Delegating: Map the notes")
  })

  it("closes an open trace when its run leaves the session or a prompt is submitted", async () => {
    const onSubmit = vi.fn()
    const harness = await setup({ onSubmit })
    harness.ui.showChatLayout()
    const traces = startedTraces()
    harness.ui.renderSubagents(traces.all)
    await harness.renderOnce()

    const open = async () => {
      const row = harness.get<BoxRenderable>(`${subagentRowId("call_a")}-box`)
      await harness.mockMouse.click(row.x + 2, row.y)
      await harness.renderOnce()
      expect(harness.childIds("chat-body")).toEqual(["subagent-trace", "subagent-panel"])
    }

    await open()
    harness.setChatInput("next question")
    harness.submitChat()
    expect(onSubmit).toHaveBeenCalledWith("next question")
    expect(harness.childIds("chat-body")).toEqual(["messages", "subagent-panel"])

    await open()
    harness.ui.renderSubagents([])
    expect(harness.childIds("chat-body")).toEqual(["messages"])
  })

  it("hides the panel and closes an open trace when the settings preference is off", async () => {
    const harness = await setup({ subagentPanelVisible: false })
    harness.ui.showChatLayout()
    harness.ui.renderSubagents(startedTraces().all)
    await harness.renderOnce()
    expect(harness.childIds("chat-body")).toEqual(["messages"])

    harness.ui.setSubagentPanelVisible(true)
    expect(harness.childIds("chat-body")).toEqual(["messages", "subagent-panel"])
    await harness.renderOnce()
    const row = harness.get<BoxRenderable>(`${subagentRowId("call_a")}-box`)
    await harness.mockMouse.click(row.x + 2, row.y)
    expect(harness.find("subagent-trace")).toBeDefined()

    harness.ui.setSubagentPanelVisible(false)
    expect(harness.childIds("chat-body")).toEqual(["messages"])
    expect(harness.find("subagent-trace")).toBeUndefined()
  })

  it("does not let escape interrupt the agent while a trace is open", async () => {
    const onInterrupt = vi.fn()
    const harness = await setup({ onInterrupt })
    harness.ui.showChatLayout()
    harness.ui.setBusy(true)
    const traces = startedTraces()
    harness.ui.renderSubagents(traces.all)
    await harness.renderOnce()
    const row = harness.get<BoxRenderable>(`${subagentRowId("call_a")}-box`)
    await harness.mockMouse.click(row.x + 2, row.y)

    harness.press("escape")
    expect(onInterrupt).not.toHaveBeenCalled()
    expect(harness.childIds("chat-body")).toEqual(["messages", "subagent-panel"])
  })
})

function titleColors(row: TextRenderable, title: string) {
  return row.chunks.slice(-title.length).map((chunk) => (chunk.fg ? chunk.fg.toInts().join(",") : ""))
}
