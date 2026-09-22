import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ArtifactPublisher } from "../../src/artifacts/publisher.js"
import { type AgentEvent, runAgent, SteeringInbox } from "../../src/core/agent.js"
import type { FireworksClient } from "../../src/inference/client.js"
import { createDocumentAttachment } from "../../src/inference/documents.js"
import { createPermissionPolicy, type PermissionRequest } from "../../src/permissions/policy.js"
import { emptySkillCatalog } from "../../src/skills/index.js"
import { minimalDocx } from "../inference/support/document-fixtures.js"

const streamAgentMock = vi.hoisted(() => vi.fn())
const client = {
  model: "accounts/fireworks/models/test",
  streamChat: streamAgentMock,
} as unknown as FireworksClient

const tempDirs: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  streamAgentMock.mockReset()
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("runAgent", () => {
  it("adapts an uploaded Word document through original bytes and publishes the edited Word file", async () => {
    const cwd = await trackedTempDir()
    const source = await minimalDocx("Experienced engineer")
    const attachment = await createDocumentAttachment(source, "resume.docx")
    streamAgentMock
      .mockImplementationOnce(async function* (request) {
        expect(request.systemPrompt).toContain("preserve its file type")
        for (const [name, args] of [
          ["save_attachment", { attachment: attachment.sha256, path: "source.docx" }],
          [
            "edit_document",
            {
              path: "source.docx",
              output_path: "adapted.docx",
              replacements: [{ old: "Experienced engineer", new: "Experienced software engineer" }],
            },
          ],
          ["publish_artifact", { path: "adapted.docx" }],
        ] as const)
          yield { type: "tool_call", toolCall: { id: name, name, arguments: JSON.stringify(args) } }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Created the adapted Word document." }
      })
    const events = await collect(
      runAgent(
        { role: "user", content: [attachment, { type: "text", text: "Adapt my resume" }] },
        [],
        {
          client,
          cwd,
          artifactPublisher: new ArtifactPublisher(join(cwd, "private-artifacts")),
        },
      ),
    )
    expect(await readFile(join(cwd, "source.docx"))).toEqual(Buffer.from(source))
    const edited = await createDocumentAttachment(
      await readFile(join(cwd, "adapted.docx")),
      "adapted.docx",
    )
    expect(edited.extractedText).toBe("Experienced software engineer")
    const tools = events.filter((event) => event.type === "tool" && event.phase === "end")
    expect(tools).toHaveLength(3)
    expect(tools.every((event) => event.type === "tool" && event.outcome === "completed")).toBe(
      true,
    )
    expect(tools.at(-1)).toMatchObject({
      artifact: { source: "published", kind: "docx", name: "adapted.docx" },
    })
  })

  it.each([
    "approve",
    "deny",
    "headless",
  ] as const)("%s: gates external publication and emits a card only on success", async (mode) => {
    const cwd = await trackedTempDir()
    const outside = await trackedTempDir()
    const path = join(outside, "result.html")
    await writeFile(path, "<h1>Private preview content</h1>")
    streamAgentMock
      .mockImplementationOnce(async function* () {
        yield {
          type: "tool_call",
          toolCall: {
            id: "publish_1",
            name: "publish_artifact",
            arguments: JSON.stringify({ path }),
          },
        }
      })
      .mockImplementationOnce(async function* (request) {
        expect(JSON.stringify(request.messages)).not.toContain("Private preview content")
        yield { type: "text_delta", text: "Done." }
      })
    const onPermissionRequest =
      mode === "headless" ? undefined : vi.fn(async () => mode === "approve")
    const events = await collect(
      runAgent("Present the page", [], {
        client,
        cwd,
        dataDirectory: join(cwd, "private"),
        artifactPublisher: new ArtifactPublisher(join(cwd, "session.jsonl.artifacts")),
        permissionPolicy: createPermissionPolicy({ cwd, mode: "auto" }),
        onPermissionRequest,
      }),
    )
    const end = events.find((event) => event.type === "tool" && event.phase === "end")
    expect(end).toMatchObject({ outcome: mode === "approve" ? "completed" : "denied" })
    if (mode === "approve")
      expect(end).toMatchObject({ artifact: { source: "published", name: "result.html" } })
    else expect(end).toMatchObject({ artifact: undefined })
    if (onPermissionRequest) expect(onPermissionRequest).toHaveBeenCalledOnce()
  })

  it("does not execute a tool omitted from the enabled tool definitions", async () => {
    streamAgentMock
      .mockImplementationOnce(async function* () {
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", name: "bash", arguments: '{"command":"exit 9"}' },
        }
      })
      .mockImplementationOnce(async function* (request) {
        expect(request.messages).toContainEqual({
          role: "tool",
          toolCallId: "call_1",
          content: "Tool is not enabled: bash",
        })
        yield { type: "text_delta", text: "Done." }
      })

    const events = await collect(runAgent("run it", [], { client, tools: [] }))

    expect(events.find((event) => event.type === "complete")).toBeDefined()
    expect(events.some((event) => event.type === "tool")).toBe(false)
  })

  it("preserves pre-tool streamed text and tool calls as assistant parts", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "tool result", "utf8")
    const requests: unknown[] = []
    streamAgentMock
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request))
        yield { type: "text_delta", text: "I'll inspect that first." }
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' },
        }
      })
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request))
        yield { type: "text_delta", text: "Final answer." }
      })

    const events = await collect(runAgent("read the note", [], { client, cwd }))
    const complete = events.find((event) => event.type === "complete")
    const toolCallMessage = complete?.messages.find(
      (message) =>
        message.role === "assistant" && message.content.some((part) => part.type === "tool_call"),
    )

    expect(toolCallMessage).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "I'll inspect that first." },
        {
          type: "tool_call",
          toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' },
        },
      ],
    })
    expect(requests[0]).toMatchObject({
      messages: [{ role: "user", content: "read the note" }],
    })
  })

  it("preserves streamed reasoning on assistant tool-call turns", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "tool result", "utf8")
    const requests: StreamAgentRequest[] = []
    streamAgentMock
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request) as StreamAgentRequest)
        yield {
          type: "reasoning_delta",
          text: "I need the file contents.",
          field: "reasoning_content",
        }
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' },
        }
      })
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request) as StreamAgentRequest)
        yield { type: "text_delta", text: "Final answer." }
      })

    const events = await collect(runAgent("read the note", [], { client, cwd }))
    const assistant = requests[1]?.messages.find((message) => message.role === "assistant")

    expect(events.some((event) => event.type === "delta" && event.text.includes("I need"))).toBe(
      false,
    )
    expect(assistant).toMatchObject({
      role: "assistant",
      content: [
        { type: "reasoning", text: "I need the file contents.", field: "reasoning_content" },
        {
          type: "tool_call",
          toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' },
        },
      ],
    })
  })

  it("emits a reasoning event while reasoning streams, before any text delta", async () => {
    const cwd = await trackedTempDir()
    streamAgentMock.mockImplementationOnce(async function* () {
      yield { type: "reasoning_delta", text: "Let me think.", field: "reasoning_content" }
      yield { type: "text_delta", text: "Answer." }
    })

    const events = await collect(runAgent("think out loud", [], { client, cwd }))
    const reasoningEvents = events.filter((event) => event.type === "reasoning")
    const reasoningIndex = events.findIndex((event) => event.type === "reasoning")
    const deltaIndex = events.findIndex((event) => event.type === "delta")

    expect(reasoningEvents.map((event) => event.phase)).toEqual(["start", "delta", "end"])
    expect(new Set(reasoningEvents.map((event) => event.reasoningId)).size).toBe(1)
    expect(reasoningEvents[1]).toMatchObject({ phase: "delta", text: "Let me think." })
    expect(reasoningEvents[2]).toMatchObject({ phase: "end", durationMs: expect.any(Number) })
    expect(reasoningIndex).toBeGreaterThanOrEqual(0)
    expect(deltaIndex).toBeGreaterThan(reasoningIndex)
  })

  it("does not emit reasoning events for text-only responses", async () => {
    const cwd = await trackedTempDir()
    streamAgentMock.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: "Answer." }
    })

    const events = await collect(runAgent("answer", [], { client, cwd }))

    expect(events.some((event) => event.type === "reasoning")).toBe(false)
  })

  it("injects steering after the current response and before the next model call", async () => {
    const requests: StreamAgentRequest[] = []
    const steering = new SteeringInbox(async () => undefined)
    streamAgentMock
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request) as StreamAgentRequest)
        yield { type: "text_delta", text: "I will start broadly." }
        steering.accept({ role: "user", content: "Focus only on the tests." })
      })
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request) as StreamAgentRequest)
        yield { type: "text_delta", text: "I will focus on the tests." }
      })

    const events = await collect(runAgent("Review the project.", [], { client, steering }))
    const complete = events.find((event) => event.type === "complete")

    expect(requests[1]?.messages).toEqual([
      { role: "user", content: "Review the project." },
      { role: "assistant", content: [{ type: "text", text: "I will start broadly." }] },
      { role: "user", content: "Focus only on the tests." },
    ])
    expect(complete?.messages).toEqual([
      ...requests[1].messages,
      { role: "assistant", content: [{ type: "text", text: "I will focus on the tests." }] },
    ])
  })

  it("waits for tool results before injecting steering", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "tool result", "utf8")
    const requests: StreamAgentRequest[] = []
    const steering = new SteeringInbox(async () => undefined)
    streamAgentMock
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request) as StreamAgentRequest)
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' },
        }
        steering.accept({ role: "user", content: "Also check the tests." })
      })
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request) as StreamAgentRequest)
        yield { type: "text_delta", text: "Done." }
      })

    await collect(runAgent("Read the note.", [], { client, cwd, steering }))

    expect(requests[1]?.messages).toMatchObject([
      { role: "user", content: "Read the note." },
      {
        role: "assistant",
        content: [{ type: "tool_call", toolCall: { id: "call_1", name: "read" } }],
      },
      { role: "tool", toolCallId: "call_1", content: expect.stringContaining("tool result") },
      { role: "user", content: "Also check the tests." },
    ])
  })

  it("coalesces adjacent deltas and times each reasoning block", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"))
    streamAgentMock.mockImplementationOnce(async function* () {
      yield { type: "reasoning_delta", text: "First ", field: "reasoning_content" }
      yield { type: "reasoning_delta", text: "thought.", field: "reasoning_content" }
      vi.setSystemTime(new Date("2026-08-06T12:00:00.500Z"))
      yield { type: "text_delta", text: "Interim. " }
      yield { type: "text_delta", text: "More." }
      vi.setSystemTime(new Date("2026-08-06T12:00:01.000Z"))
      yield { type: "reasoning_delta", text: "Second thought.", field: "reasoning_text" }
      vi.setSystemTime(new Date("2026-08-06T12:00:02.000Z"))
    })

    const events = await collect(runAgent("think", [], { client }))
    const reasoning = events.filter((event) => event.type === "reasoning")
    const [first, second] = [...new Set(reasoning.map((event) => event.reasoningId))]

    expect(first).not.toBe(second)
    expect(reasoning).toMatchObject([
      {
        phase: "start",
        reasoningId: first,
        field: "reasoning_content",
        startedAt: "2026-08-06T12:00:00.000Z",
      },
      { phase: "delta", reasoningId: first, text: "First " },
      { phase: "delta", reasoningId: first, text: "thought." },
      { phase: "end", reasoningId: first, endedAt: "2026-08-06T12:00:00.500Z", durationMs: 500 },
      {
        phase: "start",
        reasoningId: second,
        field: "reasoning_text",
        startedAt: "2026-08-06T12:00:01.000Z",
      },
      { phase: "delta", reasoningId: second, text: "Second thought." },
      { phase: "end", reasoningId: second, endedAt: "2026-08-06T12:00:02.000Z", durationMs: 1_000 },
    ])
    expect(events.filter((event) => event.type === "delta").map((event) => event.text)).toEqual([
      "Interim. ",
      "More.",
    ])
    expect(events.find((event) => event.type === "complete")?.messages).toEqual([
      { role: "user", content: "think" },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            id: first,
            field: "reasoning_content",
            text: "First thought.",
            startedAt: "2026-08-06T12:00:00.000Z",
            endedAt: "2026-08-06T12:00:00.500Z",
          },
          { type: "text", text: "Interim. More." },
          {
            type: "reasoning",
            id: second,
            field: "reasoning_text",
            text: "Second thought.",
            startedAt: "2026-08-06T12:00:01.000Z",
            endedAt: "2026-08-06T12:00:02.000Z",
          },
        ],
      },
    ])
  })

  it("returns provider-valid progress when interrupted after completed tool work", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "tool result", "utf8")
    const controller = new AbortController()

    streamAgentMock
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "I'll inspect that first." }
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' },
        }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "reasoning_delta", text: "The file confirms it.", field: "reasoning_content" }
        yield { type: "text_delta", text: "I found the relevant" }
        controller.abort()
        throw new Error("request aborted")
      })

    const events = await collect(
      runAgent("read the note", [], { client, cwd, signal: controller.signal }),
    )
    const interrupted = events.find((event) => event.type === "interrupted")

    expect(interrupted?.messages).toMatchObject([
      { role: "user", content: "read the note" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll inspect that first." },
          {
            type: "tool_call",
            toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' },
          },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: expect.stringContaining("tool result") },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "The file confirms it.", field: "reasoning_content" },
          { type: "text", text: "I found the relevant" },
        ],
      },
    ])
    expect(events.some((event) => event.type === "complete")).toBe(false)
  })

  it("closes tool calls that were streamed just before interruption", async () => {
    const controller = new AbortController()
    streamAgentMock.mockImplementationOnce(async function* () {
      yield {
        type: "tool_call",
        toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' },
      }
      controller.abort()
      throw new Error("request aborted")
    })

    const events = await collect(
      runAgent("read the note", [], { client, signal: controller.signal }),
    )
    const interrupted = events.find((event) => event.type === "interrupted")

    expect(interrupted?.messages).toEqual([
      { role: "user", content: "read the note" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' },
          },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: "Tool call interrupted by user." },
    ])
  })

  it("keeps partial output and closes its tool calls when the stream fails", async () => {
    streamAgentMock.mockImplementationOnce(async function* () {
      yield { type: "reasoning_delta", text: "Plan.", field: "reasoning_content" }
      yield { type: "text_delta", text: "Reading." }
      yield {
        type: "tool_call",
        toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' },
      }
      throw new Error("connection reset")
    })

    const events = await collect(runAgent("read the note", [], { client }))
    const error = events.at(-1)
    expect(error).toMatchObject({ type: "error", message: "connection reset" })
    if (error?.type !== "error") throw new Error("Expected an error event")
    expect(error.messages).toEqual([
      { role: "user", content: "read the note" },
      {
        role: "assistant",
        content: [
          expect.objectContaining({ type: "reasoning", text: "Plan." }),
          { type: "text", text: "Reading." },
          {
            type: "tool_call",
            toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_1",
        content: "Tool call not executed: the response failed before it could run.",
      },
    ])
    expect(events.some((event) => event.type === "reasoning" && event.phase === "end")).toBe(true)
    expect(events.some((event) => event.type === "tool")).toBe(false)
  })

  it("does not complete silently when a normal model response is empty", async () => {
    streamAgentMock.mockImplementationOnce(async function* () {
      yield* []
    })

    const events = await collect(runAgent("answer me", [], { client }))
    const error = events.find((event) => event.type === "error")

    expect(error?.message).toContain("empty response")
    expect(events.some((event) => event.type === "complete")).toBe(false)
  })

  it("asks permission before destructive tools and skips execution when denied", async () => {
    const cwd = await trackedTempDir()
    const onPermissionRequest = vi.fn<(request: PermissionRequest) => Promise<boolean>>(
      async () => false,
    )

    streamAgentMock
      .mockImplementationOnce(async function* () {
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", name: "bash", arguments: '{"command":"rm -rf /"}' },
        }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Okay, I won't." }
      })

    const permissionPolicy = createPermissionPolicy({ cwd, mode: "ask" })
    const events = await collect(
      runAgent("delete everything", [], { client, cwd, permissionPolicy, onPermissionRequest }),
    )

    expect(onPermissionRequest).toHaveBeenCalledOnce()
    expect(onPermissionRequest.mock.calls[0][0]).toMatchObject({ call: { name: "bash" } })
    const toolMessage = events
      .find((event) => event.type === "complete")
      ?.messages.find((message) => message.role === "tool")
    expect(toolMessage?.content).toBe("Permission denied by user.")
  })

  it("executes destructive tools when permission is granted", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "target.txt"), "old", "utf8")
    const onPermissionRequest = vi.fn<(request: PermissionRequest) => Promise<boolean>>(
      async () => true,
    )

    streamAgentMock
      .mockImplementationOnce(async function* () {
        yield {
          type: "tool_call",
          toolCall: {
            id: "call_1",
            name: "write",
            arguments: '{"path":"target.txt","content":"new"}',
          },
        }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Done." }
      })

    const permissionPolicy = createPermissionPolicy({ cwd, mode: "ask" })
    const events = await collect(
      runAgent("write the file", [], { client, cwd, permissionPolicy, onPermissionRequest }),
    )

    expect(onPermissionRequest).toHaveBeenCalledOnce()
    expect(onPermissionRequest.mock.calls[0][0]).toMatchObject({ call: { name: "write" } })
    const toolMessage = events
      .find((event) => event.type === "complete")
      ?.messages.find((message) => message.role === "tool")
    expect(toolMessage?.content).toContain("Wrote 3 characters")
    expect(events.filter((event) => event.type === "tool")).toMatchObject([
      {
        phase: "start",
        toolCallId: "call_1",
        activityKind: "file_write",
        label: "Writing file: target.txt",
      },
      {
        phase: "end",
        toolCallId: "call_1",
        activityKind: "file_write",
        diff: expect.stringContaining("+new"),
      },
    ])
  })

  it("emits context events with growing message count and content size", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "tool result", "utf8")
    streamAgentMock
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "I'll inspect that." }
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' },
        }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Done." }
      })

    const events = await collect(runAgent("read the note", [], { client, cwd }))
    const contextEvents = events.filter((event) => event.type === "context")

    expect(contextEvents).toHaveLength(4)
    expect(contextEvents[0].messageCount).toBe(1)
    expect(contextEvents[1].messageCount).toBe(2)
    expect(contextEvents[2].messageCount).toBe(3)
    expect(contextEvents[3].messageCount).toBe(4)
    expect(contextEvents[2].contentChars).toBeGreaterThan(contextEvents[1].contentChars)
  })

  it("does not ask permission for read-only tools", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "hello world", "utf8")
    const onPermissionRequest = vi.fn<(request: PermissionRequest) => Promise<boolean>>(
      async () => true,
    )

    const calls = [
      { id: "call_read", name: "read", arguments: '{"path":"note.txt"}' },
      { id: "call_grep", name: "grep", arguments: '{"pattern":"hello"}' },
      { id: "call_glob", name: "glob", arguments: '{"pattern":"**/*.txt"}' },
    ]
    for (const toolCall of calls) {
      streamAgentMock
        .mockImplementationOnce(async function* () {
          yield { type: "tool_call", toolCall }
        })
        .mockImplementationOnce(async function* () {
          yield { type: "text_delta", text: "Done." }
        })

      await collect(runAgent("inspect files", [], { client, cwd, onPermissionRequest }))
    }

    expect(onPermissionRequest).not.toHaveBeenCalled()
  })

  it("asks permission for every bash command, including read-only ones", async () => {
    const cwd = await trackedTempDir()
    const onPermissionRequest = vi.fn<(request: PermissionRequest) => Promise<boolean>>(
      async () => false,
    )

    streamAgentMock
      .mockImplementationOnce(async function* () {
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", name: "bash", arguments: '{"command":"ls -la"}' },
        }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Okay." }
      })

    const permissionPolicy = createPermissionPolicy({ cwd, mode: "ask" })
    await collect(
      runAgent("list files", [], { client, cwd, permissionPolicy, onPermissionRequest }),
    )

    expect(onPermissionRequest).toHaveBeenCalledOnce()
    expect(onPermissionRequest.mock.calls[0][0]).toMatchObject({ call: { name: "bash" } })
  })

  it("loads AGENTS.md from cwd and passes project context to streamAgent", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "AGENTS.md"), "# Rules\nUse TypeScript strict mode.", "utf8")
    const requests: StreamAgentRequest[] = []
    streamAgentMock.mockImplementationOnce(async function* (request) {
      requests.push(clone(request) as StreamAgentRequest)
      yield { type: "text_delta", text: "Done." }
    })

    await collect(runAgent("hello", [], { client, cwd }))

    expect(requests[0].projectContext).toBeDefined()
    expect(requests[0].projectContext).toHaveLength(1)
    expect(requests[0].projectContext?.[0].content).toContain("Use TypeScript strict mode.")
  })

  it("passes explicitly provided projectContext instead of loading from cwd", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "AGENTS.md"), "SHOULD NOT APPEAR", "utf8")
    const requests: StreamAgentRequest[] = []
    streamAgentMock.mockImplementationOnce(async function* (request) {
      requests.push(clone(request) as StreamAgentRequest)
      yield { type: "text_delta", text: "Done." }
    })

    const explicitContext = [{ path: "/custom/AGENTS.md", content: "Custom rules" }]
    await collect(runAgent("hello", [], { client, cwd, projectContext: explicitContext }))

    expect(requests[0].projectContext).toHaveLength(1)
    expect(requests[0].projectContext?.[0].content).toBe("Custom rules")
    expect(requests[0].projectContext?.[0].path).toBe("/custom/AGENTS.md")
  })

  it("does not send projectContext when no AGENTS.md files are found", async () => {
    const cwd = await trackedTempDir()
    const requests: StreamAgentRequest[] = []
    streamAgentMock.mockImplementationOnce(async function* (request) {
      requests.push(clone(request) as StreamAgentRequest)
      yield { type: "text_delta", text: "Done." }
    })

    await collect(runAgent("hello", [], { client, cwd }))

    expect(requests[0].projectContext).toBeUndefined()
  })

  it("advertises discovered skills and loads instructions through the skill tool", async () => {
    const cwd = await trackedTempDir()
    const skillDirectory = join(cwd, ".agents", "skills", "review")
    await mkdir(skillDirectory, { recursive: true })
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: review\ndescription: Review code changes.\n---\n\nFollow the review checklist.\n",
    )
    const requests: StreamAgentRequest[] = []
    streamAgentMock
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request) as StreamAgentRequest)
        yield {
          type: "tool_call",
          toolCall: { id: "call_skill", name: "skill", arguments: '{"skill":"review"}' },
        }
      })
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request) as StreamAgentRequest)
        yield { type: "text_delta", text: "Reviewed." }
      })

    const events = await collect(runAgent("review this", [], { client, cwd }))

    expect(requests[0].skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "review", description: "Review code changes." }),
      ]),
    )
    expect(requests[0].tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "skill" })]),
    )
    expect(requests[1].messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        toolCallId: "call_skill",
        content: expect.stringContaining("Follow the review checklist."),
      }),
    )
    expect(events.find((event) => event.type === "complete")).toBeDefined()
  })

  it("does not expose the skill tool when no skills are available", async () => {
    streamAgentMock.mockImplementationOnce(async function* (request) {
      expect(request.tools).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "skill" })]),
      )
      yield { type: "text_delta", text: "Done." }
    })

    await collect(runAgent("hello", [], { client, skills: emptySkillCatalog() }))
  })
})

async function collect(events: AsyncGenerator<AgentEvent>) {
  const collected: AgentEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

async function trackedTempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-agent-"))
  tempDirs.push(path)
  return path
}

function clone(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown
}

type StreamAgentRequest = {
  tools?: unknown[]
  skills?: unknown[]
  messages: Array<{ role: string; content?: unknown }>
  projectContext?: Array<{ path: string; content: string }>
}
