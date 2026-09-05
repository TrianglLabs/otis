import { describe, expect, it } from "vitest"
import { PendingImages } from "../../src/app/pending-images.js"

describe("pending images", () => {
  it("names pasted attachments with an incrementing sequence", () => {
    const pending = new PendingImages()
    const first = pending.nextPasted(pngBytes())
    const second = pending.nextPasted(pngBytes())

    expect(first.name).toBe("pasted-image-1.png")
    expect(second.name).toBe("pasted-image-2.png")
    expect(pending.count).toBe(0)
  })

  it("tracks add, remove, and clear without mutating prior snapshots", () => {
    const pending = new PendingImages()
    const first = pending.nextPasted(pngBytes())
    pending.add(first)
    const snapshot = pending.items
    pending.add(pending.nextPasted(pngBytes()))

    expect(snapshot).toHaveLength(1)
    expect(pending.count).toBe(2)
    expect(pending.removeLast()).toBe(true)
    expect(pending.count).toBe(1)
    expect(pending.clear()).toBe(true)
    expect(pending.count).toBe(0)
    expect(pending.clear()).toBe(false)
    expect(pending.removeLast()).toBe(false)
  })
})

function pngBytes() {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}
