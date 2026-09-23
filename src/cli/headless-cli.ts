import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { Application } from "../app/application.js"
import { sessionArtifactPublisher } from "../app/artifacts.js"
import { resolveFireworksServing } from "../app/models.js"
import { executeTurn } from "../app/turn-runner.js"
import { autoCompactThreshold } from "../core/compaction.js"
import { loadAttachmentFiles } from "../inference/attachments.js"
import {
  compactionContextLength,
  reportedContextLengthIsServing,
} from "../inference/context-policy.js"
import { errorMessage } from "../inference/errors.js"
import { loadImageFiles } from "../inference/images.js"
import { findLocalModel, isLocalModelId } from "../inference/local-catalog.js"
import {
  lastAssistantText,
  messagesContainImages,
  userMessageAttachments,
} from "../inference/messages.js"
import { pairEndpointForEngine } from "../inference/pair.js"
import { baseFireworksModelId } from "../inference/serving-path.js"
import type { InferenceClient } from "../inference/types.js"
import { saveSelectedModel } from "../local/settings.js"
import {
  createPermissionPolicy,
  type PermissionMode,
  parsePermissionRuleString,
} from "../permissions/policy.js"
import { createSession, type JsonlSession, listSessions, openSession } from "../storage/session.js"
import { acquireSessionLock, type SessionLock } from "../storage/session-lock.js"
import { providerTools, TOOL_NAMES, type ToolName } from "../tools/index.js"
import {
  addUsage,
  emptyUsage,
  type HeadlessOutputFormat,
  HeadlessReporter,
} from "./headless-output.js"

type OutputStream = { write(chunk: string): unknown }

type HeadlessCommandOptions = {
  stdin?: AsyncIterable<unknown>
  stdout?: OutputStream
  stderr?: OutputStream
  env?: NodeJS.ProcessEnv
  processCwd?: string
}

