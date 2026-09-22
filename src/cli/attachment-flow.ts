import type { TranscriptStore } from "../app/transcript.js"
import {
  loadAttachmentFiles,
  parsePastedAttachmentPaths,
  validateAttachments,
} from "../inference/attachments.js"
import { listToolCapableModels } from "../inference/client.js"
import { createPastedImageAttachment, validateImageAttachments } from "../inference/images.js"
import { findLocalModel } from "../inference/local-catalog.js"
import {
  createUserMessage,
  imageAttachmentsFromMessages,
  messagesContainImages,
} from "../inference/messages.js"
import {
  findFireworksModel,
  fireworksServingModel,
  isFastFireworksModel,
} from "../inference/serving-path.js"
import type { AttachmentContentPart, ChatMessage } from "../inference/types.js"
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
      const attachment = this.pending.nextPastedImage(bytes, mimeType)
      validateAttachments([...this.pending.items, attachment])
      this.pending.add(attachment)
      this.#syncUi()
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

  /**
   * Drops pending attachments and any file reads still in flight, e.g. when the composer starts a
   * new session.
   */
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

  /**
   * Fails when a send would: files still reading, invalid attachments, or images the model cannot
   * take. Returns nothing when the send can proceed synchronously, so a plain text turn starts
   * without a microtask.
   */
  ensureReadyToSend(value: string): Promise<void> | undefined {
    if (this.#readingFiles > 0) {
      return Promise.reject(new Error("Files are still being read. Please wait before sending."))
    }
    validateAttachments(this.pending.items)
    const messages = [
      ...this.options.transcript.history,
      createUserMessage(value, this.pending.items),
    ]
    if (!messagesContainImages(messages)) return
    return this.#ensureImagesReadyToSend(messages)
  }

  async #ensureImagesReadyToSend(messages: ChatMessage[]) {
    validateImageAttachments(imageAttachmentsFromMessages(messages))
    await this.#ensureModelSupportsImages()
  }

  showMessage(message: string) {
    this.options.ui().showChatLayout()
    this.options.transcript.addAssistantMessage(message)
    this.options.ui().renderTranscript(this.options.transcript.entries, { scrollToBottom: true })
    this.options.ui().focusInput()
  }

  async #ensureModelSupportsImages() {
    if (this.#supportsImageInput === true) return
    const modelId = this.options.selectedModelId()
    if (!modelId) throw new Error("Select a model first.")
    const unsupported = new Error(`Selected model does not support image input: ${modelId}`)
    const local = findLocalModel(modelId)
    if (local) {
      this.#supportsImageInput = local.supportsImageInput
      if (!local.supportsImageInput) throw unsupported
      return
    }
    const apiKey = this.options.apiKey()
    if (!apiKey) throw new Error("Select a hosted model first.")
    if (this.#supportsImageInput === false) throw unsupported
    if (this.#capabilityCheck?.modelId === modelId) return this.#capabilityCheck.promise

    const promise = (async () => {
      const selected = findFireworksModel(await listToolCapableModels(apiKey), modelId)
      if (!selected) throw new Error(`Selected model is no longer available: ${modelId}`)
      if (this.options.selectedModelId() !== modelId) {
        throw new Error("The selected model changed while checking image support.")
      }
      this.#supportsImageInput = selected.supportsImageInput
      await saveSelectedModel(fireworksServingModel(selected, isFastFireworksModel(modelId)))
      if (!selected.supportsImageInput) throw unsupported
    })().finally(() => {
      if (this.#capabilityCheck?.promise === promise) this.#capabilityCheck = undefined
    })
    this.#capabilityCheck = { modelId, promise }
    return promise
  }

  async #attachPaths(paths: readonly string[]) {
    if (this.options.isBusy()) return
    const generation = this.#generation
    this.#readingFiles += 1
    try {
      const attachments = await loadAttachmentFiles(paths, this.options.cwd)
      if (generation !== this.#generation) return
      if (attachments.some((attachment) => attachment.type === "image"))
        await this.#ensureModelSupportsImages()
      if (generation !== this.#generation) return
      const combined = [...this.pending.items, ...attachments]
      validateAttachments(combined)
      this.pending.replace(combined)
      this.#syncUi()
    } catch (error) {
      if (generation === this.#generation)
        this.showMessage(`Could not attach dropped files: ${errorMessage(error)}`)
    } finally {
      if (generation === this.#generation) this.#readingFiles -= 1
    }
  }

  #syncUi() {
    const images = this.pending.items.filter((attachment) => attachment.type === "image").length
    this.options.ui().setAttachmentCounts(images, this.pending.count - images)
    this.options.onContextChange()
    this.options.ui().focusInput()
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

class PendingAttachments {
  #items: AttachmentContentPart[] = []
  #pastedImageSequence = 1

  get items(): readonly AttachmentContentPart[] {
    return this.#items
  }

  get count() {
    return this.#items.length
  }

  nextPastedImage(bytes: Uint8Array, mimeType?: string) {
    const attachment = createPastedImageAttachment(bytes, this.#pastedImageSequence, mimeType)
    this.#pastedImageSequence += 1
    return attachment
  }

  replace(attachments: readonly AttachmentContentPart[]) {
    this.#items = [...attachments]
  }

  add(attachment: AttachmentContentPart) {
    this.#items = [...this.#items, attachment]
  }

  removeLast() {
    if (this.#items.length === 0) return false
    this.#items = this.#items.slice(0, -1)
    return true
  }

  clear() {
    if (this.#items.length === 0) return false
    this.#items = []
    return true
  }
}
