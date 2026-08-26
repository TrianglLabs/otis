import { listToolCapableModels } from "../inference/client.js"
import { loadImageFiles, parsePastedImagePaths, validateImageAttachments } from "../inference/images.js"
import { findLocalModel } from "../inference/local-catalog.js"
import { createUserMessage, imageAttachmentsFromMessages, messagesContainImages } from "../inference/messages.js"
import { findFireworksModel, fireworksServingModel, isFastFireworksModel } from "../inference/serving-path.js"
import type { ImageContentPart } from "../inference/types.js"
import { saveSelectedModel } from "../local/settings.js"
import { PendingImages } from "./pending-images.js"
import type { TranscriptStore } from "./transcript.js"
import type { ChatUI } from "./ui/types.js"

type ImageFlowOptions = {
  cwd: string
  isBusy: () => boolean
  apiKey: () => string | undefined
  selectedModelId: () => string | undefined
  ui: () => ChatUI
  transcript: TranscriptStore
  onContextChange: () => void
}

export class ImageFlow {
  readonly pending = new PendingImages()
  #supportsImageInput: boolean | undefined
  #capabilityCheck: { modelId: string; promise: Promise<void> } | undefined

  constructor(private readonly options: ImageFlowOptions) {}

  setModelCapability(supports: boolean | undefined) {
    this.#supportsImageInput = supports
    this.#capabilityCheck = undefined
  }

  async attachPasted(bytes: Uint8Array, mimeType?: string) {
    if (this.options.isBusy()) return
    try {
      await this.#ensureModelSupportsImages()
      this.#add(this.pending.nextPasted(bytes, mimeType))
    } catch (error) {
      this.showMessage(`Could not attach pasted image: ${errorMessage(error)}`)
    }
  }

  handlePathPaste(value: string) {
    const paths = parsePastedImagePaths(value)
    if (!paths) return false
    void this.#attachPaths(paths)
    return true
  }

  clear() {
    if (!this.pending.clear()) return
    this.options.ui().setImageAttachmentCount(0)
  }

  removeLast() {
    if (this.options.isBusy() || !this.pending.removeLast()) return false
    this.options.ui().setImageAttachmentCount(this.pending.count)
    this.options.onContextChange()
    return true
  }

  ensureReadyToSend(value: string): Promise<void> | undefined {
    if (this.pending.count === 0 && !messagesContainImages(this.options.transcript.history)) return
    return this.#ensureReadyToSend(value)
  }

  async #ensureReadyToSend(value: string) {
    validateImageAttachments(
      imageAttachmentsFromMessages([...this.options.transcript.history, createUserMessage(value, this.pending.items)]),
    )
    await this.#ensureModelSupportsImages()
  }

  async #ensureModelSupportsImages() {
    if (this.#supportsImageInput === true) return
    const modelId = this.options.selectedModelId()
    if (!modelId) throw new Error("Select a model first.")
    const local = findLocalModel(modelId)
    if (local) {
      this.#supportsImageInput = local.supportsImageInput
      if (!local.supportsImageInput) throw new Error(`Selected model does not support image input: ${modelId}`)
      return
    }
    const apiKey = this.options.apiKey()
    if (!apiKey) throw new Error("Select a hosted model first.")
    if (this.#supportsImageInput === false) {
      throw new Error(`Selected model does not support image input: ${modelId}`)
    }

    if (this.#capabilityCheck?.modelId === modelId) return this.#capabilityCheck.promise

    const promise = this.#resolveCapability(apiKey, modelId).finally(() => {
      if (this.#capabilityCheck?.promise === promise) this.#capabilityCheck = undefined
    })
    this.#capabilityCheck = { modelId, promise }
    return promise
  }

  showMessage(message: string) {
    this.options.ui().showChatLayout()
    this.options.transcript.addAssistantMessage(message)
    this.options.ui().renderTranscript(this.options.transcript.entries, { scrollToBottom: true })
    this.options.ui().focusInput()
  }

  async #attachPaths(paths: readonly string[]) {
    if (this.options.isBusy()) return
    try {
      await this.#ensureModelSupportsImages()
      const images = await loadImageFiles(paths, this.options.cwd)
      const combined = [...this.pending.items, ...images]
      validateImageAttachments(combined)
      this.pending.replace(combined)
      this.#syncUi()
    } catch (error) {
      this.showMessage(`Could not attach dropped image: ${errorMessage(error)}`)
    }
  }

  #add(image: ImageContentPart) {
    validateImageAttachments([...this.pending.items, image])
    this.pending.add(image)
    this.#syncUi()
  }

  #syncUi() {
    this.options.ui().setImageAttachmentCount(this.pending.count)
    this.options.onContextChange()
    this.options.ui().focusInput()
  }

  async #resolveCapability(apiKey: string, modelId: string) {
    const models = await listToolCapableModels(apiKey)
    const selected = findFireworksModel(models, modelId)
    if (!selected) throw new Error(`Selected model is no longer available: ${modelId}`)
    if (this.options.selectedModelId() !== modelId) {
      throw new Error("The selected model changed while checking image support.")
    }
    this.#supportsImageInput = selected.supportsImageInput
    await saveSelectedModel(fireworksServingModel(selected, isFastFireworksModel(modelId)))
    if (!selected.supportsImageInput) throw new Error(`Selected model does not support image input: ${modelId}`)
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
