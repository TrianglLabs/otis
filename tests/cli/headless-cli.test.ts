import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  listSessions: vi.fn(async () => []),
  listToolCapableModels: vi.fn(async () => [{ id: "accounts/fireworks/models/test", displayName: "Test" }]),
  loadLocalSettings: vi.fn(async () => ({
    fireworksApiKey: "fw_test",
    model: "accounts/fireworks/models/test",
  })),
  openSession: vi.fn(),
  streamChat: vi.fn(),
}))

const session = {
  id: "session_test",
  admitPrompt: vi.fn(async (content: string) => ({
    promptId: "prompt_test",
    message: { role: "user" as const, content },
  })),
  completeTurn: vi.fn(async () => undefined),
  interruptTurn: vi.fn(async () => undefined),
  recordUsage: vi.fn(async () => undefined),
  replay: vi.fn(() => ({ messages: [], toolActivities: [] })),
  replayMessages: vi.fn(() => []),
}

vi.mock("../../src/core/context.js", () => ({ loadProjectContext: () => [] }))
vi.mock("../../src/inference/client.js", () => ({
  FireworksClient: vi.fn(function FireworksClient(config: { model: string }) {
    return { model: config.model, streamChat: mocks.streamChat }
  }),
  listToolCapableModels: mocks.listToolCapableModels,
}))
vi.mock("../../src/local/settings.js", () => ({ loadLocalSettings: mocks.loadLocalSettings }))
vi.mock("../../src/storage/index.js", () => ({
  acquireSessionLock: vi.fn(),
  createSession: mocks.createSession,
  listSessions: mocks.listSessions,
  openSession: mocks.openSession,
}))

import { runHeadlessCommand } from "../../src/cli/headless-cli.js"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.loadLocalSettings.mockResolvedValue({
    fireworksApiKey: "fw_test",
    model: "accounts/fireworks/models/test",
  })
  mocks.createSession.mockResolvedValue(session)
})

describe("runHeadlessCommand", () => {
  it("prints only the final answer to stdout in plain mode", async () => {
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: "usage", usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }
      yield { type: "text_delta", text: "Final answer." }
    })
    const output = streams()

    const exitCode = await runHeadlessCommand(["--ephemeral", "answer", "this"], output.options)

    expect(exitCode).toBe(0)
    expect(output.stdout()).toBe("Final answer.\n")
    expect(output.stderr()).toBe("")
  })

  it("persists a complete turn by default", async () => {
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: "Saved answer." }
    })
    const output = streams()

    const exitCode = await runHeadlessCommand(["save this"], output.options)

    expect(exitCode).toBe(0)
    expect(session.admitPrompt).toHaveBeenCalledWith("save this")
    expect(session.completeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ promptId: "prompt_test" }),
      expect.arrayContaining([{ role: "user", content: "save this" }]),
      [],
    )
  })

  it("denies destructive tools by default and reports the policy outcome", async () => {
    mocks.streamChat
      .mockImplementationOnce(async function* () {
        yield { type: "tool_call", toolCall: { id: "call_1", name: "bash", arguments: '{"command":"exit 9"}' } }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Not executed." }
      })
    const output = streams()

    const exitCode = await runHeadlessCommand(["--ephemeral", "do not run this"], output.options)

    expect(exitCode).toBe(0)
    expect(output.stdout()).toBe("Not executed.\n")
    expect(output.stderr()).toContain("(denied)")
  })

  it("does not mix pre-tool narration into the final stdout answer", async () => {
    mocks.streamChat
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "I will inspect it." }
        yield { type: "tool_call", toolCall: { id: "call_1", name: "read", arguments: '{"path":"."}' } }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "The final result." }
      })
    const output = streams()

    const exitCode = await runHeadlessCommand(["--ephemeral", "inspect"], output.options)

    expect(exitCode).toBe(0)
    expect(output.stdout()).toBe("The final result.\n")
  })

  it("emits independently parseable versioned JSONL records", async () => {
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: "Hello" }
    })
    const output = streams()

    const exitCode = await runHeadlessCommand(["--ephemeral", "--output-format", "jsonl", "hello"], output.options)
    const records = output
      .stdout()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(exitCode).toBe(0)
    expect(records.every((record) => record.version === 1)).toBe(true)
    expect(records.map((record) => record.type)).toEqual([
      "context",
      "model_start",
      "assistant_delta",
      "context",
      "turn_complete",
      "result",
    ])
    expect(records.at(-1)).toMatchObject({ status: "complete", output: "Hello" })
  })

  it("validates an explicit model against the tool-capable catalog", async () => {
    const output = streams()

    const exitCode = await runHeadlessCommand(
      ["--ephemeral", "--model", "accounts/fireworks/models/missing", "hello"],
      output.options,
    )

    expect(exitCode).toBe(1)
    expect(mocks.listToolCapableModels).toHaveBeenCalledOnce()
    expect(output.stderr()).toContain("not a tool-capable Fireworks serverless model")
  })
})

function streams() {
  let stdout = ""
  let stderr = ""
  return {
    options: {
      stdin: emptyInput(),
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

async function* emptyInput() {
  yield* []
}
