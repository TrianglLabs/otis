// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/react"
import { type ComponentProps, useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import type { TranscriptEntry } from "../../../src/app/transcript.js"
import { EntryView } from "../../../src/desktop/renderer/features/conversation/entries.js"

/** Traces on: live thinking streams openly, finished thinking hides behind its summary row. Traces off: only the Thinking… status line shows while live; content never renders. */

function reasoningEntry(overrides: Partial<TranscriptEntry>): TranscriptEntry {
  return { id: 1, kind: "reasoning", speaker: "Thinking", text: "", ...overrides }
}

function TestEntry(props: Pick<ComponentProps<typeof EntryView>, "entry" | "active" | "thinkingVisible">) {
  const [expanded, setExpanded] = useState(false)
  return <EntryView {...props} expanded={expanded} onExpandedChange={(_id, open) => setExpanded(open)} />
}

afterEach(() => cleanup())

describe("ReasoningCard", () => {
  it.each([true, false])("keeps the live status stable while streaming with traces visible=%s", (thinkingVisible) => {
    const { getByRole, container, rerender } = render(
      <TestEntry
        entry={reasoningEntry({ streaming: true, text: "Considering the first option" })}
        active={false}
        thinkingVisible={thinkingVisible}
      />,
    )
    const status = getByRole("status")
    const cube = status.querySelector("svg")
    const label = status.querySelector(".thinking-label")
    expect(status.textContent).toBe("Thinking…")
    expect(cube?.getAttribute("aria-hidden")).toBe("true")

    rerender(
      <TestEntry
        entry={reasoningEntry({ streaming: true, text: "Considering the first option and a second one" })}
        active={false}
        thinkingVisible={thinkingVisible}
      />,
    )
    expect(getByRole("status")).toBe(status)
    expect(status.querySelector("svg")).toBe(cube)
    expect(status.querySelector(".thinking-label")).toBe(label)
    if (!thinkingVisible) expect(container.textContent).not.toContain("Considering")
  })

  it("replaces the live effect with a static summary when thinking finishes", () => {
    const { container, queryByRole, getByRole, rerender } = render(
      <TestEntry entry={reasoningEntry({ streaming: true })} active={true} thinkingVisible={true} />,
    )
    expect(getByRole("status")).toBeTruthy()
    rerender(
      <TestEntry
        entry={reasoningEntry({ streaming: false, durationMs: 2300, text: "Finished reasoning" })}
        active={false}
        thinkingVisible={true}
      />,
    )
    expect(queryByRole("status")).toBeNull()
    expect(container.querySelector(".thinking-label")).toBeNull()
    expect(getByRole("button", { name: "Thought for 2.3s" }).querySelector(".reasoning-cube")).toBeTruthy()
    expect(container.querySelector(".reasoning-body")).toBeNull()
  })

  it("streams a preview of the freshest lines while thinking", () => {
    const { container } = render(
      <TestEntry
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
      <TestEntry
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
      <TestEntry
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
