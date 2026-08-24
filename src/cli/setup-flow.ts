import { listToolCapableModels } from "../inference/client.js"
import { selectDefaultFireworksModel } from "../inference/model-policy.js"
import {
  findFireworksModel,
  fireworksServingModel,
  isFastFireworksModel,
  matchesFireworksModel,
} from "../inference/serving-path.js"
import type { FireworksModel } from "../inference/types.js"
import { type LocalSettings, saveFastMode, saveFireworksSetup, saveSelectedModel } from "../local/settings.js"
import { openFireworksKeyPage } from "./provider-links.js"
import type { ChatUI } from "./ui/types.js"

type SetupFlowOptions = {
  ui: ChatUI
  settings: LocalSettings
  isBusy: () => boolean
  setBusy: (busy: boolean) => void
  onCredentialsChanged: (credentials: { fireworksApiKey?: string }) => void
  onModelSelected: (model: FireworksModel) => void
  onConfigured: (fireworksApiKey: string, model: FireworksModel) => void
  fastMode: () => boolean
  onFastModeChanged: (fast: boolean) => void
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
    const selected = findFireworksModel(this.#models, model.id)
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

  async toggleFastServing() {
    if (this.options.isBusy() || !this.#fireworksApiKey || !this.#selectedModel) return "unavailable" as const
    this.options.setBusy(true)
    const previousFast = this.options.fastMode()
    try {
      const models = this.#models.length > 0 ? this.#models : await this.loadVerifiedModels(this.#fireworksApiKey)
      const selected = findFireworksModel(models, this.#selectedModel)
      if (!selected?.fastId) return "unavailable" as const

      const fast = !isFastFireworksModel(this.#selectedModel)
      this.options.onFastModeChanged(fast)
      await saveFastMode(fast)
      await this.persistModelSelection(selected)
      return fast ? ("on" as const) : ("off" as const)
    } catch (error) {
      this.options.onFastModeChanged(previousFast)
      this.options.ui.showSetupError(errorMessage(error))
      return "error" as const
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
    this.options.ui.showSetupInput()
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
      this.options.ui.showModelPicker(
        models.map((model) => ({ ...model, active: matchesFireworksModel(model, currentModel ?? "") })),
      )
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
    const serving = this.servingModel(selected)

    if (this.#persistFireworksApiKey) await saveFireworksSetup(fireworksApiKey, serving)
    else await saveSelectedModel(serving)
    this.#selectedModel = serving.id
    this.#selectedModelSupportsImageInput = serving.supportsImageInput
    this.options.onCredentialsChanged({ fireworksApiKey })
    this.options.onModelSelected(serving)
  }

  private finish(model?: FireworksModel) {
    const fireworksApiKey = this.#fireworksApiKey
    const selected =
      (model ? this.servingModel(model) : undefined) ??
      (this.#selectedModel ? findFireworksModel(this.#models, this.#selectedModel) : undefined) ??
      (this.#selectedModel ? modelFromId(this.#selectedModel, this.#selectedModelSupportsImageInput) : undefined)
    if (!fireworksApiKey || !selected) return

    this.options.onConfigured(fireworksApiKey, this.servingModel(selected))
    this.options.ui.setConfigured()
    this.options.ui.focusInput()
  }

  private servingModel(model: FireworksModel) {
    return fireworksServingModel(model, this.options.fastMode())
  }
}

function modelFromId(id: string, supportsImageInput = false): FireworksModel {
  return { id, displayName: id.split("/").at(-1) ?? id, supportsImageInput }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
