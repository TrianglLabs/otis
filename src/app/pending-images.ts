import { createPastedImageAttachment } from "../inference/images.js"
import type { ImageContentPart } from "../inference/types.js"

export class PendingImages {
  #items: ImageContentPart[] = []
  #sequence = 1

  get items(): readonly ImageContentPart[] {
    return this.#items
  }

  get count() {
    return this.#items.length
  }

  nextPasted(bytes: Uint8Array, mimeType?: string) {
    const attachment = createPastedImageAttachment(bytes, this.#sequence, mimeType)
    this.#sequence += 1
    return attachment
  }

  replace(images: readonly ImageContentPart[]) {
    this.#items = [...images]
  }

  add(image: ImageContentPart) {
    this.#items = [...this.#items, image]
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
