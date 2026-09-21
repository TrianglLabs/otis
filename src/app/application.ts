import { resolve } from "node:path"
import type { ArtifactReference } from "../artifacts/types.js"
import { loadProjectContext } from "../core/context.js"
import { requestContextEstimator } from "../core/context-tokens.js"
import { providerTools } from "../core/subagent.js"
import { requireLocalContextLength } from "../inference/context-policy.js"
import type { LocalLoadProgress } from "../inference/llama-runtime.js"
import { catalogModelFromSpec, findLocalModel } from "../inference/local-catalog.js"
import { createPairClient, type PairEndpoints, pairEndpointForEngine } from "../inference/pair.js"
import type { ContextFile, OutputCapabilities, UserChatMessage } from "../inference/types.js"
import { type LocalSettings, loadLocalSettings, saveLocalServers, saveLocalThinking } from "../local/settings.js"
import {
  createPermissionPolicy,
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  type PermissionRule,
} from "../permissions/policy.js"
import { loadProjectPermissionRules } from "../permissions/project-policy.js"
import { loadSkillCatalog, type SkillCatalog } from "../skills/index.js"
import { ParallelClient } from "../web/client.js"
import { ArtifactStore } from "./artifacts.js"
import { Conversation } from "./conversation.js"
import { type LocalServerDiscoveryOptions, type LocalServerInputs, prepareLocalServers } from "./local-servers.js"
import { ModelHost } from "./models.js"
import { SessionCoordinator } from "./sessions.js"
import { SubagentTraces } from "./subagents.js"
import { TranscriptStore } from "./transcript.js"

export type ApplicationOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  isBusy?: () => boolean
  isExiting?: () => boolean
  outputCapabilities?: OutputCapabilities
}

export class Application {
  readonly cwd: string
  readonly outputCapabilities: OutputCapabilities
  readonly transcript = new TranscriptStore()
  readonly artifacts: ArtifactStore
  readonly subagents = new SubagentTraces()
  readonly models: ModelHost
  readonly sessions: SessionCoordinator
  readonly conversation: Conversation
  readonly webClient = new ParallelClient()
  settings: LocalSettings
  projectContext: ContextFile[] = []
  skills!: SkillCatalog
  permissionMode: PermissionMode
  permissionRules: PermissionRule[]
  fireworksApiKey: string | undefined
  pairEndpoints: PairEndpoints

  static async create(options: ApplicationOptions = {}) {
    const cwd = resolve(options.cwd ?? process.cwd())
    const settings = await loadLocalSettings({ env: options.env })
    const app = new Application(cwd, settings, options)
    app.models.applySavedSelection(settings)
    await app.refreshWorkspace()
    return app
  }

  private constructor(cwd: string, settings: LocalSettings, options: ApplicationOptions) {
    this.cwd = cwd
    this.artifacts = new ArtifactStore(cwd)
    this.outputCapabilities = options.outputCapabilities ?? {}
    this.settings = settings
    this.fireworksApiKey = settings.fireworksApiKey
    this.pairEndpoints = { ...settings.pairEndpoints }
    this.permissionMode = settings.permissions?.defaultMode ?? DEFAULT_PERMISSION_MODE
    this.permissionRules = [...(settings.permissions?.rules ?? [])]
    this.models = new ModelHost({ env: options.env })
    this.sessions = new SessionCoordinator({
      cwd,
      transcript: this.transcript,
      subagents: this.subagents,
      client: () => this.models.client,
      isBusy: () => (options.isBusy?.() ?? false) || this.conversation.busy,
      isExiting: options.isExiting ?? (() => false),
      onReset: () => this.artifacts.clear(),
      onReplay: (messages, activities, session) =>
        this.artifacts.restore(messages, activities, session.artifactDirectory),
    })
    this.conversation = new Conversation({
      sessions: this.sessions,
      transcript: this.transcript,
      subagents: this.subagents,
      webClient: this.webClient,
      cwd,
      models: this.models,
      projectContext: () => this.projectContext,
      skills: () => this.skills,
      permissionPolicy: () => this.createPermissionPolicy(),
      isExiting: options.isExiting ?? (() => false),
      outputCapabilities: this.outputCapabilities,
      artifacts: this.artifacts,
    })
  }

  async refreshWorkspace() {
    this.projectContext = loadProjectContext(this.cwd)
    this.skills = await loadSkillCatalog(this.cwd)
    this.permissionRules = [
      ...(this.settings.permissions?.rules ?? []),
      ...(await loadProjectPermissionRules(this.cwd)),
    ]
  }

  async setLocalThinking(model: string, level: string) {
    if (this.conversation.busy) throw new Error("Finish the current work before changing thinking effort.")
    if (this.models.selectedProvider !== "local" || this.models.selectedId !== model) {
      throw new Error("The selected local model has changed.")
    }
    const preferences = await saveLocalThinking(model, level)
    this.settings.localThinking = preferences
    this.models.localThinking = preferences
    this.transcript.invalidateContext()
  }

