import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type AgentEvent, runAgent } from "../../src/core/agent.js"
import { FireworksClient } from "../../src/inference/client.js"
import { openaiChatCompletionRequest } from "../../src/inference/openai-compat.js"
import type {
  ChatMessage,
  ChatStreamEvent,
  InferenceClient,
  StreamChatOptions,
} from "../../src/inference/types.js"
import { createPermissionPolicy } from "../../src/permissions/policy.js"
import { emptySkillCatalog } from "../../src/skills/catalog.js"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function scriptedClient(steps: ChatStreamEvent[][]) {
  const requests: StreamChatOptions[] = []
  const client: InferenceClient = {
    model: "fake",
    complete: vi.fn(),
    async *streamChat(options) {
      const step = steps[requests.length]
      requests.push(structuredClone({ ...options, signal: undefined }))
      if (!step) throw new Error("Unexpected extra model request")
      yield* step
    },
  }
  return { client, requests }
}
const malformed: ChatStreamEvent = {
  type: "tool_call",
  toolCall: { id: "bad", name: "write", arguments: '{"path":"partial.txt","content":"unfinished' },
}
const answer: ChatStreamEvent = { type: "text_delta", text: "Finished." }
const writeCall = (id: string, path: string, content: string): ChatStreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: "write", arguments: JSON.stringify({ path, content }) },
})
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "otis-recovery-"))
  directories.push(cwd)
  return {
    cwd,
    projectContext: [],
    skills: emptySkillCatalog(),
    permissionPolicy: createPermissionPolicy({ cwd, mode: "auto" }),
  }
}
async function collect(events: AsyncGenerator<AgentEvent>) {
  const result: AgentEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

describe("tool-call recovery", () => {
  it("retries once without executing any call from the malformed batch or repeating earlier successful work", async () => {
    const options = await workspace()
    const { client, requests } = scriptedClient([
      [writeCall("first", "done.txt", "earlier completed action")],
      [writeCall("skipped", "skipped.txt", "must not be written"), malformed],
      [writeCall("fresh", "final.txt", "complete content")],
      [answer],
    ])
    const events = await collect(runAgent("Write the files", [], { ...options, client }))
    expect(events.at(-1)?.type).toBe("complete")
    expect(
      events.filter((event) => event.type === "model" && event.phase === "retry"),
    ).toHaveLength(1)
    expect(
      events.flatMap((event) =>
        event.type === "tool" && event.phase === "start" ? [event.toolCallId] : [],
      ),
    ).toEqual(["first", "fresh"])
    expect((await readdir(options.cwd)).sort()).toEqual(["done.txt", "final.txt"])
    expect(await readFile(join(options.cwd, "done.txt"), "utf8")).toBe("earlier completed action")
    const retry = openaiChatCompletionRequest("fake", requests[2])
    expect(JSON.stringify(retry)).not.toContain("unfinished")
    expect(JSON.stringify(retry)).toContain("smaller")
    expect(retry.messages.filter((message) => message.role === "user")).toHaveLength(1)
    const terminal = events.at(-1)
    if (terminal?.type !== "complete") throw new Error("Expected completion")
    // Diagnostic history is untouched.
    expect(JSON.stringify(terminal.messages)).toContain("unfinished")
  })

  it.each([
    "malformed",
    "length",
    "reasoning-only",
  ])("stops after one retry for repeated %s output", async (kind) => {
    const options = await workspace()
    const step: ChatStreamEvent[] =
      kind === "malformed"
        ? [malformed]
        : [
            ...(kind === "length"
              ? [writeCall("truncated", "partial.txt", "syntactically valid but incomplete output")]
              : [
                  {
                    type: "reasoning_delta" as const,
                    field: "reasoning_content" as const,
                    text: "Still thinking",
                  },
                ]),
            { type: "finish", reason: "length" },
          ]
    const { client, requests } = scriptedClient([step, step])
    const events = await collect(runAgent("Do the task", [], { ...options, client }))
    expect(requests).toHaveLength(2)
    expect(await readdir(options.cwd)).toEqual([])
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("Earlier completed work is preserved"),
    })
    expect(events.some((event) => event.type === "tool")).toBe(false)
  })

  it("does not reset the recovery budget after successful tool work", async () => {
    const options = await workspace()
    const { client, requests } = scriptedClient([
      [malformed],
      [writeCall("ok", "done.txt", "done")],
      [malformed],
    ])
    const events = await collect(runAgent("Do the task", [], { ...options, client }))
    expect(requests).toHaveLength(3)
    expect(events.at(-1)?.type).toBe("error")
    expect(await readFile(join(options.cwd, "done.txt"), "utf8")).toBe("done")
  })

  it("allows cancellation before the retry request", async () => {
    const options = await workspace()
    const controller = new AbortController()
    const { client, requests } = scriptedClient([[malformed]])
    const events: AgentEvent[] = []
    for await (const event of runAgent("Do the task", [], {
      ...options,
      client,
      signal: controller.signal,
    })) {
      events.push(event)
      if (event.type === "model" && event.phase === "retry") controller.abort()
    }
    expect(requests).toHaveLength(1)
    expect(events.at(-1)?.type).toBe("interrupted")
    expect(await readdir(options.cwd)).toEqual([])
  })

  it("recovers the actual streamed Fireworks failure shape and preserves usage without resending broken arguments", async () => {
    const options = await workspace()
    const requests: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      requests.push(body)
      for (const message of body.messages)
        for (const call of message.tool_calls ?? []) JSON.parse(call.function.arguments)
      const chunks =
        requests.length === 1
          ? [
              { choices: [{ delta: { reasoning_content: "Provider reasoning" } }] },
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "broken",
                          function: {
                            name: "write",
                            arguments: '{"path":"partial.txt","content":"private unfinished',
                          },
                        },
                      ],
                    },
                    finish_reason: "length",
                  },
                ],
              },
              {
                choices: [],
                usage: { prompt_tokens: 3191, completion_tokens: 65536, total_tokens: 68727 },
              },
            ]
          : [{ choices: [{ delta: { content: "Recovered." }, finish_reason: "stop" }] }]
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
      )
    })
    const client = new FireworksClient({
      model: "fake",
      apiKey: "fake-test-key",
      fetch: fetchMock as typeof fetch,
    })
    const onUsage = vi.fn()
    const events = await collect(runAgent("Do the task", [], { ...options, client, onUsage }))
    expect(events.at(-1)?.type).toBe("complete")
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1])).not.toContain("private unfinished")
    expect(JSON.stringify(requests[1])).toContain("Provider reasoning")
    expect(JSON.stringify(requests)).not.toContain("fake-test-key")
    expect(onUsage).toHaveBeenCalledWith({
      promptTokens: 3191,
      completionTokens: 65536,
      totalTokens: 68727,
    })
    expect(await readdir(options.cwd)).toEqual([])

    const terminal = events.at(-1)
    if (terminal?.type !== "complete") throw new Error("Expected completion")
    const history: ChatMessage[] = [{ role: "user", content: "Do the task" }, ...terminal.messages]
    const original = structuredClone(history)
    const resumed = await collect(runAgent("Continue", history, { ...options, client }))
    expect(resumed.at(-1)?.type).toBe("complete")
    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[2])).not.toContain("private unfinished")
    expect(history).toEqual(original)
  })
})
