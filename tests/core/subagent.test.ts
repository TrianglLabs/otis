import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type AgentEvent, isCoworkerReport, runAgent, SteeringInbox } from "../../src/core/agent.js"
import type { HostedClient } from "../../src/inference/client.js"
import {
  type ChatMessage,
  HOSTED_PROVIDERS,
  type ModelProvider,
} from "../../src/inference/types.js"
import { createPermissionPolicy, type PermissionRequest } from "../../src/permissions/policy.js"
import { emptySkillCatalog } from "../../src/skills/catalog.js"
import {
  describeToolCall,
  executeToolCall,
  parseSerializedToolCall,
  providerTools,
  TOOL_DEFINITIONS,
} from "../../src/tools/index.js"
import { summaryFixture } from "../support/compaction.js"

const streamMock = vi.hoisted(() => vi.fn())
const client = {
  model: "accounts/fireworks/models/test",
  streamChat: streamMock,
} as unknown as HostedClient

const tempDirs: string[] = []
/** Every request the fake model received, classified and in call order. */
const log: ScriptRequest[] = []

afterEach(async () => {
  streamMock.mockReset()
  log.length = 0
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const STARTED = "Coworker started in the background."
const EMPTY_RESPONSE = "The model returned an empty response."

const text = (text: string) => ({ type: "text_delta" as const, text })
const readCall = (id: string, path = "note.txt") => ({
  type: "tool_call" as const,
  toolCall: { id, name: "read", arguments: JSON.stringify({ path }) },
})
const waitCall = (id = "call_wait") => ({
  type: "tool_call" as const,
  toolCall: { id, name: "wait_coworkers", arguments: "{}" },
})
const delegateCall = (
  id: string,
  description = "Map the notes",
  prompt = "List every note file.",
) => ({
  type: "tool_call" as const,
  toolCall: { id, name: "agent", arguments: JSON.stringify({ description, prompt }) },
})
const report = (title: string, body: string): ChatMessage => ({
  role: "user",
  content: `[Coworker report: ${title}]\n\n${body}`,
})
const failure = (title: string, body: string): ChatMessage => ({
  role: "user",
  content: `[Coworker failed: ${title}]\n\n${body}`,
})
const startedMessage = (id: string, title = "Map the notes") =>
  expect.objectContaining({
    role: "tool",
    toolCallId: id,
    content: expect.stringMatching(
      new RegExp(`^agent: ${title}\n\n${STARTED.replace(".", "\\.")}`),
    ),
  })
/** A parent that delegates first, then answers once every expected report has arrived. */
const delegatingParent = (
  calls: ReturnType<typeof delegateCall>[],
  expectedReports = calls.length,
): Handler =>
  async function* ({ step, messages }) {
    if (step === 0) {
      yield* calls
      return
    }
    yield text(messages.filter(isCoworkerReport).length >= expectedReports ? "Done." : "Waiting.")
  }

describe("agent tool", () => {
  it("answers the agent call at once and starts the parent's next request before the coworker finishes", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "note", "utf8")
    const gate = deferred()
    const timeline: string[] = []
    script({
      parent: async function* ({ step }) {
        if (step === 0) {
          yield delegateCall("call_agent")
          return
        }
        timeline.push(`parent:${step}`)
        if (step === 1) {
          gate.resolve()
          yield text("Nothing more until the coworker reports.")
          return
        }
        yield text("Done.")
      },
      child: async function* ({ step }) {
        if (step === 0) {
          await gate.promise
          yield readCall("read_child")
          return
        }
        timeline.push("child:report")
        yield text("Child report.")
      },
    })

    const events = await collect(runAgent("delegate", [], { client, cwd }))
    const parent = parentRequests()

    expect(timeline).toEqual(["parent:1", "child:report", "parent:2"])
    expect(parent).toHaveLength(3)
    expect(parent[1].messages).toEqual([
      { role: "user", content: "delegate" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            toolCall: expect.objectContaining({ id: "call_agent", name: "agent" }),
          },
        ],
      },
      startedMessage("call_agent"),
    ])
    expect(parent[1].messages[2].content).toContain("call wait_coworkers")
    expect(parent[2].messages).toEqual([
      ...parent[1].messages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Nothing more until the coworker reports." }],
      },
      report("Map the notes", "Child report."),
    ])
    expect(isCoworkerReport(parent[2].messages.at(-1) as ChatMessage)).toBe(true)
    expect(events.at(-1)).toEqual({
      type: "complete",
      messages: [
        ...parent[2].messages,
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
      ],
    })
    // The delegating call closes before any child event surfaces; the loop never waits on it.
    const toolEnd = events.findIndex((event) => event.type === "tool" && event.phase === "end")
    const firstEnvelope = events.findIndex((event) => event.type === "subagent")
    expect(events[toolEnd]).toMatchObject({ toolCallId: "call_agent", outcome: "completed" })
    expect(firstEnvelope).toBeGreaterThan(toolEnd)
    expect(events.filter((event) => event.type === "model")).toHaveLength(3)
  })

  it("delivers each report exactly once while the parent keeps using tools", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "note", "utf8")
    script({
      parent: async function* ({ step, messages }) {
        if (step === 0) {
          yield delegateCall("call_agent")
          return
        }
        if (messages.some(isCoworkerReport)) {
          yield text("Done.")
          return
        }
        yield readCall(`read_${step}`)
      },
      child: async function* () {
        yield text("Child report.")
      },
    })

    const events = await collect(runAgent("delegate", [], { client, cwd }))
    const complete = events.at(-1)

    expect(complete?.type).toBe("complete")
    const messages = complete?.type === "complete" ? complete.messages : []
    expect(messages.filter(isCoworkerReport)).toEqual([report("Map the notes", "Child report.")])
    for (const request of parentRequests())
      expect(request.messages.filter(isCoworkerReport).length).toBeLessThanOrEqual(1)
    // Every parent read ran to completion: no tool call is left without its result.
    const toolCallIds = messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((part) => (part.type === "tool_call" ? [part.toolCall.id] : []))
        : [],
    )
    const answered = messages.flatMap((message) =>
      message.role === "tool" ? [message.toolCallId] : [],
    )
    expect(answered).toEqual(toolCallIds)
  })

  it("waits for a report when the parent answers without tool calls and keeps steering open meanwhile", async () => {
    const steering = new SteeringInbox(async () => undefined)
    const drainOrClose = vi.spyOn(steering, "drainOrClose")
    const gate = deferred()
    script({
      parent: async function* ({ step }) {
        if (step === 0) {
          yield delegateCall("call_agent")
          return
        }
        yield text(step === 1 ? "Nothing more until the coworker reports." : "Done.")
      },
      child: async function* () {
        await gate.promise
        yield text("Child report.")
      },
    })

    const run = runAgent("delegate", [], { client, steering, skills: emptySkillCatalog() })
    const events: AgentEvent[] = []
    let answered = false
    // Drive the parent to the point where it has answered without tool calls.
    while (true) {
      const { value } = await run.next()
      events.push(value)
      answered ||= value.type === "delta"
      if (answered && value.type === "context") break
    }
    // The parent now drains steering and parks waiting for a report; the inbox stays open.
    const parked = run.next()
    await tick()
    expect(steering.accept({ role: "user", content: "Also check the tests." }).accepted).toBe(true)
    expect(drainOrClose).not.toHaveBeenCalled()
    gate.resolve()
    events.push((await parked).value)
    for await (const event of run) events.push(event)

    const parent = parentRequests()
    expect(parent).toHaveLength(3)
    expect(parent[2].messages.slice(-3)).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Nothing more until the coworker reports." }],
      },
      { role: "user", content: "Also check the tests." },
      report("Map the notes", "Child report."),
    ])
    expect(childRequests().every((request) => request.messages.length === 1)).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "complete" })
    // The inbox closes only once no coworker is pending.
    expect(drainOrClose).toHaveBeenCalledTimes(1)
    expect(steering.accept({ role: "user", content: "late" })).toEqual({ accepted: false })
  })

  it("resumes the model after each report as coworkers finish one at a time", async () => {
    const gates = { "Read a": deferred(), "Read b": deferred() }
    script({
      parent: async function* ({ step }) {
        if (step === 0) {
          yield delegateCall("call_a", "Read a", "Read a")
          yield delegateCall("call_b", "Read b", "Read b")
          return
        }
        if (step === 1) gates["Read a"].resolve()
        if (step === 2) gates["Read b"].resolve()
        yield text(step === 3 ? "Done." : "Waiting.")
      },
      child: async function* ({ task }) {
        await gates[task as keyof typeof gates].promise
        yield text(`Report ${task}.`)
      },
    })

    const events = await collect(
      runAgent("delegate both", [], { client, skills: emptySkillCatalog() }),
    )
    const parent = parentRequests()

    expect(parent).toHaveLength(4)
    expect(parent[1].messages.filter(isCoworkerReport)).toEqual([])
    expect(parent[2].messages.filter(isCoworkerReport)).toEqual([
      report("Read a", "Report Read a."),
    ])
    expect(parent[3].messages.filter(isCoworkerReport)).toEqual([
      report("Read a", "Report Read a."),
      report("Read b", "Report Read b."),
    ])
    expect(events.at(-1)).toMatchObject({ type: "complete" })
    expect(events.filter((event) => event.type === "model")).toHaveLength(4)
  })

  it("wait_coworkers waits for every coworker and returns their reports as tool output", async () => {
    const gate = deferred()
    script({
      parent: async function* ({ step }) {
        if (step === 0) {
          yield delegateCall("call_a", "A", "Task A")
          yield delegateCall("call_b", "B", "Task B")
          return
        }
        if (step === 1) {
          // Children finish only once the parent is already waiting on them.
          setTimeout(gate.resolve, 0)
          yield waitCall()
          return
        }
        yield text("Done.")
      },
      child: async function* ({ task }) {
        await gate.promise
        if (task === "Task A") yield text("Report A.")
      },
    })

    const events = await collect(
      runAgent("delegate both", [], { client, skills: emptySkillCatalog() }),
    )
    const parent = parentRequests()

    expect(parent).toHaveLength(3)
    expect(parent[2].messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call_wait",
      content: [
        "wait_coworkers: 2 coworker report(s)",
        "[Coworker report: A]",
        "Report A.",
        "[Coworker failed: B]",
        EMPTY_RESPONSE,
      ].join("\n\n"),
    })
    expect(parent[2].messages.some(isCoworkerReport)).toBe(false)
    const complete = events.at(-1)
    expect(complete?.type).toBe("complete")
    expect(complete?.type === "complete" && complete.messages.some(isCoworkerReport)).toBe(false)
    const index = (predicate: (event: AgentEvent) => boolean) => events.findIndex(predicate)
    const waitStart = index(
      (event) =>
        event.type === "tool" && event.phase === "start" && event.name === "wait_coworkers",
    )
    const waitEnd = index(
      (event) => event.type === "tool" && event.phase === "end" && event.name === "wait_coworkers",
    )
    const settledA = index(
      (event) =>
        event.type === "subagent" &&
        event.toolCallId === "call_a" &&
        event.event.type === "complete",
    )
    const settledB = index(
      (event) =>
        event.type === "subagent" && event.toolCallId === "call_b" && event.event.type === "error",
    )
    expect(events[waitStart]).toMatchObject({
      toolCallId: "call_wait",
      activityKind: "agent",
      label: "Waiting for coworkers: coworker reports",
    })
    expect(events[waitEnd]).toMatchObject({ toolCallId: "call_wait", outcome: "completed" })
    expect(waitStart).toBeLessThan(settledA)
    expect(waitStart).toBeLessThan(settledB)
    expect(Math.max(settledA, settledB)).toBeLessThan(waitEnd)
  })

  it("wait_coworkers answers at once when no coworker is working", async () => {
    script({
      parent: async function* ({ step }) {
        if (step === 0) {
          yield waitCall()
          return
        }
        yield text("Done.")
      },
    })

    const events = await collect(runAgent("check", [], { client, skills: emptySkillCatalog() }))

    expect(parentRequests()[1].messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call_wait",
      content: "wait_coworkers: No coworkers are working.\n\n",
    })
    expect(events.filter((event) => event.type === "tool")).toMatchObject([
      { phase: "start", name: "wait_coworkers", activityKind: "agent" },
      { phase: "end", name: "wait_coworkers", outcome: "completed" },
    ])
    expect(events.some((event) => event.type === "subagent")).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: "complete" })
  })

  it("runs the delegated brief in a fresh context and hands the parent only the final report", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "first line", "utf8")
    const gate = deferred()
    script({
      parent: async function* ({ step }) {
        if (step === 0) {
          yield text("Let me delegate this.")
          yield delegateCall("call_agent")
          return
        }
        if (step === 1) gate.resolve()
        yield text(step === 1 ? "Waiting." : "Done.")
      },
      child: async function* ({ step }) {
        if (step === 0) {
          await gate.promise
          yield {
            type: "reasoning_delta",
            text: "Private child reasoning.",
            field: "reasoning_content",
          }
          yield text("Child interim text.")
          yield readCall("call_read")
          return
        }
        yield text("Report: note.txt starts with 'first line'.")
      },
    })

    const events = await collect(
      runAgent("map the notes", [{ role: "user", content: "earlier context" }], { client, cwd }),
    )
    const complete = events.find((event) => event.type === "complete")
    const child = childRequests()
    const parent = parentRequests()

    expect(child).toHaveLength(2)
    // The child starts from the brief alone, never the parent's history.
    expect(child[0].messages).toHaveLength(1)
    const brief = child[0].messages[0].content as string
    expect(brief).toContain("You are an Otis subagent.")
    expect(brief).toContain("Your tools are read-only.")
    expect(brief).toContain("Task:\nList every note file.")
    expect(brief).not.toContain("earlier context")
    // The child keeps its own tool history across its steps.
    expect(child[1].messages).toMatchObject([
      { role: "user" },
      {
        role: "assistant",
        content: [{ type: "reasoning" }, { type: "text" }, { type: "tool_call" }],
      },
      { role: "tool", toolCallId: "call_read", content: expect.stringContaining("first line") },
    ])
    // The parent sees the start notice as the tool result and the report as a later message.
    expect(parent[2].messages).toEqual([
      { role: "user", content: "earlier context" },
      { role: "user", content: "map the notes" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me delegate this." },
          {
            type: "tool_call",
            toolCall: expect.objectContaining({ id: "call_agent", name: "agent" }),
          },
        ],
      },
      startedMessage("call_agent"),
      { role: "assistant", content: [{ type: "text", text: "Waiting." }] },
      report("Map the notes", "Report: note.txt starts with 'first line'."),
    ])
    expect(complete?.messages).toEqual(
      parent[2].messages
        .slice(1)
        .concat({ role: "assistant", content: [{ type: "text", text: "Done." }] }),
    )
  })

  it("wraps every child event in a subagent envelope and keeps the parent's own stream clean", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "first line", "utf8")
    const gate = deferred()
    script({
      parent: async function* ({ step }) {
        if (step === 0) {
          yield delegateCall("call_agent")
          return
        }
        if (step === 1) gate.resolve()
        yield text(step === 1 ? "Waiting." : "Done.")
      },
      child: async function* ({ step }) {
        if (step === 0) {
          await gate.promise
          yield {
            type: "reasoning_delta",
            text: "Private child reasoning.",
            field: "reasoning_content",
          }
          yield text("Child interim text.")
          yield readCall("call_read")
          return
        }
        yield text("Report.")
      },
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
    expect(
      envelopes.every(
        (event) => event.toolCallId === "call_agent" && event.title === "Map the notes",
      ),
    ).toBe(true)
    const child = envelopes.map((event) => event.event)
    expect(child.filter((event) => event.type === "tool")).toMatchObject([
      { phase: "start", toolCallId: "call_read", name: "read" },
      { phase: "end", toolCallId: "call_read", name: "read", outcome: "completed" },
    ])
    expect(child.filter((event) => event.type === "reasoning").map((event) => event.phase)).toEqual(
      ["start", "delta", "end"],
    )
    expect(child.filter((event) => event.type === "delta").map((event) => event.text)).toEqual([
      "Child interim text.",
      "Report.",
    ])
    expect(child.at(-1)).toMatchObject({ type: "complete" })
    // The parent's own stream carries none of the child's text, reasoning, or context accounting.
    expect(events.some((event) => event.type === "delta" && event.text.includes("Child"))).toBe(
      false,
    )
    expect(events.some((event) => event.type === "reasoning")).toBe(false)
    expect(
      events.filter((event) => event.type === "context").map((event) => event.messageCount),
    ).toEqual([1, 2, 3, 4, 5, 6])
    expect(events.filter((event) => event.type === "model")).toHaveLength(3)
  })

  it("forwards child events that land while the caller holds the parent between events", async () => {
    const childGate = deferred()
    const parentGate = deferred()
    script({
      parent: async function* ({ step }) {
        if (step === 0) {
          yield delegateCall("call_agent")
          return
        }
        await parentGate.promise
        yield text("Done.")
      },
      child: async function* () {
        await childGate.promise
        yield text("Child report.")
      },
    })

    const run = runAgent("delegate", [], { client, skills: emptySkillCatalog() })
    const events: AgentEvent[] = []
    const seen = (predicate: (event: AgentEvent) => boolean) => events.some(predicate)
    const driveUntil = async (predicate: (event: AgentEvent) => boolean) => {
      while (!seen(predicate)) events.push((await run.next()).value)
    }
    await driveUntil((event) => event.type === "subagent" && event.event.type === "model")
    // The parent sits on a yield while the child finishes, so nothing is waiting on the wake.
    childGate.resolve()
    await tick()
    const forwarded = driveUntil(
      (event) => event.type === "subagent" && event.event.type === "complete",
    )
    await Promise.race([forwarded, tick()])
    // The child's ending surfaces although the parent's own request is still streaming.
    expect(events.at(-1)).toMatchObject({ type: "subagent", event: { type: "complete" } })
    parentGate.resolve()
    await forwarded
    for await (const event of run) events.push(event)

    expect(events.at(-1)).toMatchObject({ type: "complete" })
    const childEnd = events.findIndex(
      (event) => event.type === "subagent" && event.event.type === "complete",
    )
    expect(childEnd).toBeLessThan(events.findIndex((event) => event.type === "delta"))
    expect(events.filter((event) => event.type === "subagent").at(-1)).toBe(events[childEnd])
    expect(parentRequests().at(-1)?.messages.at(-1)).toEqual(
      report("Map the notes", "Child report."),
    )
  })

  it("gives children only the read-only subset of the parent's tools", async () => {
    script({
      parent: delegatingParent([delegateCall("call_agent")]),
      child: async function* () {
        yield text("Report.")
      },
    })

    await collect(runAgent("delegate", [], { client, skills: emptySkillCatalog() }))

    expect(childRequests().map((request) => request.tools)).toEqual([
      ["web_search", "web_read", "recall", "read", "grep", "glob"],
    ])
  })

  it("runs adjacent agent calls concurrently and delivers both reports", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "a.txt"), "alpha", "utf8")
    await writeFile(join(cwd, "b.txt"), "beta", "utf8")
    const timeline: string[] = []
    const gate = deferred()
    script({
      parent: delegatingParent([
        delegateCall("call_a", "Read a", "Read a.txt"),
        delegateCall("call_b", "Read b", "Read b.txt"),
      ]),
      child: async function* ({ step, task }) {
        const name = task?.includes("a.txt") ? "a" : "b"
        if (step === 0) {
          timeline.push(`${name}:start`)
          // Child A blocks until child B has started, proving they run at the same time.
          if (name === "a") await gate.promise
          else gate.resolve()
          yield readCall(`read_${name}`, `${name}.txt`)
          return
        }
        timeline.push(`${name}:report`)
        yield text(`Report ${name}.`)
      },
    })

    const events = await collect(runAgent("delegate both", [], { client, cwd }))
    const complete = events.find((event) => event.type === "complete")

    // Both children start before either reports; a blocking loop would deadlock on the gate.
    expect(timeline.slice(0, 2).sort()).toEqual(["a:start", "b:start"])
    expect(complete?.messages.filter((message) => message.role === "tool")).toEqual([
      startedMessage("call_a", "Read a"),
      startedMessage("call_b", "Read b"),
    ])
    // Reports arrive as each child finishes, so B (which A waited on) may report first.
    expect(sortedByContent(complete?.messages.filter(isCoworkerReport) ?? [])).toEqual([
      report("Read a", "Report a."),
      report("Read b", "Report b."),
    ])
    const childToolEvents = (toolCallId: string) =>
      events.filter(
        (event) =>
          event.type === "subagent" &&
          event.toolCallId === toolCallId &&
          event.event.type === "tool",
      )
    expect(childToolEvents("call_a")).toHaveLength(2)
    expect(childToolEvents("call_b")).toHaveLength(2)
    expect(
      events.flatMap((event) =>
        event.type === "tool" && event.phase === "start" ? [event.toolCallId] : [],
      ),
    ).toEqual(["call_a", "call_b"])
  })

  it("runs tool calls one at a time in the model's order while agent calls only start coworkers", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "note", "utf8")
    const order: string[] = []
    script({
      parent: async function* ({ step, messages }) {
        if (step === 0) {
          yield readCall("read_1")
          yield delegateCall("call_a", "A", "Task A")
          yield delegateCall("call_b", "B", "Task B")
          yield readCall("read_2")
          return
        }
        yield text(messages.filter(isCoworkerReport).length === 2 ? "Done." : "Waiting.")
      },
      child: async function* ({ task }) {
        order.push(task === "Task A" ? "child-a" : "child-b")
        yield text("Report.")
      },
    })

    const events = await collect(runAgent("mixed", [], { client, cwd }))

    expect(
      events.flatMap((event) =>
        event.type === "tool" ? [`${event.toolCallId}:${event.phase}`] : [],
      ),
    ).toEqual([
      "read_1:start",
      "read_1:end",
      "call_a:start",
      "call_a:end",
      "call_b:start",
      "call_b:end",
      "read_2:start",
      "read_2:end",
    ])
    expect(order.sort()).toEqual(["child-a", "child-b"])
    expect(events.at(-1)).toMatchObject({ type: "complete" })
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
    script({
      parent: delegatingParent([
        delegateCall("call_a", "A", "Task A"),
        delegateCall("call_b", "B", "Task B"),
      ]),
      child: async function* ({ step }) {
        if (step === 0) yield readCall("read_env", "secret.env")
        else yield text("Report.")
      },
    })
    const permissionPolicy = createPermissionPolicy({
      cwd,
      mode: "auto",
      rules: [{ tool: "read", resource: "*.env", effect: "ask" }],
    })

    const events = await collect(
      runAgent("delegate both", [], { client, cwd, permissionPolicy, onPermissionRequest }),
    )

    expect(onPermissionRequest).toHaveBeenCalledTimes(2)
    expect(maxInFlight).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: "complete" })
  })

  it("lets a later child's approval proceed after an earlier child's approval request fails", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "secret.env"), "x", "utf8")
    const onPermissionRequest = vi.fn(async (_request: PermissionRequest) => {
      if (onPermissionRequest.mock.calls.length === 1) throw new Error("approval surface crashed")
      return true
    })
    script({
      parent: delegatingParent([
        delegateCall("call_a", "A", "Task A"),
        delegateCall("call_b", "B", "Task B"),
      ]),
      child: async function* ({ step, messages }) {
        if (step === 0) {
          yield readCall("read_env", "secret.env")
          return
        }
        const tool = messages.find((message) => message.role === "tool")
        yield text(String(tool?.content).startsWith("Error:") ? "denied" : "read")
      },
    })
    const permissionPolicy = createPermissionPolicy({
      cwd,
      mode: "auto",
      rules: [{ tool: "read", resource: "*.env", effect: "ask" }],
    })

    const events = await collect(
      runAgent("delegate both", [], { client, cwd, permissionPolicy, onPermissionRequest }),
    )
    const complete = events.find((event) => event.type === "complete")
    const reports = complete?.messages
      .filter(isCoworkerReport)
      .map((message) => String(message.content).split("\n\n")[1])

    expect(onPermissionRequest).toHaveBeenCalledTimes(2)
    expect(reports?.sort()).toEqual(["denied", "read"])
  })

  it("keeps parent steering out of the child and delivers it to the parent's next request", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "note", "utf8")
    const steering = new SteeringInbox(async () => undefined)
    const steer: ChatMessage = { role: "user", content: "Also check the tests." }
    const gate = deferred()
    script({
      parent: async function* ({ step, messages }) {
        if (step === 0) {
          yield delegateCall("call_agent")
          return
        }
        if (step === 1) gate.resolve()
        yield text(messages.some(isCoworkerReport) ? "Done." : "Waiting.")
      },
      child: async function* ({ step }) {
        if (step === 0) {
          await gate.promise
          // Steering lands while the parent's own request is still streaming.
          steering.accept(steer)
          yield readCall("read_1")
          return
        }
        yield text("Report.")
      },
    })

    const events = await collect(runAgent("delegate", [], { client, cwd, steering }))
    const parent = parentRequests()

    expect(events.at(-1)?.type).toBe("complete")
    expect(childRequests()).toHaveLength(2)
    for (const request of childRequests()) expect(request.messages).not.toContainEqual(steer)
    // The steering message re-prompts the parent on its own; the report follows once ready.
    expect(parent).toHaveLength(4)
    expect(parent[1].messages).not.toContainEqual(steer)
    expect(parent[2].messages.at(-1)).toEqual(steer)
    expect(parent[2].messages.some(isCoworkerReport)).toBe(false)
    expect(parent[3].messages.at(-1)).toEqual(report("Map the notes", "Report."))
    const complete = events.at(-1)
    expect(complete?.type === "complete" && complete.messages.filter(isCoworkerReport)).toEqual([
      report("Map the notes", "Report."),
    ])
  })

  it("reports a failed child as a failure message and lets the parent continue", async () => {
    const gate = deferred()
    script({
      parent: async function* ({ step }) {
        if (step === 0) {
          yield delegateCall("call_agent")
          return
        }
        if (step === 1) gate.resolve()
        yield text(step === 1 ? "Waiting." : "The coworker failed, so I will look myself.")
      },
      child: async function* () {
        await gate.promise
        yield* []
      },
    })

    const events = await collect(runAgent("delegate", [], { client, skills: emptySkillCatalog() }))
    const parent = parentRequests()

    expect(parent).toHaveLength(3)
    expect(parent[2].messages.at(-1)).toEqual(failure("Map the notes", EMPTY_RESPONSE))
    expect(isCoworkerReport(parent[2].messages.at(-1) as ChatMessage)).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "complete" })
    // Starting the coworker succeeded; only the child's own trace records the failure.
    expect(events.find((event) => event.type === "tool" && event.phase === "end")).toMatchObject({
      toolCallId: "call_agent",
      outcome: "completed",
    })
    expect(
      events.find((event) => event.type === "subagent" && event.event.type === "error"),
    ).toMatchObject({ toolCallId: "call_agent", event: { message: EMPTY_RESPONSE } })
  })

  it("compacts a long child without checkpointing or inflating the parent's context", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "note", "utf8")
    const parentCheckpoint = vi.fn()
    script({
      parent: delegatingParent([delegateCall("call_agent")]),
      child: async function* ({ step, task }) {
        if (task && step === 0) {
          yield { type: "reasoning_delta", field: "reasoning_content", text: "x".repeat(100_000) }
          yield readCall("read_1")
          yield {
            type: "usage",
            usage: { promptTokens: 2_000, completionTokens: 25_000, totalTokens: 27_000 },
          }
          return
        }
        yield text("Child report.")
      },
      summary: async function* () {
        yield text(summaryFixture("Child progress summarized."))
      },
    })

    const events = await collect(
      runAgent("delegate", [], {
        client,
        cwd,
        autoCompactAtTokens: 20_000,
        onCompaction: parentCheckpoint,
      }),
    )

    expect(events.at(-1)).toMatchObject({
      type: "complete",
      messages: expect.arrayContaining([report("Map the notes", "Child report.")]),
    })
    expect(
      events.filter(
        (event) =>
          event.type === "subagent" &&
          event.event.type === "compaction" &&
          event.event.phase === "complete",
      ),
    ).toHaveLength(1)
    expect(parentCheckpoint).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === "compaction")).toBe(false)
    expect(log.filter((request) => request.role === "summary")).toHaveLength(1)
    // After compaction the child continues from its summary, not the brief.
    expect(childRequests()).toHaveLength(2)
    expect(childRequests()[1].task).toBeUndefined()
  })

  it("lets a child finish beyond 50 model steps", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "note", "utf8")
    script({
      parent: delegatingParent([delegateCall("call_agent")]),
      child: async function* ({ step }) {
        if (step < 51) yield readCall(`read_${step}`)
        else yield text("Child report.")
      },
    })

    const events = await collect(runAgent("delegate", [], { client, cwd }))

    expect(events.at(-1)).toMatchObject({
      type: "complete",
      messages: expect.arrayContaining([report("Map the notes", "Child report.")]),
    })
    expect(childRequests()).toHaveLength(52)
  })

  it("interrupts the parent turn and the running child when the parent's signal aborts", async () => {
    const controller = new AbortController()
    const gate = deferred()
    let childSignal: AbortSignal | undefined
    script({
      parent: async function* ({ step, signal }) {
        if (step === 0) {
          yield delegateCall("call_agent")
          return
        }
        gate.resolve()
        await aborted(signal as AbortSignal)
        // Let the child's own interruption land before this request fails.
        await tick()
        throw new Error("request aborted")
      },
      child: async function* ({ signal }) {
        childSignal = signal
        await gate.promise
        yield text("Child is working")
        controller.abort()
        throw new Error("request aborted")
      },
    })

    const events = await collect(
      runAgent("delegate", [], { client, signal: controller.signal, skills: emptySkillCatalog() }),
    )
    const interrupted = events.find((event) => event.type === "interrupted")

    expect(childSignal).not.toBe(controller.signal)
    expect(childSignal?.aborted).toBe(true)
    expect(interrupted?.messages).toEqual([
      { role: "user", content: "delegate" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            toolCall: expect.objectContaining({ id: "call_agent", name: "agent" }),
          },
        ],
      },
      startedMessage("call_agent"),
    ])
    expect(events.at(-1)).toBe(interrupted)
    expect(events.some((event) => event.type === "complete")).toBe(false)
    // The child's own interruption reaches the caller through its envelope while the parent's
    // request is still in flight, so its trace can be closed out.
    expect(
      events.filter((event) => event.type === "subagent").map((event) => event.event.type),
    ).toEqual(["context", "model", "delta", "context", "interrupted"])
  })

  it("cancels running coworkers when the parent fails", async () => {
    let childSignal: AbortSignal | undefined
    script({
      parent: async function* ({ step }) {
        if (step === 0) {
          yield delegateCall("call_agent")
          return
        }
        throw new Error("model exploded")
      },
      child: async function* ({ signal }) {
        childSignal = signal
        // The child produces nothing until the parent's failure cancels it.
        await aborted(signal as AbortSignal)
        yield* []
        throw new Error("request aborted")
      },
    })

    const events = await collect(runAgent("delegate", [], { client, skills: emptySkillCatalog() }))

    expect(events.at(-1)).toEqual({
      type: "error",
      message: "model exploded",
      messages: [
        { role: "user", content: "delegate" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              toolCall: expect.objectContaining({ id: "call_agent", name: "agent" }),
            },
          ],
        },
        startedMessage("call_agent"),
      ],
    })
    expect(childSignal?.aborted).toBe(true)
    // The cancelled child's own ending is forwarded before the parent's terminal event, so the
    // coworker trace closes as interrupted instead of staying open.
    const childEnd = events.findIndex(
      (event) => event.type === "subagent" && event.event.type === "interrupted",
    )
    expect(childEnd).toBeGreaterThan(-1)
    expect(childEnd).toBeLessThan(events.length - 1)
  })

  it("does not delegate when the agent tool is excluded from the enabled tools", async () => {
    script({
      parent: async function* ({ step, messages }) {
        if (step === 0) {
          yield delegateCall("call_agent")
          return
        }
        expect(messages).toContainEqual({
          role: "tool",
          toolCallId: "call_agent",
          content: "Tool is not enabled: agent",
        })
        yield text("Done.")
      },
    })

    const events = await collect(
      runAgent("delegate", [], {
        client,
        skills: emptySkillCatalog(),
        tools: TOOL_DEFINITIONS.filter((tool) => tool.name !== "agent"),
      }),
    )

    expect(streamMock).toHaveBeenCalledTimes(2)
    expect(events.some((event) => event.type === "tool")).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: "complete" })
  })
})