  createPermissionPolicy() {
    return createPermissionPolicy({
      cwd: this.cwd,
      mode: this.permissionMode,
      rules: this.permissionRules,
    })
  }

  contextEstimator() {
    const tools = providerTools(this.models.selectedProvider ?? "fireworks").filter(
      (tool) => tool.name !== "skill" || this.skills.skills.length > 0,
    )
    return requestContextEstimator({
      tools,
      projectContext: this.projectContext,
      skills: tools.some((tool) => tool.name === "skill") ? this.skills.skills : [],
      outputCapabilities: this.outputCapabilities,
    })
  }

  contextTokens(pendingInput?: UserChatMessage) {
    const estimate = this.contextEstimator()
    const tokens = this.transcript.contextTokens(this.models.client) ?? estimate(this.transcript.history)
    return pendingInput ? tokens + estimate([pendingInput]) - estimate([]) : tokens
  }

  openArtifact(reference: ArtifactReference, version?: number) {
    return this.artifacts.open(reference, version)
  }

  hasConfiguredSelection() {
    const model = this.models
    const pairEndpoint = pairEndpointForEngine(this.pairEndpoints, model.pairEngine)
    return Boolean(
      model.selectedId &&
        ((model.selectedProvider === "fireworks" && this.fireworksApiKey) ||
          model.selectedProvider === "local" ||
          (model.selectedProvider === "omlx" && model.omlx) ||
          (model.selectedProvider === "pair" && pairEndpoint)),
    )
  }

  async connectLocalServers(input: LocalServerInputs, options: LocalServerDiscoveryOptions = {}) {
    if (this.conversation.busy) throw new Error("Wait for the current turn before changing local servers.")
    const connection = await this.models.enqueueSelection(async (signal) => {
      const combined = options.signal ? AbortSignal.any([signal, options.signal]) : signal
      const servers = await prepareLocalServers(input, this.models.omlx, { ...options, signal: combined })
      combined.throwIfAborted()
      if (this.models.selectedProvider === "omlx") {
        const model = servers.omlxModels.find((entry) => entry.id === this.models.selectedId)
        if (model) {
          try {
            requireLocalContextLength(model.contextLength, "oMLX")
          } catch (error) {
            // A refreshed limit invalidates the existing client only when it describes the same server.
            if (model.baseURL === this.models.omlx?.baseURL) {
              this.models.client = undefined
              this.transcript.invalidateContext()
            }
            throw error
          }
        }
      }
      await saveLocalServers(servers)
      this.pairEndpoints = servers.pairEndpoints
      this.models.omlx = servers.omlx
      const id = this.models.selectedId
      if (id && this.models.selectedProvider === "pair") {
        const model = servers.pairModels.find((entry) => entry.id === id && entry.engine === this.models.pairEngine)
        if (model)
          this.models.activate(model, createPairClient({ baseURL: model.baseURL, model: id, engine: model.engine }))
        else this.models.client = undefined
      }
      if (id && this.models.selectedProvider === "omlx") {
        const model = servers.omlxModels.find((entry) => entry.id === id)
        if (model) this.models.activate(model, this.models.omlxClient(id, model.baseURL))
        else this.models.client = undefined
      }
      this.transcript.invalidateContext()
      return servers
    })
    if (!connection) throw new Error("The connection was cancelled.")
    return connection
  }

  /**
   * Activates the saved selection. Fireworks and PAIR clients already exist after `applySavedSelection`; a saved
   * local model still needs its managed llama-server started before any conversation can run. Throws with the
   * serving error when startup fails; the previous selection is left untouched.
   */
  async startSavedSelection(
    options: {
      signal?: AbortSignal
      isExiting?: () => boolean
      onLocalProgress?: (progress: LocalLoadProgress) => void
    } = {},
  ): Promise<"ready" | "unconfigured"> {
    const models = this.models
    if (models.client) return "ready"
    if (!models.selectedId || !models.selectedProvider) return "unconfigured"
    if (models.selectedProvider === "omlx") {
      await models.connect({ provider: "omlx", modelId: models.selectedId, signal: options.signal })
      return "ready"
    }
    if (models.selectedProvider !== "local") return "unconfigured"

    const spec = findLocalModel(models.selectedId)
    if (!spec) throw new Error(`Unknown local model: ${models.selectedId}`)
    const prepared = await models.prepare(catalogModelFromSpec(spec, this.settings.modelContextLength), {
      fireworksApiKey: this.fireworksApiKey,
      signal: options.signal ?? new AbortController().signal,
      isExiting: options.isExiting,
      onLocalProgress: options.onLocalProgress,
    })
    try {
      options.signal?.throwIfAborted()
    } catch (error) {
      await prepared.rollback({ restorePrevious: false })
      throw error
    }
    prepared.commit()
    return "ready"
  }

  async shutdown() {
    this.artifacts.dispose()
    this.conversation.cancel()
    this.models.cancelPrepare()
    this.models.cancelSelection()
    await Promise.allSettled([this.conversation.wait(), this.models.waitForSelection()])
    await this.sessions.releaseLock()
    await this.models.stop()
  }
}
