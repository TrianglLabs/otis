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
