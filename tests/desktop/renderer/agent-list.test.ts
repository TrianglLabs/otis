import { describe, expect, it } from "vitest"
import { agentSummary } from "../../../src/desktop/renderer/features/agents/agent-list.js"

// These strings mirror subagentSummary in the TUI's subagent panel (src/cli/ui/subagent-panel.ts) exactly.
describe("agentSummary", () => {
  it("shows the tool count and lifecycle state", () => {
    expect(agentSummary({ status: "running", tools: 1 })).toBe("1 tool · running")
    expect(agentSummary({ status: "running", tools: 0 })).toBe("0 tools · running")
    expect(agentSummary({ status: "complete", tools: 1, durationMs: 1_500 })).toBe("1 tool · 1.5s")
    expect(agentSummary({ status: "complete", tools: 3, durationMs: 900 })).toBe("3 tools · 900ms")
    expect(agentSummary({ status: "complete", tools: 2, durationMs: 12_400 })).toBe("2 tools · 12s")
  })

  it("appends the terminal word for failed and interrupted runs", () => {
    expect(agentSummary({ status: "failed", tools: 0, durationMs: 1_500 })).toBe("0 tools · 1.5s · failed")
    expect(agentSummary({ status: "interrupted", tools: 2, durationMs: 800 })).toBe("2 tools · 800ms · interrupted")
    expect(agentSummary({ status: "failed", tools: 1 })).toBe("1 tool · failed")
  })
})
