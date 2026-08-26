import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FireworksModel } from "../../src/inference/types.js"
import type { PermissionConfig } from "../../src/permissions/policy.js"
import type { SkillCatalog } from "../../src/skills/index.js"

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  listSessions: vi.fn(async () => []),
  listToolCapableModels: vi.fn<() => Promise<FireworksModel[]>>(async () => [
    { provider: "fireworks", id: "accounts/fireworks/models/test", displayName: "Test", supportsImageInput: false },
  ]),
  loadLocalSettings: vi.fn<
    () => Promise<{
      fireworksApiKey?: string
      model: string
      modelSupportsImageInput?: boolean
      fastMode?: boolean
      permissions?: PermissionConfig
    }>
  >(async () => ({
    fireworksApiKey: "fw_test",
    model: "accounts/fireworks/models/test",
  })),
  openSession: vi.fn(),
  loadSkillCatalog: vi.fn<() => Promise<SkillCatalog>>(async () => ({ skills: [], byName: new Map() })),
  saveSelectedModel: vi.fn(async () => undefined),
  streamChat: vi.fn(),
  detectHardware: vi.fn(async () => ({
    platform: "darwin" as const,
    arch: "arm64",
    totalMemoryBytes: 64 * 1024 ** 3,
    gpuMemoryBytes: 64 * 1024 ** 3,
    backend: "metal" as const,
    unifiedMemory: true,
  })),
  ensureLocalServing: vi.fn<
    (
      spec: { id: string },
      fit?: unknown,
      hardware?: unknown,
      options?: { signal?: AbortSignal },
    ) => Promise<{ model: string; inferenceURL: string; contextLength: number }>
  >(async (spec) => ({
    model: spec.id,
    inferenceURL: "http://127.0.0.1:18765/v1/chat/completions",
    contextLength: 32_768,
  })),
  stopLocalRuntime: vi.fn(async () => undefined),
}))

const session = {
  id: "session_test",
  admitPrompt: vi.fn(async (message: { role: "user"; content: string }) => ({
    promptId: "prompt_test",
    message,
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
vi.mock("../../src/inference/hardware.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/inference/hardware.js")>()
  return { ...actual, detectHardware: mocks.detectHardware }
})
vi.mock("../../src/inference/llama-runtime.js", () => ({
  LlamaCppRuntime: vi.fn(function LlamaCppRuntime() {
    return { ensureServing: mocks.ensureLocalServing, stop: mocks.stopLocalRuntime }
  }),
}))
vi.mock("../../src/inference/local-client.js", () => ({
  LlamaCppClient: vi.fn(function LlamaCppClient(config: { model: string }) {
    return { model: config.model, streamChat: mocks.streamChat }
  }),
}))
vi.mock("../../src/local/settings.js", () => ({
  loadLocalSettings: mocks.loadLocalSettings,
  saveSelectedModel: mocks.saveSelectedModel,
}))
vi.mock("../../src/skills/index.js", () => ({
  loadSkillCatalog: mocks.loadSkillCatalog,
  readSkillResource: vi.fn(),
}))
vi.mock("../../src/storage/index.js", () => ({
  acquireSessionLock: vi.fn(),
  createSession: mocks.createSession,
  listSessions: mocks.listSessions,
  openSession: mocks.openSession,
}))

import { runHeadlessCommand } from "../../src/cli/headless-cli.js"
import { FireworksClient } from "../../src/inference/client.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.loadLocalSettings.mockResolvedValue({
    fireworksApiKey: "fw_test",
    model: "accounts/fireworks/models/test",
  })
  mocks.createSession.mockResolvedValue(session)
  mocks.loadSkillCatalog.mockResolvedValue({ skills: [], byName: new Map() })
  mocks.ensureLocalServing.mockImplementation(async (spec: { id: string }) => ({
    model: spec.id,
    inferenceURL: "http://127.0.0.1:18765/v1/chat/completions",
    contextLength: 32_768,
  }))
  mocks.stopLocalRuntime.mockResolvedValue(undefined)
})

