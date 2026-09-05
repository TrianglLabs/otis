import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type AgentEvent, runAgent } from "../../src/core/agent.js"
import {
  providerTools,
  SUBAGENT_MAX_STEPS,
  subagentBrief,
  subagentRunOptions,
  subagentTools,
  supportsDelegation,
} from "../../src/core/subagent.js"
import type { FireworksClient } from "../../src/inference/client.js"
import type { ModelProvider } from "../../src/inference/types.js"
import { createPermissionPolicy, type PermissionRequest } from "../../src/permissions/policy.js"
import { emptySkillCatalog } from "../../src/skills/index.js"
import { executeToolCall, TOOL_DEFINITIONS } from "../../src/tools/index.js"

const streamMock = vi.hoisted(() => vi.fn())
const client = { model: "accounts/fireworks/models/test", streamChat: streamMock } as unknown as FireworksClient

const tempDirs: string[] = []

afterEach(async () => {
  streamMock.mockReset()
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const delegateCall = (id: string, description = "Map the notes", prompt = "List every note file.") => ({
  type: "tool_call" as const,
  toolCall: { id, name: "agent", arguments: JSON.stringify({ description, prompt }) },
})

describe("agent tool", () => {
  it("compacts a long child without checkpointing or inflating the parent's context", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "note", "utf8")
    const parentCheckpoint = vi.fn()
    streamMock
      .mockImplementationOnce(async function* () {
        yield delegateCall("call_agent")
      })
      .mockImplementationOnce(async function* () {
        yield { type: "reasoning_delta", field: "reasoning_content", text: "x".repeat(100_000) }
        yield { type: "tool_call", toolCall: { id: "read_1", name: "read", arguments: '{"path":"note.txt"}' } }
        yield { type: "usage", usage: { promptTokens: 2_000, completionTokens: 25_000, totalTokens: 27_000 } }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Child progress summarized." }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Child report." }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Finished." }
      })
    const events = await collect(
      runAgent("delegate", [], { client, cwd, autoCompactAtTokens: 20_000, onCompaction: parentCheckpoint }),
    )
    expect(events.at(-1)?.type).toBe("complete")
    expect(
      events.filter(
        (event) => event.type === "subagent" && event.event.type === "compaction" && event.event.phase === "complete",
      ),
    ).toHaveLength(1)
    expect(parentCheckpoint).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === "compaction")).toBe(false)
    expect(streamMock).toHaveBeenCalledTimes(5)
  })

  it("runs the delegated brief in a fresh context and returns only the final report", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "first line", "utf8")
    const requests: StreamRequest[] = []
    streamMock
      // Parent step 1: delegate.
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request))
        yield { type: "text_delta", text: "Let me delegate this." }
        yield delegateCall("call_agent")
      })
      // Child step 1: read a file.
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request))
        yield { type: "reasoning_delta", text: "Private child reasoning.", field: "reasoning_content" }
        yield { type: "text_delta", text: "Child interim text." }
        yield { type: "tool_call", toolCall: { id: "call_read", name: "read", arguments: '{"path":"note.txt"}' } }
      })
      // Child step 2: final report.
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request))
        yield { type: "text_delta", text: "Report: note.txt starts with 'first line'." }
      })
      // Parent step 2: answer using the report.
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request))
        yield { type: "text_delta", text: "Done." }
      })

    const events = await collect(
      runAgent("map the notes", [{ role: "user", content: "earlier context" }], { client, cwd }),
    )
    const complete = events.find((event) => event.type === "complete")

    expect(streamMock).toHaveBeenCalledTimes(4)
    // The child starts from the brief alone, never the parent's history.
    expect(requests[1].messages).toHaveLength(1)
    const brief = requests[1].messages[0].content as string
    expect(brief).toContain("You are an Otis subagent.")
    expect(brief).toContain("Your tools are read-only.")
    expect(brief).toContain("Task:\nList every note file.")
    expect(brief).not.toContain("earlier context")
    // The child keeps its own tool history across its steps.
    expect(requests[2].messages).toMatchObject([
      { role: "user" },
      { role: "assistant", content: [{ type: "reasoning" }, { type: "text" }, { type: "tool_call" }] },
      { role: "tool", toolCallId: "call_read", content: expect.stringContaining("first line") },
    ])
    // The parent receives only the report as the tool result.
    expect(requests[3].messages).toEqual([
      { role: "user", content: "earlier context" },
      { role: "user", content: "map the notes" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me delegate this." },
          { type: "tool_call", toolCall: expect.objectContaining({ id: "call_agent", name: "agent" }) },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_agent",
        content: "agent: Map the notes\n\nReport: note.txt starts with 'first line'.",
      },
    ])
    expect(complete?.messages).toEqual(
      requests[3].messages.slice(1).concat({ role: "assistant", content: [{ type: "text", text: "Done." }] }),
    )
  })

  it("wraps every child event in a subagent envelope and keeps the parent's own stream clean", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "first line", "utf8")
    streamMock
      .mockImplementationOnce(async function* () {
        yield delegateCall("call_agent")
      })
      .mockImplementationOnce(async function* () {
        yield { type: "reasoning_delta", text: "Private child reasoning.", field: "reasoning_content" }
        yield { type: "text_delta", text: "Child interim text." }
        yield { type: "tool_call", toolCall: { id: "call_read", name: "read", arguments: '{"path":"note.txt"}' } }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Report." }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Done." }
      })

    const events = await collect(runAgent("map the notes", [], { client, cwd }))

    expect(events.filter((event) => event.type === "tool")).toMatchObject([
      {
        phase: "start",
        toolCallId: "call_agent",
        name: "agent",
        activityKind: "agent",
        label: "Delegating: Map the notes",
      },
      { phase: "end", toolCallId: "call_agent", name: "agent", outcome: "completed" },
    ])
    const envelopes = events.filter((event) => event.type === "subagent")
    expect(envelopes.every((event) => event.toolCallId === "call_agent" && event.title === "Map the notes")).toBe(true)
    const child = envelopes.map((event) => event.event)
    expect(child.filter((event) => event.type === "tool")).toMatchObject([
      { phase: "start", toolCallId: "call_read", name: "read" },
      { phase: "end", toolCallId: "call_read", name: "read", outcome: "completed" },
    ])
    expect(child.filter((event) => event.type === "reasoning").map((event) => event.phase)).toEqual([
      "start",
      "delta",
      "end",
    ])
    expect(child.filter((event) => event.type === "delta").map((event) => event.text)).toEqual([
      "Child interim text.",
      "Report.",
    ])
    expect(child.at(-1)).toMatchObject({ type: "complete" })
    // The parent's own stream carries none of the child's text, reasoning, or context accounting.
    expect(events.some((event) => event.type === "delta" && event.text.includes("Child"))).toBe(false)
    expect(events.some((event) => event.type === "reasoning")).toBe(false)
    expect(events.filter((event) => event.type === "context").map((event) => event.messageCount)).toEqual([1, 2, 3, 4])
    expect(events.filter((event) => event.type === "model")).toHaveLength(2)
  })

  it("gives children only the read-only subset of the parent's tools", async () => {
    let childTools: string[] = []
    streamMock
      .mockImplementationOnce(async function* () {
        yield delegateCall("call_agent")
      })
      .mockImplementationOnce(async function* (request) {
        childTools = request.tools.map((tool: { name: string }) => tool.name)
        yield { type: "text_delta", text: "Report." }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Done." }
      })

    await collect(runAgent("delegate", [], { client, skills: emptySkillCatalog() }))

    expect(childTools).toEqual(["web_search", "web_read", "read", "grep", "glob"])
  })

  it("runs adjacent agent calls concurrently and returns their results in the model's order", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "a.txt"), "alpha", "utf8")
    await writeFile(join(cwd, "b.txt"), "beta", "utf8")
    const timeline: string[] = []
    const gate = deferred()
    streamMock.mockImplementation(async function* (request: StreamRequest) {
      const first = request.messages[0].content as string
      if (first === "delegate both") {
        if (request.messages.length === 1) {
          yield delegateCall("call_a", "Read a", "Read a.txt")
          yield delegateCall("call_b", "Read b", "Read b.txt")
        } else {
          yield { type: "text_delta", text: "Both done." }
        }
        return
      }
      const name = first.includes("a.txt") ? "a" : "b"
      if (request.messages.length === 1) {
        timeline.push(`${name}:start`)
        // Child A blocks until child B has started, proving they run at the same time.
        if (name === "a") await gate.promise
        else gate.resolve()
        yield { type: "tool_call", toolCall: { id: `read_${name}`, name: "read", arguments: `{"path":"${name}.txt"}` } }
        return
      }
      timeline.push(`${name}:report`)
      yield { type: "text_delta", text: `Report ${name}.` }
    })

    const events = await collect(runAgent("delegate both", [], { client, cwd }))
    const complete = events.find((event) => event.type === "complete")

    // Both children start before either reports; a sequential loop would deadlock on the gate instead.
    expect(timeline.slice(0, 2).sort()).toEqual(["a:start", "b:start"])
    expect(complete?.messages.filter((message) => message.role === "tool")).toEqual([
      { role: "tool", toolCallId: "call_a", content: "agent: Read a\n\nReport a." },
      { role: "tool", toolCallId: "call_b", content: "agent: Read b\n\nReport b." },
    ])
    const childToolEvents = (toolCallId: string) =>
      events.filter(
        (event) => event.type === "subagent" && event.toolCallId === toolCallId && event.event.type === "tool",
      )
    expect(childToolEvents("call_a")).toHaveLength(2)
    expect(childToolEvents("call_b")).toHaveLength(2)
    expect(
      events.flatMap((event) => (event.type === "tool" && event.phase === "start" ? [event.toolCallId] : [])),
    ).toEqual(["call_a", "call_b"])
  })

  it("keeps non-agent tool calls sequential around a parallel batch", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "note", "utf8")
    const order: string[] = []
    streamMock.mockImplementation(async function* (request: StreamRequest) {
      const first = request.messages[0].content as string
      if (first === "mixed") {
        if (request.messages.length === 1) {
          yield { type: "tool_call", toolCall: { id: "read_1", name: "read", arguments: '{"path":"note.txt"}' } }
          yield delegateCall("call_a", "A", "Task A")
          yield delegateCall("call_b", "B", "Task B")
          yield { type: "tool_call", toolCall: { id: "read_2", name: "read", arguments: '{"path":"note.txt"}' } }
        } else {
          yield { type: "text_delta", text: "Done." }
        }
        return
      }
      order.push(first.includes("Task A") ? "child-a" : "child-b")
      yield { type: "text_delta", text: "Report." }
    })

    const events = await collect(runAgent("mixed", [], { client, cwd }))

    const topLevel = (phase: "start" | "end") =>
      events.flatMap((event) => (event.type === "tool" && event.phase === phase ? [event.toolCallId] : []))
    expect(topLevel("start")).toEqual(["read_1", "call_a", "call_b", "read_2"])
    expect(order.sort()).toEqual(["child-a", "child-b"])
    const ends = topLevel("end")
    expect(ends.indexOf("read_1")).toBeLessThan(ends.indexOf("call_a"))
    expect(ends.indexOf("read_2")).toBe(3)
  })

  it("serializes approval requests from concurrent children so the approval surface sees one at a time", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "secret.env"), "x", "utf8")
    let inFlight = 0
    let maxInFlight = 0
    const onPermissionRequest = vi.fn(async (_request: PermissionRequest) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return true
    })
    streamMock.mockImplementation(async function* (request: StreamRequest) {
      const first = request.messages[0].content as string
      if (first === "delegate both") {
        if (request.messages.length === 1) {
          yield delegateCall("call_a", "A", "Task A")
          yield delegateCall("call_b", "B", "Task B")
        } else yield { type: "text_delta", text: "Done." }
        return
      }
      if (request.messages.length === 1) {
        yield { type: "tool_call", toolCall: { id: "read_env", name: "read", arguments: '{"path":"secret.env"}' } }
        return
      }
      yield { type: "text_delta", text: "Report." }
    })
    const permissionPolicy = createPermissionPolicy({
      cwd,
      mode: "auto",
      rules: [{ tool: "read", resource: "*.env", effect: "ask" }],
    })

    await collect(runAgent("delegate both", [], { client, cwd, permissionPolicy, onPermissionRequest }))

    expect(onPermissionRequest).toHaveBeenCalledTimes(2)
    expect(maxInFlight).toBe(1)
  })

  it("reports a failed child as a failed tool call and lets the parent continue", async () => {
    streamMock
      .mockImplementationOnce(async function* () {
        yield delegateCall("call_agent")
      })
      .mockImplementationOnce(async function* () {
        yield* []
      })
      .mockImplementationOnce(async function* (request) {
        expect(request.messages).toContainEqual({
          role: "tool",
          toolCallId: "call_agent",
          content: "Error: Subagent failed: The model returned an empty response.",
        })
        yield { type: "text_delta", text: "The subagent failed, so I will look myself." }
      })

    const events = await collect(runAgent("delegate", [], { client }))

    expect(events.find((event) => event.type === "complete")).toBeDefined()
    expect(events.find((event) => event.type === "tool" && event.phase === "end")).toMatchObject({
      toolCallId: "call_agent",
      outcome: "failed",
    })
  })

  it("bounds the child by the parent's step limit", async () => {
    streamMock
      .mockImplementationOnce(async function* () {
        yield delegateCall("call_agent")
      })
      .mockImplementation(async function* () {
        yield { type: "tool_call", toolCall: { id: crypto.randomUUID(), name: "read", arguments: '{"path":"."}' } }
      })

    const events = await collect(runAgent("delegate", [], { client, maxSteps: 2, tools: TOOL_DEFINITIONS }))

    // Parent step 1 delegates; the child spends its 2 steps on reads and fails; the parent takes its second step
    // and then its own limit ends the run.
    expect(
      events.filter(
        (event) =>
          event.type === "subagent" &&
          event.toolCallId === "call_agent" &&
          event.event.type === "tool" &&
          event.event.phase === "end",
      ),
    ).toHaveLength(2)
    expect(
      events.find((event) => event.type === "tool" && event.phase === "end" && event.toolCallId === "call_agent"),
    ).toMatchObject({ outcome: "failed" })
    expect(streamMock).toHaveBeenCalledTimes(4)
    expect(events.find((event) => event.type === "error")?.message).toContain("2-step limit")
  })

  it("interrupts the parent turn when the shared signal aborts during a child run", async () => {
    const controller = new AbortController()
    streamMock
      .mockImplementationOnce(async function* () {
        yield delegateCall("call_agent")
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Child is working" }
        controller.abort()
        throw new Error("request aborted")
      })

    const events = await collect(runAgent("delegate", [], { client, signal: controller.signal }))
    const interrupted = events.find((event) => event.type === "interrupted")

    expect(interrupted?.messages).toEqual([
      { role: "user", content: "delegate" },
      {
        role: "assistant",
        content: [{ type: "tool_call", toolCall: expect.objectContaining({ id: "call_agent", name: "agent" }) }],
      },
      { role: "tool", toolCallId: "call_agent", content: "Tool call interrupted by user." },
    ])
    expect(events.some((event) => event.type === "complete")).toBe(false)
    // The child's own interruption reaches the caller through its envelope, so its trace can be closed out.
    expect(events.filter((event) => event.type === "subagent").map((event) => event.event.type)).toEqual([
      "context",
      "model",
      "delta",
      "interrupted",
    ])
  })

  it("does not delegate when the agent tool is excluded from the enabled tools", async () => {
    streamMock
      .mockImplementationOnce(async function* () {
        yield delegateCall("call_agent")
      })
      .mockImplementationOnce(async function* (request) {
        expect(request.messages).toContainEqual({
          role: "tool",
          toolCallId: "call_agent",
          content: "Tool is not enabled: agent",
        })
        yield { type: "text_delta", text: "Done." }
      })

    const events = await collect(
      runAgent("delegate", [], { client, tools: TOOL_DEFINITIONS.filter((tool) => tool.name !== "agent") }),
    )

    expect(streamMock).toHaveBeenCalledTimes(2)
    expect(events.some((event) => event.type === "tool")).toBe(false)
  })
})