export async function runHeadlessCommand(
  argv: string[],
  options: HeadlessCommandOptions = {},
): Promise<number> {
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
  const interrupt = () => controller.abort({ type: "signal", signal: "SIGINT" })
  const terminate = () => controller.abort({ type: "signal", signal: "SIGTERM" })
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", terminate)
  const timeout = parsed.timeoutMs
    ? setTimeout(
        () => controller.abort({ type: "timeout", timeoutMs: parsed.timeoutMs }),
        parsed.timeoutMs,
      )
    : undefined
  timeout?.unref()
  let lock: SessionLock | undefined
  let session: JsonlSession | undefined
  let model = parsed.model ?? ""
  let modelContextLength: number | undefined
  let usage = emptyUsage()
  let app: Application | undefined

  try {
    const cwd = resolve(options.processCwd ?? process.cwd(), parsed.cwd ?? ".")
    if (!(await stat(cwd)).isDirectory())
      throw new Error(`Working directory is not a directory: ${cwd}`)
    let prompt = parsed.promptParts.join(" ").trim()
    if (!prompt) {
      for await (const chunk of options.stdin ?? process.stdin) prompt += String(chunk)
      prompt = prompt.trim()
    }
    const attachments = [
      ...(await loadImageFiles(parsed.images, cwd)),
      ...(await loadAttachmentFiles(parsed.files, cwd)),
    ]
    const hasImages = attachments.some((attachment) => attachment.type === "image")
    if (!prompt && attachments.length === 0) throw new Error("A prompt or attachment is required.")

    app = await Application.create({
      cwd,
      env: options.env,
      isExiting: () => controller.signal.aborted,
    })
    const settings = app.settings
    model = parsed.model ?? settings.model ?? ""
    const modelProvider =
      parsed.model && parsed.model !== settings.model
        ? isLocalModelId(parsed.model)
          ? "local"
          : "fireworks"
        : (settings.modelProvider ?? (isLocalModelId(model) ? "local" : "fireworks"))
    modelContextLength = parsed.model ? undefined : settings.modelContextLength
    let modelSupportsImageInput = parsed.model ? undefined : settings.modelSupportsImageInput
    if (!model)
      throw new Error("A model is not configured. Run Otis interactively or pass --model.")

    const resolveServing = async (apiKey: string) => {
      const resolved = await resolveFireworksServing(apiKey, model, {
        fast: parsed.model
          ? undefined
          : settings.fastServingModels?.includes(baseFireworksModelId(model)),
        signal: controller.signal,
      })
      model = resolved.serving.id
      modelContextLength = resolved.serving.contextLength
      modelSupportsImageInput = resolved.serving.supportsImageInput
      if (!parsed.model && settings.model === resolved.selected.id)
        await saveSelectedModel(resolved.serving)
    }

    let client: InferenceClient
    if (modelProvider === "local") {
      const spec = findLocalModel(model)
      if (!spec) throw new Error(`Unknown local model: ${model}`)
      modelSupportsImageInput = spec.supportsImageInput
      const connected = await app.models.connect({
        provider: "local",
        modelId: model,
        signal: controller.signal,
      })
      client = connected.client
      model = connected.modelId
      modelContextLength = connected.contextLength
    } else if (modelProvider === "omlx") {
      const connected = await app.models.connect({
        provider: "omlx",
        modelId: model,
        signal: controller.signal,
      })
      modelSupportsImageInput = connected.supportsImageInput
      client = connected.client
      modelContextLength = connected.contextLength
    } else if (modelProvider === "pair") {
      const connected = await app.models.connect({
        provider: "pair",
        modelId: model,
        pairEndpoint: pairEndpointForEngine(settings.pairEndpoints ?? {}, settings.pairEngine),
        pairEngine: settings.pairEngine,
        supportsImageInput: modelSupportsImageInput,
        signal: controller.signal,
      })
      client = connected.client
      modelContextLength = connected.contextLength
    } else {
      const fireworksApiKey = settings.fireworksApiKey
      if (!fireworksApiKey) throw new Error("Fireworks API key is not configured.")
      if (parsed.model || (hasImages && modelSupportsImageInput === undefined))
        await resolveServing(fireworksApiKey)
      const connected = await app.models.connect({
        provider: "fireworks",
        modelId: model,
        fireworksApiKey,
        contextLength: modelContextLength,
        supportsImageInput: modelSupportsImageInput,
        signal: controller.signal,
      })
      client = connected.client
    }

    if (!parsed.ephemeral) {
      let sessionId = parsed.session
      if (parsed.continue) {
        sessionId = (await listSessions({ cwd }))[0]?.id
        if (!sessionId)
          throw new Error("There is no session to continue in this working directory.")
      }
      if (sessionId) {
        lock = await acquireSessionLock({ cwd, sessionId })
        session = await openSession({ cwd, sessionId })
      } else {
        session = await createSession({ cwd })
      }
    }
    const sessionContainsImages = session ? messagesContainImages(session.replayMessages()) : false
    if (
      sessionContainsImages &&
      modelProvider === "fireworks" &&
      modelSupportsImageInput === undefined &&
      settings.fireworksApiKey
    ) {
      await resolveServing(settings.fireworksApiKey)
    }
    modelContextLength = compactionContextLength({
      provider: modelProvider,
      contextLength: modelContextLength,
    })

    const replay = session?.replay()
    const history = replay?.messages ?? []
    // Images a PAIR server did not vouch for count as unsupported, like the interactive app.
    if (modelProvider !== "fireworks")
      app.models.supportsImageInput = modelSupportsImageInput === true
    const userMessage = await app.buildPrompt(prompt, attachments, {
      history,
      signal: controller.signal,
    })
    const admission = session ? await session.admitPrompt(userMessage) : undefined
    // `--tools` narrows the provider's catalog; it cannot enable a tool the provider does not
    // offer.
    const tools = providerTools(modelProvider).filter(
      (tool) =>
        (!parsed.tools || parsed.tools.has(tool.name)) &&
        (session || tool.name !== "publish_artifact"),
    )
    const configuredMode = parsed.permissionMode ?? settings.permissions?.defaultMode ?? "dontAsk"
    const permissionPolicy = createPermissionPolicy({
      cwd,
      mode: configuredMode === "ask" ? "dontAsk" : configuredMode,
      rules: [...app.permissionRules, ...parsed.permissionRules],
    })

    if (session && admission) await session.startTurn(admission)
    const result = await executeTurn({
      input: userMessage,
      history,
      historyDetails: replay,
      onCompaction: async (result, details, steeringCount, turn) => {
        if (session && admission)
          await session.compactTurn(
            admission,
            result.summary,
            result.keptMessages,
            details,
            steeringCount,
            turn,
          )
      },
      agent: {
        client,
        webClient: app.webClient,
        webClientModel: model,
        webSession: session ? { id: session.id } : undefined,
        cwd,
        signal: controller.signal,
        artifactPublisher: session ? sessionArtifactPublisher(session) : undefined,
        attachments: () =>
          session
            ?.replayTranscript()
            .messages.flatMap((message) =>
              message.role === "user" ? userMessageAttachments(message) : [],
            ) ?? [],
        projectContext: app.projectContext,
        skills: app.skills,
        tools,
        autoCompactAtTokens: autoCompactThreshold(modelContextLength),
        trustReportedContextLength: reportedContextLengthIsServing(modelProvider),
        onCompactionUsage: async (nextUsage) => {
          usage = addUsage(usage, nextUsage)
          await reporter.usage(nextUsage)
          if (session && admission)
            await session.recordUsage(nextUsage, "compaction", admission.promptId)
        },
        permissionPolicy,
        onUsage: async (nextUsage) => {
          usage = addUsage(usage, nextUsage)
          await reporter.usage(nextUsage)
          if (session && admission)
            await session.recordUsage(nextUsage, "agent", admission.promptId)
        },
      },
      onEvent: (event) => reporter.event(event),
    })

    const output = lastAssistantText(
      result.status === "complete" || result.status === "interrupted" ? result.messages : [],
    )
    if (session && admission) {
      if (result.status === "complete")
        await session.completeTurn(admission, result.messages, result.details)
      else if (result.status === "interrupted" || result.status === "error") {
        await session.interruptTurn(admission, result.messages, result.details)
      }
    }

    const interrupted = result.status === "interrupted"
    const error =
      result.status === "error"
        ? result.message
        : interrupted
          ? interruption(controller.signal).message
          : undefined
    await reporter.finish({
      status: result.status === "complete" ? "complete" : interrupted ? "interrupted" : "error",
      output,
      sessionId: session?.id,
      model,
      usage,
      durationMs: Date.now() - startedAt,
      ...(error ? { error } : {}),
    })
    return result.status === "complete"
      ? 0
      : interrupted
        ? interruption(controller.signal).exitCode
        : 1
  } catch (error) {
    const interrupted = controller.signal.aborted
    const message = interrupted ? interruption(controller.signal).message : errorMessage(error)
    await reporter.finish({
      status: interrupted ? "interrupted" : "error",
      output: "",
      sessionId: session?.id,
      model,
      usage,
      durationMs: Date.now() - startedAt,
      ...(message ? { error: message } : {}),
    })
    return interrupted ? interruption(controller.signal).exitCode : 1
  } finally {
    if (timeout) clearTimeout(timeout)
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
    await app?.shutdown()
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
      file: { type: "string", multiple: true },
      session: { type: "string", short: "s" },
      continue: { type: "boolean", short: "c" },
      ephemeral: { type: "boolean" },
      auto: { type: "boolean" },
      "permission-mode": { type: "string" },
      allow: { type: "string", multiple: true },
      ask: { type: "string", multiple: true },
      deny: { type: "string", multiple: true },
      tools: { type: "string" },
      timeout: { type: "string" },
      "output-format": { type: "string", default: "plain" },
      "include-reasoning": { type: "boolean" },
    },
  })
  if (values.session && values.continue)
    throw new Error("--session and --continue cannot be used together.")
  if (values.ephemeral && (values.session || values.continue)) {
    throw new Error("--ephemeral cannot be combined with --session or --continue.")
  }
  if (values.auto && values["permission-mode"])
    throw new Error("--auto and --permission-mode cannot be combined.")
  const permissionMode = values["permission-mode"]
  if (permissionMode !== undefined && permissionMode !== "auto" && permissionMode !== "dontAsk") {
    throw new Error("--permission-mode must be auto or dontAsk in headless mode.")
  }
  const outputFormat = values["output-format"]
  if (outputFormat !== "plain" && outputFormat !== "json" && outputFormat !== "jsonl") {
    throw new Error("--output-format must be plain, json, or jsonl.")
  }
  const tools = values.tools
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean)
  for (const name of tools ?? []) {
    if (!(TOOL_NAMES as readonly string[]).includes(name)) throw new Error(`Unknown tool: ${name}`)
  }
  const timeoutSeconds = values.timeout ? Number(values.timeout) : undefined
  if (
    timeoutSeconds !== undefined &&
    (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0)
  ) {
    throw new Error("--timeout must be a positive integer.")
  }
  return {
    help: values.help ?? false,
    cwd: values.cwd,
    model: values.model,
    images: values.image ?? [],
    files: values.file ?? [],
    session: values.session,
    continue: values.continue ?? false,
    ephemeral: values.ephemeral ?? false,
    permissionMode: values.auto ? "auto" : (permissionMode as PermissionMode | undefined),
    permissionRules: (["allow", "ask", "deny"] as const).flatMap((effect) =>
      (values[effect] ?? []).map((value) => parsePermissionRuleString(value, effect)),
    ),
    tools: tools && new Set(tools as ToolName[]),
    timeoutMs: timeoutSeconds && timeoutSeconds * 1_000,
    outputFormat: outputFormat as HeadlessOutputFormat,
    includeReasoning: values["include-reasoning"] ?? false,
    promptParts: positionals,
  }
}