describe("runHeadlessCommand", () => {
  it("passes discovered skills to the shared headless agent runtime", async () => {
    const skill = {
      name: "review",
      description: "Review code changes.",
      root: "/skills/review",
      instructionsPath: "/skills/review/SKILL.md",
    }
    mocks.loadSkillCatalog.mockResolvedValue({ skills: [skill], byName: new Map([[skill.name, skill]]) })
    mocks.streamChat.mockImplementationOnce(async function* (request) {
      expect(request.skills).toEqual([skill])
      expect(request.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "skill" })]))
      yield { type: "text_delta", text: "Done." }
    })
    const output = streams()

    const exitCode = await runHeadlessCommand(["--ephemeral", "review this"], output.options)

    expect(exitCode).toBe(0)
    expect(output.stdout()).toBe("Done.\n")
  })

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

  it("accepts repeatable image input and sends structured content to a vision model", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "pixel.ppm"), "P3\n1 1\n255\n0 0 0\n")
    mocks.loadLocalSettings.mockResolvedValue({
      fireworksApiKey: "fw_test",
      model: "accounts/fireworks/models/test",
      modelSupportsImageInput: true,
    })
    mocks.streamChat.mockImplementationOnce(async function* (request) {
      expect(request.messages[0]).toMatchObject({
        role: "user",
        content: [
          expect.objectContaining({ type: "image", mimeType: "image/x-portable-pixmap", name: "pixel.ppm" }),
          { type: "text", text: "describe it" },
        ],
      })
      yield { type: "text_delta", text: "A black pixel." }
    })
    const output = streams({ processCwd: cwd })

    const exitCode = await runHeadlessCommand(["--ephemeral", "--image", "pixel.ppm", "describe it"], output.options)

    expect(exitCode).toBe(0)
    expect(output.stdout()).toBe("A black pixel.\n")
  })

  it("rejects image input before inference when the selected model is not vision-capable", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "pixel.ppm"), "P3\n1 1\n255\n0 0 0\n")
    mocks.loadLocalSettings.mockResolvedValue({
      fireworksApiKey: "fw_test",
      model: "accounts/fireworks/models/test",
      modelSupportsImageInput: false,
    })
    const output = streams({ processCwd: cwd })

    const exitCode = await runHeadlessCommand(["--ephemeral", "--image", "pixel.ppm"], output.options)

    expect(exitCode).toBe(1)
    expect(output.stderr()).toContain("does not support image input")
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("persists a complete turn by default", async () => {
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: "Saved answer." }
    })
    const output = streams()

    const exitCode = await runHeadlessCommand(["save this"], output.options)

    expect(exitCode).toBe(0)
    expect(session.admitPrompt).toHaveBeenCalledWith({ role: "user", content: "save this" })
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

  it("allows a command matching an explicit CLI rule", async () => {
    mocks.streamChat
      .mockImplementationOnce(async function* () {
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", name: "bash", arguments: '{"command":"printf allowed"}' },
        }
      })
      .mockImplementationOnce(async function* (request) {
        expect(request.messages).toContainEqual({
          role: "tool",
          toolCallId: "call_1",
          content: expect.stringContaining("allowed"),
        })
        yield { type: "text_delta", text: "Executed." }
      })
    const output = streams()

    const exitCode = await runHeadlessCommand(
      ["--ephemeral", "--allow", "bash(printf *)", "run allowed command"],
      output.options,
    )

    expect(exitCode).toBe(0)
    expect(output.stdout()).toBe("Executed.\n")
    expect(output.stderr()).not.toContain("(denied)")
  })

  it("enforces explicit deny rules in auto mode", async () => {
    mocks.streamChat
      .mockImplementationOnce(async function* () {
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", name: "bash", arguments: '{"command":"printf blocked"}' },
        }
      })
      .mockImplementationOnce(async function* (request) {
        expect(request.messages).toContainEqual({
          role: "tool",
          toolCallId: "call_1",
          content: "Permission denied by policy: bash(printf blocked).",
        })
        yield { type: "text_delta", text: "Blocked." }
      })
    const output = streams()

    const exitCode = await runHeadlessCommand(
      ["--ephemeral", "--auto", "--deny", "Bash(printf blocked)", "do not run"],
      output.options,
    )

    expect(exitCode).toBe(0)
    expect(output.stdout()).toBe("Blocked.\n")
    expect(output.stderr()).toContain("(denied)")
  })

  it("uses a configured auto default while retaining configured deny rules", async () => {
    mocks.loadLocalSettings.mockResolvedValue({
      fireworksApiKey: "fw_test",
      model: "accounts/fireworks/models/test",
      permissions: {
        defaultMode: "auto",
        rules: [{ tool: "bash", resource: "printf blocked", effect: "deny" }],
      },
    })
    mocks.streamChat
      .mockImplementationOnce(async function* () {
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", name: "bash", arguments: '{"command":"printf allowed"}' },
        }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text_delta", text: "Configured execution worked." }
      })
    const output = streams()

    const exitCode = await runHeadlessCommand(["--ephemeral", "run configured command"], output.options)

    expect(exitCode).toBe(0)
    expect(output.stderr()).not.toContain("(denied)")
  })

  it("rejects ask mode for a non-interactive command", async () => {
    const output = streams()

    const exitCode = await runHeadlessCommand(["--permission-mode", "ask", "hello"], output.options)

    expect(exitCode).toBe(2)
    expect(output.stderr()).toContain("must be auto or dontAsk")
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

  it("emits structured reasoning lifecycle events only when requested", async () => {
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: "reasoning_delta", field: "reasoning_content", text: "Checking." }
      yield { type: "text_delta", text: "Hello" }
    })
    const output = streams()

    const exitCode = await runHeadlessCommand(
      ["--ephemeral", "--output-format", "jsonl", "--include-reasoning", "hello"],
      output.options,
    )
    const records = output
      .stdout()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(exitCode).toBe(0)
    expect(records.map((record) => record.type)).toContain("reasoning_start")
    expect(records.map((record) => record.type)).toContain("reasoning_delta")
    expect(records.map((record) => record.type)).toContain("reasoning_end")
    expect(records.find((record) => record.type === "reasoning_delta")).toMatchObject({ text: "Checking." })
    expect(records.at(-1).reasoning).toMatchObject([{ text: "Checking.", field: "reasoning_content" }])
  })

  it("does not expose reasoning text in default JSONL output", async () => {
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: "reasoning_delta", field: "reasoning_content", text: "Sensitive context." }
      yield { type: "text_delta", text: "Hello" }
    })
    const output = streams()

    await runHeadlessCommand(["--ephemeral", "--output-format", "jsonl", "hello"], output.options)
    const records = output
      .stdout()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(records).toContainEqual(expect.objectContaining({ type: "reasoning" }))
    expect(output.stdout()).not.toContain("Sensitive context.")
    expect(records.at(-1)).not.toHaveProperty("reasoning")
  })

  it("uses an explicit Fast serving path when requested", async () => {
    mocks.listToolCapableModels.mockResolvedValue([
      {
        provider: "fireworks",
        id: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        supportsImageInput: true,
        fastId: "accounts/fireworks/routers/kimi-k3-fast",
      },
    ])
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: "ok" }
    })
    const output = streams()

    const exitCode = await runHeadlessCommand(
      ["--ephemeral", "--model", "accounts/fireworks/routers/kimi-k3-fast", "hello"],
      output.options,
    )

    expect(exitCode).toBe(0)
    expect(FireworksClient).toHaveBeenCalledWith(
      expect.objectContaining({ model: "accounts/fireworks/routers/kimi-k3-fast" }),
    )
  })

  it("does not upgrade a saved catalog model to Fast by default", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "pixel.ppm"), "P3\n1 1\n255\n0 0 0\n")
    mocks.listToolCapableModels.mockResolvedValue([
      {
        provider: "fireworks",
        id: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        supportsImageInput: true,
        fastId: "accounts/fireworks/routers/kimi-k3-fast",
      },
    ])
    mocks.loadLocalSettings.mockResolvedValue({
      fireworksApiKey: "fw_test",
      model: "accounts/fireworks/models/kimi-k3",
    })
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: "ok" }
    })
    const output = streams({ processCwd: cwd })

    const exitCode = await runHeadlessCommand(["--ephemeral", "--image", "pixel.ppm", "hello"], output.options)

    expect(exitCode).toBe(0)
    expect(FireworksClient).toHaveBeenCalledWith(
      expect.objectContaining({ model: "accounts/fireworks/models/kimi-k3" }),
    )
  })

  it("uses Fast serving when the saved preference is on", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "pixel.ppm"), "P3\n1 1\n255\n0 0 0\n")
    mocks.listToolCapableModels.mockResolvedValue([
      {
        provider: "fireworks",
        id: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        supportsImageInput: true,
        fastId: "accounts/fireworks/routers/kimi-k3-fast",
      },
    ])
    mocks.loadLocalSettings.mockResolvedValue({
      fireworksApiKey: "fw_test",
      model: "accounts/fireworks/models/kimi-k3",
      fastMode: true,
    })
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: "ok" }
    })
    const output = streams({ processCwd: cwd })

    const exitCode = await runHeadlessCommand(["--ephemeral", "--image", "pixel.ppm", "hello"], output.options)

    expect(exitCode).toBe(0)
    expect(FireworksClient).toHaveBeenCalledWith(
      expect.objectContaining({ model: "accounts/fireworks/routers/kimi-k3-fast" }),
    )
  })

  it("keeps an explicit catalog model on the base serving path", async () => {
    mocks.listToolCapableModels.mockResolvedValue([
      {
        provider: "fireworks",
        id: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        supportsImageInput: true,
        fastId: "accounts/fireworks/routers/kimi-k3-fast",
      },
    ])
    mocks.loadLocalSettings.mockResolvedValue({
      fireworksApiKey: "fw_test",
      model: "accounts/fireworks/models/kimi-k3",
      fastMode: true,
    })
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: "ok" }
    })
    const output = streams()

    const exitCode = await runHeadlessCommand(
      ["--ephemeral", "--model", "accounts/fireworks/models/kimi-k3", "hello"],
      output.options,
    )

    expect(exitCode).toBe(0)
    expect(FireworksClient).toHaveBeenCalledWith(
      expect.objectContaining({ model: "accounts/fireworks/models/kimi-k3" }),
    )
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

  it("passes the command cancellation signal into local model startup", async () => {
    mocks.loadLocalSettings.mockResolvedValue({ model: "openai/gpt-oss-20b" })
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: "local answer" }
    })
    const output = streams()

    const exitCode = await runHeadlessCommand(["--ephemeral", "hello locally"], output.options)

    expect(exitCode).toBe(0)
    expect(mocks.ensureLocalServing).toHaveBeenCalledWith(
      expect.objectContaining({ id: "openai/gpt-oss-20b" }),
      expect.anything(),
      expect.anything(),
      { signal: expect.any(AbortSignal) },
    )
  })

  it("interrupts local startup and stops the runtime on SIGINT", async () => {
    mocks.loadLocalSettings.mockResolvedValue({ model: "openai/gpt-oss-20b" })
    let startupSignal: AbortSignal | undefined
    mocks.ensureLocalServing.mockImplementation(
      (_spec, _fit, _hardware, options) =>
        new Promise((_resolve, reject) => {
          startupSignal = options?.signal
          startupSignal?.addEventListener("abort", () => reject(startupSignal?.reason), { once: true })
        }),
    )
    const once = vi.spyOn(process, "once")
    try {
      const running = runHeadlessCommand(["--ephemeral", "hello locally"], streams().options)
      await vi.waitFor(() => expect(startupSignal).toBeDefined())
      const interrupt = once.mock.calls.find(([event]) => event === "SIGINT")?.[1] as (() => void) | undefined
      interrupt?.()

      await expect(running).resolves.toBe(130)
      expect(startupSignal?.aborted).toBe(true)
      expect(mocks.stopLocalRuntime).toHaveBeenCalledOnce()
    } finally {
      once.mockRestore()
    }
  })
})

function streams(overrides: { processCwd?: string } = {}) {
  let stdout = ""
  let stderr = ""
  return {
    options: {
      stdin: emptyInput(),
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
      ...overrides,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "otis-headless-images-"))
  temporaryDirectories.push(path)
  return path
}

async function* emptyInput() {
  yield* []
}
