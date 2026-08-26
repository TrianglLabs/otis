import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { loadProjectContext } from "../core/context.js"
import { FireworksClient, listToolCapableModels } from "../inference/client.js"
import { detectHardware } from "../inference/hardware.js"
import { loadImageFiles, validateImageAttachments } from "../inference/images.js"
import { LlamaCppRuntime } from "../inference/llama-runtime.js"
import { findLocalModel, isLocalModelId } from "../inference/local-catalog.js"
import { LlamaCppClient } from "../inference/local-client.js"
import { fitLocalModel } from "../inference/local-fit.js"
import { createUserMessage, imageAttachmentsFromMessages, messagesContainImages } from "../inference/messages.js"
import {
  baseFireworksModelId,
  findFireworksModel,
  fireworksServingModel,
  useFastServingPath,
} from "../inference/serving-path.js"
import { skillAdvertisementChars } from "../inference/system-prompt.js"
import type { ChatMessage, InferenceClient } from "../inference/types.js"
import { loadLocalSettings, saveSelectedModel } from "../local/settings.js"
import {
  createPermissionPolicy,
  type PermissionEffect,
  type PermissionMode,
  parsePermissionRuleString,
} from "../permissions/policy.js"
import { loadProjectPermissionRules } from "../permissions/project-policy.js"
import { loadSkillCatalog } from "../skills/index.js"
import {
  acquireSessionLock,
  createSession,
  type JsonlSession,
  listSessions,
  openSession,
  type SessionLock,
} from "../storage/index.js"
import { TOOL_DEFINITIONS, TOOL_NAMES, type ToolDefinition, type ToolName } from "../tools/index.js"
import { ParallelClient } from "../web/client.js"
import { addUsage, emptyUsage, type HeadlessOutputFormat, HeadlessReporter } from "./headless-output.js"
import { prepareSessionHistory } from "./session-history.js"
import { executeTurn } from "./turn-runner.js"

const DEFAULT_MAX_STEPS = 50

type OutputStream = { write(chunk: string): unknown }

export type HeadlessCommandOptions = {
  stdin?: AsyncIterable<unknown>
  stdout?: OutputStream
  stderr?: OutputStream
  env?: NodeJS.ProcessEnv
  processCwd?: string
}

