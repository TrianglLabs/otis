import { describe, expect, it, vi } from "vitest"
import { TranscriptStore } from "../../src/app/transcript.js"
import { AttachmentFlow } from "../../src/cli/attachment-flow.js"
import type { ChatUI } from "../../src/cli/ui/types.js"
import { loadAttachmentFiles } from "../../src/inference/attachments.js"
import { createDocumentAttachment } from "../../src/inference/documents.js"

vi.mock("../../src/inference/attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/inference/attachments.js")>()),
  loadAttachmentFiles: vi.fn(),
}))

function setup() {
  const ui = {
    setAttachmentCounts: vi.fn(),
    focusInput: vi.fn(),
    showChatLayout: vi.fn(),
    renderTranscript: vi.fn(),
  }
  const flow = new AttachmentFlow({
    cwd: process.cwd(),
    isBusy: () => false,
    apiKey: () => undefined,
    selectedModelId: () => "text-only",
    ui: () => ui as unknown as ChatUI,
    transcript: new TranscriptStore(),
    onContextChange: vi.fn(),
  })
  return { flow, ui }
}

describe("pending attachments", () => {
  it("names pasted images with an incrementing sequence and counts them", async () => {
    const { flow, ui } = setup()
    flow.setModelCapability(true)

    await flow.attachPastedImage(pngBytes())
    await flow.attachPastedImage(pngBytes())

    expect(flow.pending.items.map((item) => item.name)).toEqual([
      "pasted-image-1.png",
      "pasted-image-2.png",
    ])
    expect(ui.setAttachmentCounts).toHaveBeenLastCalledWith(2, 0)
  })

  it("removes the last attachment, clears the rest, and keeps prior snapshots", async () => {
    const { flow, ui } = setup()
    flow.setModelCapability(true)
    await flow.attachPastedImage(pngBytes())
    const snapshot = flow.pending.items
    await flow.attachPastedImage(pngBytes())

    expect(snapshot).toHaveLength(1)
    expect(flow.pending.count).toBe(2)
    expect(flow.removeLast()).toBe(true)
    expect(flow.pending.count).toBe(1)
    expect(ui.setAttachmentCounts).toHaveBeenLastCalledWith(1, 0)
    flow.clear()
    expect(flow.pending.count).toBe(0)
    expect(ui.setAttachmentCounts).toHaveBeenLastCalledWith(0, 0)

    // Nothing left: neither call touches the composer again.
    const calls = ui.setAttachmentCounts.mock.calls.length
    flow.clear()
    expect(flow.removeLast()).toBe(false)
    expect(ui.setAttachmentCounts.mock.calls).toHaveLength(calls)
  })
})

describe("attachment preparation", () => {
  it("waits for extraction before allowing the message to be sent", async () => {
    const { flow, ui } = setup()
    const document = await createDocumentAttachment(new TextEncoder().encode("notes"), "notes.txt")
    let finish!: (documents: [typeof document]) => void
    vi.mocked(loadAttachmentFiles).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )

    expect(flow.handlePathPaste("notes.txt")).toBe(true)
    await expect(flow.ensureReadyToSend("summarize")).rejects.toThrow("still being read")
    finish([document])
    await vi.waitFor(() => expect(ui.setAttachmentCounts).toHaveBeenCalledWith(0, 1))
    expect(flow.ensureReadyToSend("summarize")).toBeUndefined()
  })

  it("discards a late file read after the composer is cleared for a new session", async () => {
    const { flow, ui } = setup()
    const document = await createDocumentAttachment(new TextEncoder().encode("notes"), "notes.txt")
    let finish!: (documents: [typeof document]) => void
    const read = new Promise<[typeof document]>((resolve) => {
      finish = resolve
    })
    vi.mocked(loadAttachmentFiles).mockReturnValueOnce(read)

    flow.handlePathPaste("notes.txt")
    flow.clear()
    expect(flow.ensureReadyToSend("new conversation")).toBeUndefined()
    finish([document])
    await read
    expect(flow.pending.count).toBe(0)
    expect(ui.setAttachmentCounts).not.toHaveBeenCalledWith(0, 1)
  })
})

function pngBytes() {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}
