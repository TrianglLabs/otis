import { createPastedImageAttachment } from "../inference/images.js"
import type { AttachmentContentPart } from "../inference/types.js"

export class PendingAttachments {
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
