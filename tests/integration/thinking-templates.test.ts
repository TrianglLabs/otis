import { type ChildProcess, spawn } from "node:child_process"
import { createServer } from "node:net"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { LOCAL_MODELS } from "../../src/inference/local-catalog.js"
import {
  type LocalThinkingLevel,
  localThinkingCapability,
  localThinkingParameters,
} from "../../src/inference/local-thinking.js"
import {
  type CachedLocalModel,
  findCachedLocalModels,
  INTEGRATION_ENV,
  OTIS_INTEGRATION,
} from "../support/llama-fixtures.js"

/**
 * Verifies the thinking capability table against what each model's own chat template renders
 * on the pinned llama-server, through the same request fields Otis sends: every listed level
 * must be a distinct control, the table's default must be what the server renders with no
 * override, and a level Otis does not list must be inert or rejected by the template, unless the
 * exclusion is documented author guidance rather than a template limit.
 */
const ALL_LEVELS: readonly LocalThinkingLevel[] = [
  "off",
  "on",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

/** Levels a template honors that the table leaves out on the author's published guidance. */
const POLICY_EXCLUSIONS: Record<string, readonly LocalThinkingLevel[]> = {
  // https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf#best-practices names medium and
  // xhigh; the template itself also accepts low.
  "prism-ml/Ternary-Bonsai-2-27B-gguf": ["low"],
}

/** The wire form of a level as if it were listed, so unsupported levels can be probed too. */
function rawThinkingParameters(level: LocalThinkingLevel) {
  if (level === "off" || level === "on")
    return { chat_template_kwargs: { enable_thinking: level === "on" } }
  return { reasoning_effort: level }
}

const discovery = OTIS_INTEGRATION ? await findCachedLocalModels() : undefined
const cachedIds = new Set((discovery?.models ?? []).map((model) => model.spec.id))
const covered = (discovery?.models ?? []).filter((model) => localThinkingCapability(model.spec.id))
const reason = !OTIS_INTEGRATION
  ? "OTIS_INTEGRATION=1 is not set"
  : covered.length
    ? undefined
    : `no cached model has a thinking capability entry (cached: ${[...cachedIds].join(", ") || "none"})`
const TIMEOUT = 5 * 60 * 1000

if (reason) it.skip(`thinking capability table against chat templates: ${reason}`, () => {})

describe.skipIf(reason)("thinking capability table against chat templates", () => {
  for (const model of LOCAL_MODELS) {
    if (!localThinkingCapability(model.id)) continue
    if (!cachedIds.has(model.id)) {
      it.skip(`${model.id}: not cached on this machine`, () => {})
    }
  }

  for (const model of covered) {
    const capability = localThinkingCapability(model.spec.id)
    if (!capability) continue
    it(
      `${model.spec.id}: listed levels render distinct controls, the default matches the server, others are inert or rejected`,
      async () => {
        const server = await startTemplateServer(model)
        try {
          const base = await render(server.port, {})
          expect(base.prompt, "default render").toBeDefined()

          const renders = new Map<LocalThinkingLevel, Render>()
          for (const level of capability.levels) {
            renders.set(
              level,
              await render(server.port, localThinkingParameters(model.spec.id, level)),
            )
          }
          for (const [level, rendered] of renders) {
            expect(rendered.prompt, `${level} must render`).toBeDefined()
          }
          // The table's default is the server's own default: no override renders the same prompt.
          expect(renders.get(capability.defaultLevel)?.prompt).toBe(base.prompt)
          // Every listed level is its own control.
          const prompts = [...renders.values()].map((rendered) => rendered.prompt)
          expect(new Set(prompts).size).toBe(prompts.length)
          // Turning thinking off closes the think block before the answer starts.
          if (capability.levels.includes("off")) {
            expect(renders.get("off")?.prompt).toMatch(/<think>\s*<\/think>/)
            expect(renders.get("off")?.prompt).not.toBe(base.prompt)
          }

          for (const level of ALL_LEVELS) {
            if (capability.levels.includes(level)) continue
            const rendered = await render(server.port, rawThinkingParameters(level))
            if (POLICY_EXCLUSIONS[model.spec.id]?.includes(level)) {
              expect(rendered.prompt, `${level} is honored by the template`).toBeDefined()
              expect(rendered.prompt).not.toBe(base.prompt)
              continue
            }
            if (rendered.prompt !== undefined) {
              expect(rendered.prompt, `${level} must be ignored`).toBe(base.prompt)
            } else {
              expect(rendered.error, `${level} must be rejected by the template`).toMatch(
                /reasoning effort|reasoning_effort|enable_thinking|unexpected|unsupported/i,
              )
            }
          }
        } finally {
          await server.stop()
        }
      },
      TIMEOUT,
    )
  }
})

type Render = { prompt?: string; error?: string }

async function render(port: number, body: Record<string, unknown>): Promise<Render> {
  const response = await fetch(`http://127.0.0.1:${port}/apply-template`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Reply with one word." }],
      ...body,
    }),
  })
  const json = (await response.json()) as { prompt?: unknown; error?: { message?: unknown } }
  if (typeof json.prompt === "string") return { prompt: json.prompt }
  return {
    error: typeof json.error?.message === "string" ? json.error.message : `HTTP ${response.status}`,
  }
}

/**
 * The pinned runtime bundle serving the cached GGUF directly, with a small context: only the
 * template renderer is exercised, so no Otis startup probe or memory fit is involved.
 */
async function startTemplateServer(model: CachedLocalModel) {
  const port = await freePort()
  const child: ChildProcess = spawn(
    join(model.bundle.source, "llama-server"),
    [
      "--model",
      model.files[0].source,
      "--alias",
      model.spec.id,
      "--jinja",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--parallel",
      "1",
      "-c",
      "4096",
      "--no-webui",
    ],
    { env: INTEGRATION_ENV, stdio: ["ignore", "pipe", "pipe"] },
  )
  let logs = ""
  const append = (chunk: Buffer | string) => {
    logs = `${logs}${chunk}`.slice(-4_000)
  }
  child.stdout?.on("data", append)
  child.stderr?.on("data", append)
  await vi.waitFor(
    async () => {
      if (child.exitCode !== null) throw new Error(`llama-server exited:\n${logs}`)
      const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined)
      expect(response?.ok).toBe(true)
    },
    { timeout: 4 * 60 * 1000, interval: 250 },
  )
  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once("exit", () => resolve())
        child.kill("SIGTERM")
      }),
  }
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