describe("subagent helpers", () => {
  it("offers agent and wait_coworkers for every hosted provider, PAIR, and oMLX but not the single-slot local runtime", () => {
    const names = (provider: ModelProvider) => providerTools(provider).map((tool) => tool.name)

    for (const provider of [...HOSTED_PROVIDERS, "pair", "omlx"] as const) {
      expect(names(provider), provider).toContain("agent")
      expect(names(provider), provider).toContain("wait_coworkers")
    }
    expect(names("local")).not.toContain("agent")
    expect(names("local")).not.toContain("wait_coworkers")
    expect(names("local")).toEqual(
      names("fireworks").filter((name) => name !== "agent" && name !== "wait_coworkers"),
    )
  })

  it("defines wait_coworkers as an input-free tool shown as agent activity", () => {
    expect(
      TOOL_DEFINITIONS.find((tool) => tool.name === "wait_coworkers")?.parameters,
    ).toMatchObject({ type: "object", properties: {} })
    const call = parseSerializedToolCall("wait_coworkers", "")
    expect(call).toEqual({ name: "wait_coworkers", input: {} })
    expect(describeToolCall(call)).toMatchObject({ kind: "agent", action: "wait_coworkers" })
  })

  it("refuses to run the loop-only tools outside the agent loop", async () => {
    await expect(
      executeToolCall({
        name: "agent",
        input: { description: "Map the notes", prompt: "List note files." },
      }),
    ).rejects.toThrow("The agent tool runs inside the agent loop")
    await expect(executeToolCall({ name: "wait_coworkers", input: {} })).rejects.toThrow(
      "The wait_coworkers tool runs inside the agent loop",
    )
  })
})

