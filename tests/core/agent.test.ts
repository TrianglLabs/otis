import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type AgentEvent, runAgent } from "../../src/core/agent.js"
import type { FireworksClient } from "../../src/inference/client.js"

const streamAgentMock = vi.hoisted(() => vi.fn())
const client = { model: "accounts/fireworks/models/test", streamChat: streamAgentMock } as unknown as FireworksClient

const tempDirs: string[] = []

afterEach(async () => {
  streamAgentMock.mockReset()
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("runAgent", () => {
  it("preserves pre-tool streamed text and tool calls as assistant parts", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "tool result", "utf8")
    const requests: unknown[] = []
    streamAgentMock
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request))
        yield { type: "text_delta", text: "I'll inspect that first." }
        yield { type: "tool_call", toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' } }
      })
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request))
        yield { type: "text_delta", text: "Final answer." }
      })

    const events = await collect(runAgent("read the note", [], { client, cwd }))
    const complete = events.find((event) => event.type === "complete")
    const toolCallMessage = complete?.messages.find(
      (message) => message.role === "assistant" && message.content.some((part) => part.type === "tool_call"),
    )

    expect(toolCallMessage).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "I'll inspect that first." },
        { type: "tool_call", toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' } },
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
        yield { type: "reasoning_delta", text: "I need the file contents.", field: "reasoning_content" }
        yield { type: "tool_call", toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' } }
      })
      .mockImplementationOnce(async function* (request) {
        requests.push(clone(request) as StreamAgentRequest)
        yield { type: "text_delta", text: "Final answer." }
      })

    const events = await collect(runAgent("read the note", [], { client, cwd }))
    const assistant = requests[1]?.messages.find((message) => message.role === "assistant")

    expect(events.some((event) => event.type === "delta" && event.text.includes("I need"))).toBe(false)
    expect(assistant).toMatchObject({
      role: "assistant",
      content: [
        { type: "reasoning", text: "I need the file contents.", field: "reasoning_content" },
        { type: "tool_call", toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' } },
      ],
    })
  })

  it("orders reasoning before text in assistant messages", async () => {
    const cwd = await trackedTempDir()
    const requests: StreamAgentRequest[] = []
    streamAgentMock.mockImplementationOnce(async function* (request) {
      requests.push(clone(request) as StreamAgentRequest)
      yield { type: "reasoning_delta", text: "Thinking about the answer.", field: "reasoning_content" }
      yield { type: "text_delta", text: "Here is the answer." }
    })

    const events = await collect(runAgent("answer me", [], { client, cwd }))
    const complete = events.find((event) => event.type === "complete")
    const assistant = complete?.messages.find((message) => message.role === "assistant")

    expect(assistant).toMatchObject({
      role: "assistant",
      content: [
        { type: "reasoning", text: "Thinking about the answer.", field: "reasoning_content" },
        { type: "text", text: "Here is the answer." },
      ],
    })
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
    const onPermissionRequest = vi.fn<(call: { name: string }) => Promise<boolean>>(async () => false)

    streamAgentMock
      .mockImplementationOnce(async function* () {
        yield { type: "tool_call", toolCall: { id: "call_1", name: "bash", arguments: '{"command":"rm -rf /"}' } }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Okay, I won't." }
      })

    const events = await collect(runAgent("delete everything", [], { client, cwd, onPermissionRequest }))

    expect(onPermissionRequest).toHaveBeenCalledOnce()
    expect(onPermissionRequest.mock.calls[0][0]).toMatchObject({ name: "bash" })
    const toolMessage = events
      .find((event) => event.type === "complete")
      ?.messages.find((message) => message.role === "tool")
    expect(toolMessage?.content).toBe("Permission denied by user.")
  })

  it("executes destructive tools when permission is granted", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "target.txt"), "old", "utf8")
    const onPermissionRequest = vi.fn<(call: { name: string }) => Promise<boolean>>(async () => true)

    streamAgentMock
      .mockImplementationOnce(async function* () {
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", name: "write", arguments: '{"path":"target.txt","content":"new"}' },
        }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Done." }
      })

    const events = await collect(runAgent("write the file", [], { client, cwd, onPermissionRequest }))

    expect(onPermissionRequest).toHaveBeenCalledOnce()
    expect(onPermissionRequest.mock.calls[0][0]).toMatchObject({ name: "write" })
    const toolMessage = events
      .find((event) => event.type === "complete")
      ?.messages.find((message) => message.role === "tool")
    expect(toolMessage?.content).toContain("Wrote 3 characters")
    expect(events.filter((event) => event.type === "tool")).toMatchObject([
      { phase: "start", toolCallId: "call_1", activityKind: "file_write", label: "Writing file: target.txt" },
      { phase: "end", toolCallId: "call_1", activityKind: "file_write", diff: expect.stringContaining("+new") },
    ])
  })

  it("emits context events with growing message count and content size", async () => {
    const cwd = await trackedTempDir()
    await writeFile(join(cwd, "note.txt"), "tool result", "utf8")
    streamAgentMock
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "I'll inspect that." }
        yield { type: "tool_call", toolCall: { id: "call_1", name: "read", arguments: '{"path":"note.txt"}' } }
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
    const onPermissionRequest = vi.fn<(call: { name: string }) => Promise<boolean>>(async () => true)

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
    const onPermissionRequest = vi.fn<(call: { name: string }) => Promise<boolean>>(async () => false)

    streamAgentMock
      .mockImplementationOnce(async function* () {
        yield { type: "tool_call", toolCall: { id: "call_1", name: "bash", arguments: '{"command":"ls -la"}' } }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Okay." }
      })

    await collect(runAgent("list files", [], { client, cwd, onPermissionRequest }))

    expect(onPermissionRequest).toHaveBeenCalledOnce()
    expect(onPermissionRequest.mock.calls[0][0]).toMatchObject({ name: "bash" })
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
  messages: Array<{ role: string; content?: unknown }>
  projectContext?: Array<{ path: string; content: string }>
}