export async function runHeadlessCommand(argv: string[], options: HeadlessCommandOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  let parsed: ReturnType<typeof parseHeadlessArgs>
  try {
    parsed = parseHeadlessArgs(argv)
  } catch (error) {
    stderr.write(`Error: ${errorMessage(error)}\n\n${HEADLESS_HELP}\n`)
    return 2
  }
  if (parsed.help) {
    stdout.write(`${HEADLESS_HELP}\n`)
    return 0
  }

  const reporter = new HeadlessReporter(parsed.outputFormat, stdout, stderr, {
    includeReasoning: parsed.includeReasoning,
  })
  const startedAt = Date.now()
  const controller = new AbortController()
  const removeSignals = installSignalHandlers(controller)
  const timeout = parsed.timeoutMs
    ? setTimeout(() => controller.abort({ type: "timeout", timeoutMs: parsed.timeoutMs }), parsed.timeoutMs)
    : undefined
  timeout?.unref()
  let lock: SessionLock | undefined
  let session: JsonlSession | undefined
  let model = parsed.model ?? ""
  let modelContextLength: number | undefined
  let usage = emptyUsage()
  let llama: LlamaCppRuntime | undefined

  try {
    const cwd = resolve(options.processCwd ?? process.cwd(), parsed.cwd ?? ".")
    if (!(await stat(cwd)).isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`)
    const prompt = await readPrompt(parsed.promptParts, options.stdin ?? process.stdin)
    const images = await loadImageFiles(parsed.images, cwd)
    if (!prompt.trim() && images.length === 0) throw new Error("A prompt or image is required.")
    const userMessage = createUserMessage(prompt, images)

    const settings = await loadLocalSettings({ env: options.env })
    model = parsed.model ?? settings.model ?? ""
    modelContextLength = parsed.model ? undefined : settings.modelContextLength
    let modelSupportsImageInput = parsed.model ? undefined : settings.modelSupportsImageInput
    if (!model) throw new Error("A model is not configured. Run Otis interactively or pass --model.")

    let client: InferenceClient
    if (isLocalModelId(model)) {
      const spec = findLocalModel(model)
      if (!spec) throw new Error(`Unknown local model: ${model}`)
      modelSupportsImageInput = spec.supportsImageInput
      if (images.length > 0 && !spec.supportsImageInput) {
        throw new Error(`Selected model does not support image input: ${model}`)
      }
      const hardware = await detectHardware()
      const fit = fitLocalModel(spec, hardware)
      llama = new LlamaCppRuntime({ env: options.env })
      const serving = await llama.ensureServing(spec, fit, hardware, { signal: controller.signal })
      client = new LlamaCppClient({ model: spec.id, inferenceURL: serving.inferenceURL })
      model = spec.id
      modelContextLength = serving.contextLength
    } else {
      if (!settings.fireworksApiKey) throw new Error("Fireworks API key is not configured.")
      if (parsed.model || (images.length > 0 && modelSupportsImageInput === undefined)) {
        const resolved = await resolveFireworksServing(settings.fireworksApiKey, model, {
          fast: parsed.model ? undefined : settings.fastServingModels?.includes(baseFireworksModelId(model)),
          signal: controller.signal,
        })
        model = resolved.serving.id
        modelContextLength = resolved.serving.contextLength
        modelSupportsImageInput = resolved.serving.supportsImageInput
        if (!parsed.model && settings.model === resolved.selected.id) await saveSelectedModel(resolved.serving)
      }
      if (images.length > 0 && !modelSupportsImageInput) {
        throw new Error(`Selected model does not support image input: ${model}`)
      }
      client = new FireworksClient({ apiKey: settings.fireworksApiKey, model })
    }
    const projectContext = loadProjectContext(cwd)
    const skills = await loadSkillCatalog(cwd)
    const staticContextChars =
      projectContext.reduce((sum, file) => sum + file.content.length, 0) + skillAdvertisementChars(skills.skills)

    if (!parsed.ephemeral) {
      const selectedSessionId = await resolveSessionId(parsed, cwd)
      if (selectedSessionId) {
        lock = await acquireSessionLock({ cwd, sessionId: selectedSessionId })
        session = await openSession({ cwd, sessionId: selectedSessionId })
      } else {
        session = await createSession({ cwd })
      }
    }
    const sessionContainsImages = session ? messagesContainImages(session.replayMessages()) : false
    if (sessionContainsImages && modelSupportsImageInput === undefined && settings.fireworksApiKey) {
      const resolved = await resolveFireworksServing(settings.fireworksApiKey, model, {
        fast: parsed.model ? undefined : settings.fastServingModels?.includes(baseFireworksModelId(model)),
        signal: controller.signal,
      })
      model = resolved.serving.id
      modelContextLength = resolved.serving.contextLength
      modelSupportsImageInput = resolved.serving.supportsImageInput
      if (!parsed.model && settings.model === resolved.selected.id) await saveSelectedModel(resolved.serving)
    }
    if (sessionContainsImages && !modelSupportsImageInput) {
      throw new Error(`Selected model does not support image input required by this session: ${model}`)
    }

    const history = session
      ? await prepareSessionHistory({
          session,
          client,
          contextLength: modelContextLength,
          staticContextChars,
          signal: controller.signal,
          onUsage: async (nextUsage) => {
            usage = addUsage(usage, nextUsage)
            await reporter.usage(nextUsage)
            await session?.recordUsage(nextUsage, "compaction")
          },
        })
      : []
    validateImageAttachments(imageAttachmentsFromMessages([...history, userMessage]))
    const admission = session ? await session.admitPrompt(userMessage) : undefined
    const webClient = new ParallelClient()
    const tools = selectedTools(parsed.tools)
    const projectPermissionRules = await loadProjectPermissionRules(cwd)
    const permissionPolicy = createPermissionPolicy({
      cwd,
      mode: headlessPermissionMode(parsed.permissionMode, settings.permissions?.defaultMode),
      rules: [...(settings.permissions?.rules ?? []), ...projectPermissionRules, ...parsed.permissionRules],
    })

    const result = await executeTurn({
      input: userMessage,
      history,
      agent: {
        client,
        webClient,
        webClientModel: model,
        webSession: session ? { id: session.id } : undefined,
        cwd,
        signal: controller.signal,
        projectContext,
        skills,
        tools,
        maxSteps: parsed.maxSteps,
        permissionPolicy,
        onUsage: async (nextUsage) => {
          usage = addUsage(usage, nextUsage)
          await reporter.usage(nextUsage)
          if (session && admission) await session.recordUsage(nextUsage, "agent", admission.promptId)
        },
      },
      onEvent: (event) => reporter.event(event),
    })

    const output = assistantText(result.status === "complete" || result.status === "interrupted" ? result.messages : [])
    if (session && admission) {
      if (result.status === "complete") await session.completeTurn(admission, result.messages, result.toolActivities)
      else if (result.status === "interrupted") {
        await session.interruptTurn(admission, result.messages, result.toolActivities)
      } else if (result.status === "error") {
        await session.interruptTurn(admission, result.messages, result.toolActivities)
      }
    }

    if (result.status === "complete") {
      await reporter.finish({
        status: "complete",
        output,
        sessionId: session?.id,
        model,
        usage,
        durationMs: Date.now() - startedAt,
      })
      return 0
    }
    const error = result.status === "error" ? result.message : interruptionMessage(controller.signal)
    await reporter.finish({
      status: result.status === "interrupted" ? "interrupted" : "error",
      output,
      sessionId: session?.id,
      model,
      usage,
      durationMs: Date.now() - startedAt,
      ...(error ? { error } : {}),
    })
    return result.status === "interrupted" ? interruptionExitCode(controller.signal) : 1
  } catch (error) {
    const interrupted = controller.signal.aborted
    await reporter.finish({
      status: interrupted ? "interrupted" : "error",
      output: "",
      sessionId: session?.id,
      model,
      usage,
      durationMs: Date.now() - startedAt,
      ...(!interrupted
        ? { error: errorMessage(error) }
        : interruptionMessage(controller.signal)
          ? { error: interruptionMessage(controller.signal) }
          : {}),
    })
    return interrupted ? interruptionExitCode(controller.signal) : 1
  } finally {
    if (timeout) clearTimeout(timeout)
    removeSignals()
    await llama?.stop()
    await lock?.release()
  }
}

function parseHeadlessArgs(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      cwd: { type: "string", short: "C" },
      model: { type: "string", short: "m" },
      image: { type: "string", multiple: true },
      session: { type: "string", short: "s" },
      continue: { type: "boolean", short: "c" },
      ephemeral: { type: "boolean" },
      auto: { type: "boolean" },
      "permission-mode": { type: "string" },
      allow: { type: "string", multiple: true },
      ask: { type: "string", multiple: true },
      deny: { type: "string", multiple: true },
      tools: { type: "string" },
      "max-steps": { type: "string" },
      timeout: { type: "string" },
      "output-format": { type: "string", default: "plain" },
      "include-reasoning": { type: "boolean" },
    },
  })
  if (values.session && values.continue) throw new Error("--session and --continue cannot be used together.")
  if (values.ephemeral && (values.session || values.continue)) {
    throw new Error("--ephemeral cannot be combined with --session or --continue.")
  }
  if (values.auto && values["permission-mode"]) throw new Error("--auto and --permission-mode cannot be combined.")
  const outputFormat = values["output-format"]
  if (outputFormat !== "plain" && outputFormat !== "json" && outputFormat !== "jsonl") {
    throw new Error("--output-format must be plain, json, or jsonl.")
  }
  return {
    help: values.help ?? false,
    cwd: values.cwd,
    model: values.model,
    images: values.image ?? [],
    session: values.session,
    continue: values.continue ?? false,
    ephemeral: values.ephemeral ?? false,
    permissionMode: values.auto ? "auto" : parseHeadlessPermissionMode(values["permission-mode"]),
    permissionRules: [
      ...parseCliPermissionRules(values.allow, "allow"),
      ...parseCliPermissionRules(values.ask, "ask"),
      ...parseCliPermissionRules(values.deny, "deny"),
    ],
    tools: values.tools === undefined ? undefined : parseToolNames(values.tools),
    maxSteps: positiveInteger(values["max-steps"] ?? String(DEFAULT_MAX_STEPS), "--max-steps"),
    timeoutMs: values.timeout ? positiveInteger(values.timeout, "--timeout") * 1_000 : undefined,
    outputFormat: outputFormat as HeadlessOutputFormat,
    includeReasoning: values["include-reasoning"] ?? false,
    promptParts: positionals,
  }
}

function parseHeadlessPermissionMode(value: string | undefined): PermissionMode | undefined {
  if (value === undefined) return undefined
  if (value === "dontAsk") return "dontAsk"
  if (value === "auto") return "auto"
  throw new Error("--permission-mode must be auto or dontAsk in headless mode.")
}

function headlessPermissionMode(
  commandMode: PermissionMode | undefined,
  configuredMode: PermissionMode | undefined,
): PermissionMode {
  const mode = commandMode ?? configuredMode ?? "dontAsk"
  return mode === "ask" ? "dontAsk" : mode
}

function parseCliPermissionRules(values: string[] | undefined, effect: PermissionEffect) {
  return (values ?? []).map((value) => parsePermissionRuleString(value, effect))
}

async function resolveSessionId(parsed: ReturnType<typeof parseHeadlessArgs>, cwd: string) {
  if (parsed.session) return parsed.session
  if (!parsed.continue) return undefined
  const sessions = await listSessions({ cwd })
  if (!sessions[0]) throw new Error("There is no session to continue in this working directory.")
  return sessions[0].id
}

function selectedTools(requestedTools: Set<ToolName> | undefined): ToolDefinition[] {
  const requested = requestedTools ?? new Set<ToolName>(TOOL_NAMES)
  return TOOL_DEFINITIONS.filter((tool) => requested.has(tool.name))
}

function parseToolNames(value: string) {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
  const result = new Set<ToolName>()
  for (const name of names) {
    if (!(TOOL_NAMES as readonly string[]).includes(name)) throw new Error(`Unknown tool: ${name}`)
    result.add(name as ToolName)
  }
  return result
}

async function readPrompt(parts: string[], stdin: AsyncIterable<unknown>) {
  const argumentPrompt = parts.join(" ").trim()
  if (argumentPrompt) return argumentPrompt
  let stdinPrompt = ""
  for await (const chunk of stdin) stdinPrompt += String(chunk)
  return stdinPrompt.trim()
}

function assistantText(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim()
  }
  return ""
}

function positiveInteger(value: string, label: string) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`)
  return number
}

function installSignalHandlers(controller: AbortController) {
  const interrupt = () => controller.abort({ type: "signal", signal: "SIGINT" })
  const terminate = () => controller.abort({ type: "signal", signal: "SIGTERM" })
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", terminate)
  return () => {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
  }
}

function interruptionExitCode(signal: AbortSignal) {
  const reason = signal.reason as { type?: string; signal?: string } | undefined
  if (reason?.type === "timeout") return 124
  return reason?.signal === "SIGTERM" ? 143 : 130
}

function interruptionMessage(signal: AbortSignal) {
  const reason = signal.reason as { type?: string; signal?: string; timeoutMs?: number } | undefined
  if (reason?.type === "timeout") return `Timed out after ${reason.timeoutMs ?? "unknown"}ms.`
  if (reason?.signal) return `Interrupted by ${reason.signal}.`
  return undefined
}

async function resolveFireworksServing(
  apiKey: string,
  modelId: string,
  options: { fast?: boolean; signal: AbortSignal },
) {
  const models = await listToolCapableModels(apiKey, { signal: options.signal })
  const selected = findFireworksModel(models, modelId)
  if (!selected) throw new Error(`Model is not a tool-capable Fireworks serverless model: ${modelId}`)
  return {
    selected,
    serving: fireworksServingModel(selected, useFastServingPath(modelId, options.fast)),
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export const HEADLESS_HELP = `Usage: otis exec [options] [prompt...]

Run one non-interactive Otis turn. If no prompt is given, the prompt is read from stdin.

Options:
  -C, --cwd <path>             Working directory
  -m, --model <id>             Local catalog id or Fireworks serverless model
      --image <path>           Attach an image; repeatable
  -s, --session <id>           Resume a specific local session
  -c, --continue               Resume the most recently updated session
      --ephemeral              Do not create or update a session
      --auto                   Allow write, edit, and bash tools
      --permission-mode <mode> auto or dontAsk (default: dontAsk)
      --allow <rule>           Allow matching Tool(resource); repeatable
      --ask <rule>             Require approval for matching calls; repeatable
      --deny <rule>            Deny matching Tool(resource); repeatable
      --tools <names>          Comma-separated tool allowlist
      --max-steps <count>      Maximum model/tool loop steps (default: ${DEFAULT_MAX_STEPS})
      --timeout <seconds>      Abort after the given duration
      --output-format <format> plain, json, or jsonl (default: plain)
      --include-reasoning      Include model-provided thinking traces in output
  -h, --help                   Show this help`
