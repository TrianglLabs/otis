import { listToolCapableModels } from "../inference/client.js"
import { selectDefaultFireworksModel } from "../inference/model-policy.js"
import type { FireworksModel } from "../inference/types.js"
import { type LocalSettings, saveFireworksSetup, saveParallelApiKey, saveSelectedModel } from "../local/settings.js"
import type { ChatUI } from "./chat-ui.js"
import { openProviderKeyPage } from "./provider-links.js"
import type { SetupCredential } from "./ui/types.js"

type SetupFlowOptions = {
  ui: ChatUI
  settings: LocalSettings
  isBusy: () => boolean
  setBusy: (busy: boolean) => void
  onCredentialsChanged: (credentials: { fireworksApiKey?: string; parallelApiKey?: string }) => void
  onModelSelected: (model: FireworksModel) => void
  onConfigured: (fireworksApiKey: string, parallelApiKey: string, model: FireworksModel) => void
}

export class SetupFlow {
  #fireworksApiKey: string | undefined
  #parallelApiKey: string | undefined
  #selectedModel: string | undefined
  #selectedModelSupportsImageInput: boolean | undefined
  #models: FireworksModel[] = []
  #persistFireworksApiKey = false
  #wasConfigured = false
  readonly #openedKeyPages = new Set<SetupCredential>()

  constructor(private readonly options: SetupFlowOptions) {
    this.#fireworksApiKey = options.settings.fireworksApiKey
    this.#parallelApiKey = options.settings.parallelApiKey
    this.#selectedModel = options.settings.model
    this.#selectedModelSupportsImageInput = options.settings.modelSupportsImageInput
  }

  begin() {
    if (this.options.isBusy()) return
    if (!this.#fireworksApiKey) {
      this.requestCredential("fireworks")
      return
    }
    if (!this.#selectedModel) {
      void this.selectDefaultModel(this.#fireworksApiKey)
      return
    }
    if (!this.#parallelApiKey) {
      this.requestCredential("parallel")
      return
    }
    this.finish()
  }

  async submitCredential(credential: SetupCredential, value: string) {
    const apiKey = value.trim()
    if (!apiKey) {
      this.options.ui.showSetupError(`${providerName(credential)} API key is required.`)
      return
    }

    if (credential === "fireworks") {
      this.#fireworksApiKey = apiKey
      this.#persistFireworksApiKey = true
      await this.selectDefaultModel(apiKey)
      return
    }

    this.options.setBusy(true)
    try {
      await saveParallelApiKey(apiKey)
      this.#parallelApiKey = apiKey
      this.options.onCredentialsChanged({
        fireworksApiKey: this.#fireworksApiKey,
        parallelApiKey: this.#parallelApiKey,
      })
      if (!this.#selectedModel) throw new Error("Choose a Fireworks model before adding the Parallel key.")
      this.finish()
    } catch (error) {
      this.options.ui.showSetupError(errorMessage(error))
    } finally {
      this.options.setBusy(false)
    }
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
      this.continueSetup(selected)
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

  private requestCredential(credential: SetupCredential) {
    this.options.ui.showSetupInput(credential, credentialPrompt(credential))
    if (this.#openedKeyPages.has(credential)) return
    this.#openedKeyPages.add(credential)
    void openProviderKeyPage(credential)
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
      this.continueSetup(selected)
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
    this.options.onCredentialsChanged({
      fireworksApiKey,
      parallelApiKey: this.#parallelApiKey,
    })
    this.options.onModelSelected(selected)
  }

  private continueSetup(selected: FireworksModel) {
    if (!this.#parallelApiKey) {
      this.options.ui.showHomeLayout()
      this.requestCredential("parallel")
      return
    }
    this.finish(selected)
  }

  private finish(model?: FireworksModel) {
    const fireworksApiKey = this.#fireworksApiKey
    const parallelApiKey = this.#parallelApiKey
    const selected =
      model ??
      this.#models.find((candidate) => candidate.id === this.#selectedModel) ??
      (this.#selectedModel ? modelFromId(this.#selectedModel, this.#selectedModelSupportsImageInput) : undefined)
    if (!fireworksApiKey || !parallelApiKey || !selected) return

    this.options.onConfigured(fireworksApiKey, parallelApiKey, selected)
    this.options.ui.setConfigured()
    this.options.ui.focusInput()
  }
}

function providerName(credential: SetupCredential) {
  return credential === "fireworks" ? "Fireworks" : "Parallel"
}

function credentialPrompt(credential: SetupCredential) {
  if (credential === "fireworks") {
    return "Inference + tool calling · Get key: app.fireworks.ai/api-keys"
  }
  return "Web search + page reading · Get key: platform.parallel.ai"
}

function modelFromId(id: string, supportsImageInput = false): FireworksModel {
  return { id, displayName: id.split("/").at(-1) ?? id, supportsImageInput }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
