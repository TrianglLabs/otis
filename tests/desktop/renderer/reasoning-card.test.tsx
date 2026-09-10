// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { TranscriptEntry } from "../../../src/app/transcript.js"
import { EntryView } from "../../../src/desktop/renderer/features/conversation/entries.js"

/** Traces on: live thinking streams openly, finished thinking hides behind its summary row. Traces off: only the Thinking… status line shows while live; content never renders. */

function reasoningEntry(overrides: Partial<TranscriptEntry>): TranscriptEntry {
  return { id: 1, kind: "reasoning", speaker: "Thinking", text: "", ...overrides }
}

afterEach(() => cleanup())

describe("ReasoningCard", () => {
  it("streams a preview of the freshest lines while thinking", () => {
    const { container } = render(
      <EntryView
        entry={reasoningEntry({
          streaming: true,
          text: "first thought\nsecond thought\nthird thought\nfourth thought",
        })}
        active={false}
        thinkingVisible={true}
      />,
    )
    const preview = container.querySelector(".reasoning-preview")
    expect(preview?.textContent).toBe("second thought\nthird thought\nfourth thought")
  })

  it("keeps finished thinking collapsed until the row is clicked", () => {
    const { container } = render(
      <EntryView
        entry={reasoningEntry({ streaming: false, durationMs: 2300, text: "some reasoning" })}
        active={false}
        thinkingVisible={true}
      />,
    )
    expect(container.querySelector(".reasoning-preview")).toBeNull()
    expect(container.querySelector(".reasoning-body")).toBeNull()

    fireEvent.click(container.querySelector(".reasoning-header") as HTMLElement)
    expect(container.querySelector(".reasoning-body")?.textContent).toBe("some reasoning")
  })
  it("shows only the Thinking… status when traces are off, never the content", () => {
    const { container } = render(
      <EntryView
        entry={reasoningEntry({ streaming: true, text: "weighing the options" })}
        active={false}
        thinkingVisible={false}
      />,
    )
    expect(container.querySelector(".reasoning-text")?.textContent).toBe("Thinking…")
    expect(container.textContent).not.toContain("weighing the options")
    expect(container.querySelector(".reasoning-header")).toBeNull()
    expect(container.querySelector(".reasoning-preview")).toBeNull()
  })
})
