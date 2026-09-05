import { resolve } from "node:path"
import { loadProjectContext } from "../core/context.js"
import { requestContextEstimator } from "../core/context-tokens.js"
import { providerTools } from "../core/subagent.js"
import { type PairEndpoints, pairEndpointForEngine } from "../inference/pair.js"
import type { ContextFile } from "../inference/types.js"
import { type LocalSettings, loadLocalSettings } from "../local/settings.js"
import {
  createPermissionPolicy,
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  type PermissionRule,
} from "../permissions/policy.js"
import { loadProjectPermissionRules } from "../permissions/project-policy.js"
import { loadSkillCatalog, type SkillCatalog } from "../skills/index.js"
import { ParallelClient } from "../web/client.js"
import { Conversation } from "./conversation.js"
import { ModelHost } from "./models.js"
import { SessionCoordinator } from "./sessions.js"
import { SubagentTraces } from "./subagents.js"
import { TranscriptStore } from "./transcript.js"

export type ApplicationOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  isBusy?: () => boolean
  isExiting?: () => boolean
}

export class Application {
  readonly cwd: string
  readonly transcript = new TranscriptStore()
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
    })
  }

  hasConfiguredSelection() {
    const model = this.models
    const pairEndpoint = pairEndpointForEngine(this.pairEndpoints, model.pairEngine)
    return Boolean(
      model.selectedId &&
        ((model.selectedProvider === "fireworks" && this.fireworksApiKey) ||
          model.selectedProvider === "local" ||
          (model.selectedProvider === "pair" && pairEndpoint)),
    )
  }

  async shutdown() {
    this.conversation.cancel()
    this.models.cancelPrepare()
    this.models.cancelSelection()
    await Promise.allSettled([this.conversation.wait(), this.models.waitForSelection()])
    await this.models.stop()
  }
}
