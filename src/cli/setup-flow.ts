import { listToolCapableModels } from "../inference/client.js"
import { selectDefaultFireworksModel } from "../inference/model-policy.js"
import type { FireworksModel } from "../inference/types.js"
import { type LocalSettings, saveFireworksSetup, saveSelectedModel } from "../local/settings.js"
import type { ChatUI } from "./chat-ui.js"
import { openFireworksKeyPage } from "./provider-links.js"

type SetupFlowOptions = {
  ui: ChatUI
  settings: LocalSettings
  isBusy: () => boolean
  setBusy: (busy: boolean) => void
  onCredentialsChanged: (credentials: { fireworksApiKey?: string }) => void
  onModelSelected: (model: FireworksModel) => void
  onConfigured: (fireworksApiKey: string, model: FireworksModel) => void
}

export class SetupFlow {
  #fireworksApiKey: string | undefined
  #selectedModel: string | undefined
  #selectedModelSupportsImageInput: boolean | undefined
  #models: FireworksModel[] = []
  #persistFireworksApiKey = false
  #wasConfigured = false
  #openedFireworksKeyPage = false

  constructor(private readonly options: SetupFlowOptions) {
    this.#fireworksApiKey = options.settings.fireworksApiKey
    this.#selectedModel = options.settings.model
    this.#selectedModelSupportsImageInput = options.settings.modelSupportsImageInput
  }

  begin() {
    if (this.options.isBusy()) return
    if (!this.#fireworksApiKey) {
      this.requestFireworksKey()
      return
    }
    if (!this.#selectedModel) {
      void this.selectDefaultModel(this.#fireworksApiKey)
      return
    }
    this.finish()
  }

  async submitCredential(value: string) {
    const apiKey = value.trim()
    if (!apiKey) {
      this.options.ui.showSetupError("Fireworks API key is required.")
      return
    }

    this.#fireworksApiKey = apiKey
    this.#persistFireworksApiKey = true
    await this.selectDefaultModel(apiKey)
  }

  async openModelPicker(apiKey: string, currentModel: string | undefined, wasConfigured: boolean) {
    await this.loadModels(apiKey, currentModel, wasConfigured)
  }

  async selectModel(model: FireworksModel) {
    if (this.options.isBusy() || !this.#fireworksApiKey) return
    const selected = this.#models.find((candidate) => candidate.id === model.id)
    if (!selected) {
      this.options.ui.showSetupError("Select a model from the verified Fireworks catalog.")
      return
    }

    this.options.setBusy(true)
    try {
      await this.persistModelSelection(selected)
      this.options.ui.hideModelPicker()
      this.finish(selected)
    } catch (error) {
      this.options.ui.hideModelPicker()
      this.options.ui.showSetupError(errorMessage(error))
    } finally {
      this.options.setBusy(false)
    }
  }

  closeModelPicker() {
    if (this.#wasConfigured) {
      this.options.ui.setConfigured()
      this.options.ui.focusInput()
      return
    }
    this.options.ui.showHomeLayout()
    this.options.ui.showSetupButton()
  }

  private requestFireworksKey() {
    this.options.ui.showSetupInput("Inference + tool calling · Get key: app.fireworks.ai/api-keys")
    if (this.#openedFireworksKeyPage) return
    this.#openedFireworksKeyPage = true
    void openFireworksKeyPage()
  }

  private async loadModels(apiKey: string, currentModel: string | undefined, wasConfigured: boolean) {
    if (this.options.isBusy()) return
    this.options.setBusy(true)
    if (wasConfigured) {
      this.options.ui.showChatLayout()
      this.options.ui.showTransientHint(" Loading models… ")
    } else {
      this.options.ui.showSetupStatus()
    }

    try {
      const models = await this.loadVerifiedModels(apiKey)
      this.#wasConfigured = wasConfigured
      this.options.ui.showModelPicker(models.map((model) => ({ ...model, active: model.id === currentModel })))
    } catch (error) {
      if (wasConfigured) {
        this.options.ui.showChatLayout()
        this.options.ui.setConfigured()
        this.options.ui.focusInput()
      } else {
        this.options.ui.showSetupError(errorMessage(error))
      }
    } finally {
      this.options.setBusy(false)
    }
  }

  private async selectDefaultModel(apiKey: string) {
    if (this.options.isBusy()) return
    this.options.setBusy(true)
    this.options.ui.showSetupStatus()

    try {
      const models = await this.loadVerifiedModels(apiKey)
      const selected = selectDefaultFireworksModel(models)
      if (!selected) throw new Error("Fireworks returned no public serverless models with tool support.")
      await this.persistModelSelection(selected)
      this.finish(selected)
    } catch (error) {
      this.options.ui.showSetupError(errorMessage(error))
    } finally {
      this.options.setBusy(false)
    }
  }

  private async loadVerifiedModels(apiKey: string) {
    const models = await listToolCapableModels(apiKey)
    if (models.length === 0) throw new Error("Fireworks returned no public serverless models with tool support.")
    this.#fireworksApiKey = apiKey
    this.#models = models
    return models
  }

  private async persistModelSelection(selected: FireworksModel) {
    const fireworksApiKey = this.#fireworksApiKey
    if (!fireworksApiKey) throw new Error("Fireworks API key is required.")

    if (this.#persistFireworksApiKey) await saveFireworksSetup(fireworksApiKey, selected)
    else await saveSelectedModel(selected)
    this.#selectedModel = selected.id
    this.#selectedModelSupportsImageInput = selected.supportsImageInput
    this.options.onCredentialsChanged({ fireworksApiKey })
    this.options.onModelSelected(selected)
  }

  private finish(model?: FireworksModel) {
    const fireworksApiKey = this.#fireworksApiKey
    const selected =
      model ??
      this.#models.find((candidate) => candidate.id === this.#selectedModel) ??
      (this.#selectedModel ? modelFromId(this.#selectedModel, this.#selectedModelSupportsImageInput) : undefined)
    if (!fireworksApiKey || !selected) return

    this.options.onConfigured(fireworksApiKey, selected)
    this.options.ui.setConfigured()
    this.options.ui.focusInput()
  }
}

function modelFromId(id: string, supportsImageInput = false): FireworksModel {
  return { id, displayName: id.split("/").at(-1) ?? id, supportsImageInput }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