describe("subagent helpers", () => {
  const call = { name: "agent" as const, input: { description: "Map the notes", prompt: "List note files." } }

  it("derives child run options from the parent's resolved options", () => {
    const steering = { drain: async () => [], drainOrClose: async () => [], close: async () => [] }
    const parent = { client, cwd: "/workspace", tools: TOOL_DEFINITIONS, steering, onUsage: vi.fn() }

    const child = subagentRunOptions(parent)

    expect(child.client).toBe(client)
    expect(child.cwd).toBe("/workspace")
    expect(child.onUsage).toBe(parent.onUsage)
    expect(child.steering).toBeUndefined()
    expect(child.maxSteps).toBe(SUBAGENT_MAX_STEPS)
    expect(child.tools?.map((tool) => tool.name)).toEqual(["web_search", "web_read", "skill", "read", "grep", "glob"])
    expect(subagentRunOptions({ ...parent, maxSteps: 7 }).maxSteps).toBe(7)
  })

  it("offers the agent tool for hosted and PAIR models but not the single-slot local runtime", () => {
    const names = (provider: ModelProvider) => providerTools(provider).map((tool) => tool.name)

    expect(supportsDelegation("fireworks")).toBe(true)
    expect(supportsDelegation("pair")).toBe(true)
    expect(supportsDelegation("local")).toBe(false)
    expect(names("fireworks")).toContain("agent")
    expect(names("pair")).toContain("agent")
    expect(names("local")).not.toContain("agent")
    expect(names("local")).toEqual(names("fireworks").filter((name) => name !== "agent"))
  })

  it("never grants mutating tools or further delegation to a child", () => {
    const names = subagentTools(TOOL_DEFINITIONS).map((tool) => tool.name)
    expect(names).not.toContain("agent")
    expect(names).not.toContain("write")
    expect(names).not.toContain("edit")
    expect(names).not.toContain("bash")
  })

  it("briefs the child with the task and the read-only contract", () => {
    const brief = subagentBrief(call)
    expect(brief).toContain("read-only")
    expect(brief).toContain("Task:\nList note files.")
  })

  it("refuses to run the agent tool outside the agent loop", async () => {
    await expect(executeToolCall(call)).rejects.toThrow("runs inside the agent loop")
  })
})

async function collect(events: AsyncGenerator<AgentEvent>) {
  const collected: AgentEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

async function trackedTempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-subagent-"))
  tempDirs.push(path)
  return path
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type StreamRequest = {
  tools: Array<{ name: string }>
  messages: Array<{ role: string; content?: unknown }>
}
