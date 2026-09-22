import type { Application } from "../app/application.js"
import {
  loadAttachmentFiles,
  parsePastedAttachmentPaths,
  validateAttachments,
} from "../inference/attachments.js"
import { errorMessage } from "../inference/errors.js"
import { createPastedImageAttachment } from "../inference/images.js"
import type { AttachmentContentPart, UserChatMessage } from "../inference/types.js"
import type { ChatUI } from "./ui/types.js"

type AttachmentFlowOptions = {
  cwd: string
  isBusy: () => boolean
  app: Application
  ui: () => ChatUI
  onContextChange: () => void
}

/** The composer's pending attachments: pasted images and dropped files, checked as they arrive. */
export class AttachmentFlow {
  readonly pending = new PendingAttachments()
  #generation = 0
  #readingFiles = 0

  constructor(private readonly options: AttachmentFlowOptions) {}

  async attachPastedImage(bytes: Uint8Array, mimeType?: string) {
    if (this.options.isBusy()) return
    try {
      await this.options.app.ensureImageSupport()
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
   * The prompt to send, or a rejection for what a send would fail on: files still reading,
   * invalid attachments, or images the model cannot take.
   */
  async prompt(value: string): Promise<UserChatMessage> {
    if (this.#readingFiles > 0)
      throw new Error("Files are still being read. Please wait before sending.")
    return this.options.app.buildPrompt(value, this.pending.items)
  }

  showMessage(message: string) {
    const ui = this.options.ui()
    const { transcript } = this.options.app
    ui.showChatLayout()
    transcript.addAssistantMessage(message)
    ui.renderTranscript(transcript.entries, { scrollToBottom: true })
    ui.focusInput()
  }

  async #attachPaths(paths: readonly string[]) {
    if (this.options.isBusy()) return
    const generation = this.#generation
    this.#readingFiles += 1
    try {
      const attachments = await loadAttachmentFiles(paths, this.options.cwd)
      if (generation !== this.#generation) return
      if (attachments.some((attachment) => attachment.type === "image"))
        await this.options.app.ensureImageSupport()
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