function interruption(signal: AbortSignal) {
  const reason = signal.reason as { type?: string; signal?: string; timeoutMs?: number } | undefined
  if (reason?.type === "timeout")
    return { exitCode: 124, message: `Timed out after ${reason.timeoutMs}ms.` }
  const message = reason?.signal ? `Interrupted by ${reason.signal}.` : undefined
  return { exitCode: reason?.signal === "SIGTERM" ? 143 : 130, message }
}

const HEADLESS_HELP = `Usage: otis exec [options] [prompt...]

Run one non-interactive Otis turn. If no prompt is given, the prompt is read from stdin.

Options:
  -C, --cwd <path>             Working directory
  -m, --model <id>             Local catalog id or Fireworks serverless model
      --image <path>           Attach an image; repeatable
      --file <path>            Attach a text, PDF, DOCX, or image file; repeatable
  -s, --session <id>           Resume a specific local session
  -c, --continue               Resume the most recently updated session
      --ephemeral              Do not create or update a session
      --auto                   Allow write, edit, and bash tools
      --permission-mode <mode> auto or dontAsk (default: dontAsk)
      --allow <rule>           Allow matching Tool(resource); repeatable
      --ask <rule>             Require approval for matching calls; repeatable
      --deny <rule>            Deny matching Tool(resource); repeatable
      --tools <names>          Comma-separated tool allowlist
      --timeout <seconds>      Abort after the given duration
      --output-format <format> plain, json, or jsonl (default: plain)
      --include-reasoning      Include model-provided thinking traces in output
  -h, --help                   Show this help`
