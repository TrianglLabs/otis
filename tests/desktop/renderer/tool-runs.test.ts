import { describe, expect, it } from "vitest"
import type { TranscriptEntry } from "../../../src/app/transcript.js"
import { flattenExpandedRuns, groupToolRuns } from "../../../src/desktop/renderer/features/conversation/tool-runs.js"

let nextId = 1
const entry = (partial: Partial<TranscriptEntry> & Pick<TranscriptEntry, "kind">): TranscriptEntry => ({
  id: nextId++,
  speaker: "Tool",
  text: `entry ${nextId}`,
  ...partial,
})
const tool = (partial: Partial<TranscriptEntry> = {}) => entry({ kind: "tool", ...partial })
const message = () => entry({ kind: "message", speaker: "Otis" })

describe("groupToolRuns", () => {
  it("collapses consecutive tool entries into one run", () => {
    const [a, b, c] = [tool(), tool(), tool()]
    const items = groupToolRuns([a, b, c])
    expect(items).toEqual([{ kind: "toolRun", id: a.id, entries: [a, b, c] }])
  })

  it("keeps a single tool entry standalone", () => {
    const items = groupToolRuns([tool()])
    expect(items[0]?.kind).toBe("tool")
  })

  it("a tool entry with a diff stays standalone and breaks the run", () => {
    const [a, b] = [tool(), tool()]
    const edit = tool({ diff: "@@ -1 +1 @@\n-old\n+new" })
    const [c, d] = [tool(), tool()]
    const items = groupToolRuns([a, b, edit, c, d])
    expect(items).toEqual([
      { kind: "toolRun", id: a.id, entries: [a, b] },
      edit,
      { kind: "toolRun", id: c.id, entries: [c, d] },
    ])
  })

  it("messages and reasoning break runs", () => {
    const [a, b] = [tool(), tool()]
    const text = message()
    const items = groupToolRuns([a, text, b])
    expect(items).toEqual([a, text, b])
  })

  it("keeps run identity stable as new activity appends", () => {
    const [a, b] = [tool(), tool()]
    const before = groupToolRuns([a, b])
    const after = groupToolRuns([a, b, tool()])
    const runBefore = before[0]
    const runAfter = after[0]
    expect(runBefore?.kind).toBe("toolRun")
    expect(runAfter?.kind).toBe("toolRun")
    expect(runAfter?.id).toBe(runBefore?.id)
  })

  it("returns no runs for a transcript without tools", () => {
    const items = groupToolRuns([message(), message()])
    expect(items.every((item) => item.kind === "message")).toBe(true)
  })
})

describe("flattenExpandedRuns", () => {
  it("splices an expanded run's entries after its row and marks them", () => {
    const [a, b] = [tool(), tool()]
    const { items, expandedEntries } = flattenExpandedRuns(groupToolRuns([a, b]), new Set([a.id]))
    expect(items).toEqual([{ kind: "toolRun", id: a.id, entries: [a, b] }, a, b])
    expect([...expandedEntries]).toEqual([a.id, b.id])
  })

  it("keeps collapsed runs condensed", () => {
    const [a, b] = [tool(), tool()]
    const { items, expandedEntries } = flattenExpandedRuns(groupToolRuns([a, b]), new Set<number>())
    expect(items).toEqual([{ kind: "toolRun", id: a.id, entries: [a, b] }])
    expect(expandedEntries.size).toBe(0)
  })

  it("flattens only the expanded run when several exist", () => {
    const [a, b, c, d] = [tool(), tool(), tool(), tool()]
    const divider = message()
    const grouped = groupToolRuns([a, b, divider, c, d])
    const { items, expandedEntries } = flattenExpandedRuns(grouped, new Set([c.id]))
    expect(items).toEqual([
      { kind: "toolRun", id: a.id, entries: [a, b] },
      divider,
      { kind: "toolRun", id: c.id, entries: [c, d] },
      c,
      d,
    ])
    expect([...expandedEntries]).toEqual([c.id, d.id])
  })
})
