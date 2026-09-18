import { PendingAttachments } from "../app/pending-attachments.js"
import type { TranscriptStore } from "../app/transcript.js"
import { loadAttachmentFiles, parsePastedAttachmentPaths, validateAttachments } from "../inference/attachments.js"
import { listToolCapableModels } from "../inference/client.js"
import { validateImageAttachments } from "../inference/images.js"
import { findLocalModel } from "../inference/local-catalog.js"
import { createUserMessage, imageAttachmentsFromMessages, messagesContainImages } from "../inference/messages.js"
import { findFireworksModel, fireworksServingModel, isFastFireworksModel } from "../inference/serving-path.js"
import type { AttachmentContentPart, ImageContentPart } from "../inference/types.js"
import { saveSelectedModel } from "../local/settings.js"
import type { ChatUI } from "./ui/types.js"

type AttachmentFlowOptions = {
  cwd: string
  isBusy: () => boolean
  apiKey: () => string | undefined
  selectedModelId: () => string | undefined
  ui: () => ChatUI
  transcript: TranscriptStore
  onContextChange: () => void
}

export class AttachmentFlow {
  readonly pending = new PendingAttachments()
  #supportsImageInput: boolean | undefined
  #capabilityCheck: { modelId: string; promise: Promise<void> } | undefined
  #generation = 0
  #readingFiles = 0

  constructor(private readonly options: AttachmentFlowOptions) {}

  setModelCapability(supports: boolean | undefined) {
    this.#supportsImageInput = supports
    this.#capabilityCheck = undefined
  }

  async attachPastedImage(bytes: Uint8Array, mimeType?: string) {
    if (this.options.isBusy()) return
    try {
      await this.#ensureModelSupportsImages()
      this.#add(this.pending.nextPastedImage(bytes, mimeType))
    } catch (error) {
      this.showMessage(`Could not attach pasted image: ${errorMessage(error)}`)
    }
  }

  handlePathPaste(value: string) {
    const paths = parsePastedAttachmentPaths(value)
    if (!paths) return false
    void this.#attachPaths(paths)
    return true
  }

  clear() {
    this.#generation += 1
    this.#readingFiles = 0
    if (!this.pending.clear()) return
    this.options.ui().setAttachmentCounts(0, 0)
  }

  removeLast() {
    if (this.options.isBusy() || !this.pending.removeLast()) return false
    this.#syncUi()
    return true
  }

  ensureReadyToSend(value: string): Promise<void> | undefined {
    if (this.#readingFiles > 0)
      return Promise.reject(new Error("Files are still being read. Please wait before sending."))
    validateAttachments(this.pending.items)
    if (!this.#requestContainsImages(value)) return
    return this.#ensureImagesReadyToSend(value)
  }

  async #ensureImagesReadyToSend(value: string) {
    validateImageAttachments(
      imageAttachmentsFromMessages([...this.options.transcript.history, createUserMessage(value, this.pending.items)]),
    )
    await this.#ensureModelSupportsImages()
  }

  #requestContainsImages(value: string) {
    return messagesContainImages([...this.options.transcript.history, createUserMessage(value, this.pending.items)])
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
    const generation = this.#generation
    this.#readingFiles += 1
    try {
      const attachments = await loadAttachmentFiles(paths, this.options.cwd)
      if (generation !== this.#generation) return
      if (attachments.some((attachment) => attachment.type === "image")) await this.#ensureModelSupportsImages()
      if (generation !== this.#generation) return
      const combined = [...this.pending.items, ...attachments]
      validateAttachments(combined)
      this.pending.replace(combined)
      this.#syncUi()
    } catch (error) {
      if (generation === this.#generation) this.showMessage(`Could not attach dropped files: ${errorMessage(error)}`)
    } finally {
      if (generation === this.#generation) this.#readingFiles -= 1
    }
  }

  #add(attachment: AttachmentContentPart) {
    validateAttachments([...this.pending.items, attachment])
    this.pending.add(attachment)
    this.#syncUi()
  }

  #syncUi() {
    const images = this.pending.items.filter(
      (attachment): attachment is ImageContentPart => attachment.type === "image",
    )
    this.options.ui().setAttachmentCounts(images.length, this.pending.count - images.length)
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