type Role = "parent" | "child" | "summary"
type ScriptRequest = {
  role: Role
  /** The delegated task from the child's brief; absent for the parent and after compaction. */
  task: string | undefined
  /** The request's ordinal among those of the same role and task. */
  step: number
  messages: ChatMessage[]
  tools: string[]
  signal: AbortSignal | undefined
}
type Handler = (request: ScriptRequest) => AsyncGenerator<unknown>
type RawRequest = {
  messages: ChatMessage[]
  tools: Array<{ name: string }>
  systemPrompt: string
  signal?: AbortSignal
}

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "web_search",
  "web_read",
  "skill",
  "recall",
])

/**
 * Routes fake responses by request content, since a background child's requests interleave with
 * the parent's: summaries by their system prompt, children by their read-only tool set.
 */
function script(handlers: Partial<Record<Role, Handler>>) {
  const steps = new Map<string, number>()
  streamMock.mockImplementation((raw: RawRequest) => {
    const tools = raw.tools.map((tool) => tool.name)
    const role: Role = raw.systemPrompt.includes("You are a conversation summarizer")
      ? "summary"
      : tools.every((name) => READ_ONLY_TOOLS.has(name))
        ? "child"
        : "parent"
    const first = raw.messages[0]?.content
    const task =
      role === "child" && typeof first === "string" ? first.split("\nTask:\n")[1] : undefined
    const key = `${role}:${task ?? ""}`
    const step = steps.get(key) ?? 0
    steps.set(key, step + 1)
    const request: ScriptRequest = {
      role,
      task,
      step,
      messages: clone(raw.messages),
      tools,
      signal: raw.signal,
    }
    log.push(request)
    const handler = handlers[role]
    if (!handler) throw new Error(`Unexpected ${role} request`)
    return handler(request)
  })
}

const parentRequests = () => log.filter((request) => request.role === "parent")
const childRequests = () => log.filter((request) => request.role === "child")

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

function sortedByContent(messages: ChatMessage[]) {
  return [...messages].sort((left, right) =>
    String(left.content).localeCompare(String(right.content)),
  )
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

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener("abort", () => resolve(), { once: true })
  })
