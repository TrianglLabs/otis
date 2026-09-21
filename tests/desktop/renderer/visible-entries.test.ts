import { describe, expect, it } from "vitest"
import type { TranscriptEntry } from "../../../src/app/transcript.js"
import { visibleEntries } from "../../../src/desktop/renderer/features/conversation/visible-entries.js"

function entry(id: number, kind: "message" | "reasoning"): TranscriptEntry {
  return { id, kind, speaker: "Otis", text: `e${id}` }
}

describe("visible entries", () => {
  it.each([true, false])("omits empty assistant rows with thinking visible=%s", (thinkingVisible) => {
    const streaming = { ...entry(1, "message"), text: "", streaming: true }
    const entries: TranscriptEntry[] = [streaming, { ...entry(2, "message"), text: " \n\t" }, entry(3, "message")]
    expect(visibleEntries(entries, thinkingVisible)).toEqual([entries[2]])
    // The same streaming entry becomes visible as soon as it receives content.
    const updated = { ...streaming, text: "Here is the answer." }
    expect(visibleEntries([updated], thinkingVisible)).toEqual([updated])
  })

  it("preserves artifact-only messages and empty live thinking", () => {
    const entries: TranscriptEntry[] = [
      { ...entry(1, "message"), text: "", artifacts: [{ source: "workspace", path: "resume.docx", kind: "docx" }] },
      { ...entry(2, "reasoning"), text: "", streaming: true },
    ]
    expect(visibleEntries(entries, false)).toEqual(entries)
  })

  it("drops reasoning entries when thinking traces are hidden, keeping order", () => {
    const entries = [entry(1, "message"), entry(2, "reasoning"), entry(3, "message"), entry(4, "reasoning")]
    expect(visibleEntries(entries, false).map((e) => e.id)).toEqual([1, 3])
  })

  it("returns the entries untouched when thinking traces are shown", () => {
    const entries = [entry(1, "message"), entry(2, "reasoning"), entry(3, "message")]
    expect(visibleEntries(entries, true)).toBe(entries)
  })

  it("keeps a live thinking trace visible when thinking is hidden, then folds it away when done", () => {
    const live: TranscriptEntry = { ...entry(2, "reasoning"), streaming: true }
    const done: TranscriptEntry = { ...entry(4, "reasoning"), streaming: false }
    const entries = [entry(1, "message"), live, entry(3, "message"), done]
    expect(visibleEntries(entries, false).map((e) => e.id)).toEqual([1, 2, 3])
  })
})
