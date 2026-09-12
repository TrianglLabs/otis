// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopEvent } from "../../../src/desktop/contracts.js"
import { Markdown } from "../../../src/desktop/renderer/components/Markdown.js"
import { createDemoRuntime } from "../../../src/desktop/renderer/demo/demo-runtime.js"
import { AgentTraceOverlay } from "../../../src/desktop/renderer/features/agents/AgentTraceOverlay.js"
import * as diff from "../../../src/desktop/renderer/features/conversation/diff.js"
import { EntryView } from "../../../src/desktop/renderer/features/conversation/entries.js"
import { ToolCard } from "../../../src/desktop/renderer/features/conversation/ToolCard.js"
import { DesktopProvider, useDesktopState } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"

afterEach(() => cleanup())

const markdown =
  "| Column | Value |\n| --- | --- |\n| test | wide table |\n\n```ts\nconst answer = 42\n```\n\nStreaming"

describe("stable message rendering", () => {
  it("preserves code/table elements, selection, horizontal scroll, and copy state while text grows", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
    const view = render(<Markdown text={markdown} />)
    const table = view.container.querySelector(".md-tableWrap") as HTMLElement
    const code = view.container.querySelector(".codeBlock") as HTMLElement
    table.scrollLeft = 70
    const textNode = code.querySelector("code")?.firstChild
    if (!textNode) throw new Error("Code text is missing")
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 5)
    const selection = window.getSelection()
    if (!selection) throw new Error("Selection is unavailable")
    selection.removeAllRanges()
    selection.addRange(range)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy code" })))
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy()

    view.rerender(<Markdown text={`${markdown} answer continues`} />)
    expect(view.container.querySelector(".md-tableWrap")).toBe(table)
    expect(view.container.querySelector(".codeBlock")).toBe(code)
    expect(table.scrollLeft).toBe(70)
    expect(selection.toString()).toBe("const")
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("const answer = 42")
  })

  it("does not reparse a completed diff when the tool's activity status changes", () => {
    const parse = vi.spyOn(diff, "parseDiffDisplay")
    const entry = {
      id: 1,
      kind: "tool" as const,
      speaker: "Tool" as const,
      text: "Edit",
      diff: "@@ -1 +1 @@\n-old\n+new",
    }
    const view = render(<ToolCard entry={entry} active={true} />)
    const line = view.container.querySelector(".diffLine")
    expect(parse).toHaveBeenCalledTimes(1)
    view.rerender(<ToolCard entry={{ ...entry, text: "Edited file" }} active={false} />)
    expect(parse).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector(".diffLine")).toBe(line)
    view.rerender(<ToolCard entry={{ ...entry, diff: "@@ -1 +1 @@\n-old\n+changed" }} active={false} />)
    expect(parse).toHaveBeenCalledTimes(2)
    expect(view.container.textContent).toContain("changed")
  })
})

describe("user delivery markers", () => {
  it("marks a queued prompt with a list-end icon instead of a text badge", () => {
    const entry = {
      id: 1,
      kind: "message" as const,
      speaker: "You" as const,
      text: "Follow up",
      delivery: "queued" as const,
    }
    const view = render(
      <EntryView entry={entry} active={false} thinkingVisible={false} expanded={false} onExpandedChange={() => {}} />,
    )
    expect(view.container.querySelector(".userRow-queued")).toBeTruthy()
    expect(screen.getByRole("img", { name: "Queued" })).toBeTruthy()
    expect(view.container.querySelector(".deliveryTag")).toBeNull()
    const row = view.container.querySelector(".userRow") as HTMLElement
    expect(row.firstElementChild?.className).toContain("queuedIndicator")
    expect(row.querySelector(".userMessage")?.textContent).toBe("Follow up")
  })

  it("keeps the steering wheel in front of the message", () => {
    const entry = {
      id: 2,
      kind: "message" as const,
      speaker: "You" as const,
      text: "Steer this",
      delivery: "steering" as const,
    }
    const view = render(
      <EntryView entry={entry} active={false} thinkingVisible={false} expanded={false} onExpandedChange={() => {}} />,
    )
    expect(view.container.querySelector(".userRow-steering")).toBeTruthy()
    expect(screen.getByRole("img", { name: "Steering" })).toBeTruthy()
    const row = view.container.querySelector(".userRow") as HTMLElement
    expect(row.firstElementChild?.className).toContain("steeringIndicator")
    expect(row.querySelector(".userMessage")?.textContent).toBe("Steer this")
  })
})

async function testRuntime() {
  const api = createDemoRuntime()
  const snapshot = await api.getSnapshot()
  const listeners = new Set<(event: DesktopEvent) => void>()
  api.subscribe = (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const store = new DesktopViewStore(api)
  await store.start()
  return {
    api,
    store,
    snapshot,
    emit: (event: DesktopEvent) => {
      for (const listener of listeners) listener(event)
    },
  }
}

describe("scoped desktop subscriptions", () => {
  it("keeps status consumers idle during transcript updates, but delivers their selected changes", async () => {
    const runtime = await testRuntime()
    let renders = 0
    function Status() {
      const state = useDesktopState("busy", "theme")
      renders++
      return (
        <span>
          {state?.busy ? "Working" : "Idle"} {state?.theme}
        </span>
      )
    }
    render(
      <DesktopProvider value={runtime}>
        <Status />
      </DesktopProvider>,
    )
    const initial = renders
    for (let index = 1; index <= 20; index++) {
      await act(async () =>
        runtime.emit({
          type: "transcript",
          revision: runtime.snapshot.revision + index,
          ops: [{ op: "upsert", entry: { id: 99, kind: "message", speaker: "Otis", text: `Token ${index}` } }],
        }),
      )
    }
    expect(renders).toBe(initial)
    await act(async () =>
      runtime.emit({
        type: "status",
        revision: runtime.snapshot.revision + 21,
        status: { ...runtime.snapshot, busy: true },
      }),
    )
    expect(screen.getByText(/Working/)).toBeTruthy()
    expect(renders).toBe(initial + 1)
    runtime.store.dispose()
  })

  it("refreshes a running trace on status events, and stops fetching once it finishes", async () => {
    const runtime = await testRuntime()
    let revision = runtime.snapshot.revision
    const run = { toolCallId: "trace", title: "Test trace", status: "running" as const, tools: 0 }
    runtime.emit({ type: "status", revision: ++revision, status: { ...runtime.snapshot, subagents: [run] } })
    const getTrace = vi.fn(async () => [])
    runtime.api.getSubagentTrace = getTrace
    render(
      <DesktopProvider value={runtime}>
        <AgentTraceOverlay toolCallId="trace" onClose={() => {}} />
      </DesktopProvider>,
    )
    await act(async () => {})
    expect(getTrace).toHaveBeenCalledTimes(1)
    await act(async () => runtime.emit({ type: "transcript", revision: ++revision, ops: [] }))
    expect(getTrace).toHaveBeenCalledTimes(1)
    await act(async () =>
      runtime.emit({ type: "status", revision: ++revision, status: { ...runtime.snapshot, subagents: [run] } }),
    )
    expect(getTrace).toHaveBeenCalledTimes(2)
    await act(async () =>
      runtime.emit({
        type: "status",
        revision: ++revision,
        status: { ...runtime.snapshot, subagents: [{ ...run, status: "complete" }] },
      }),
    )
    const afterCompletion = getTrace.mock.calls.length
    expect(afterCompletion).toBeGreaterThan(2)
    await act(async () =>
      runtime.emit({
        type: "status",
        revision: ++revision,
        status: { ...runtime.snapshot, subagents: [{ ...run, status: "complete" }] },
      }),
    )
    expect(getTrace).toHaveBeenCalledTimes(afterCompletion)
    runtime.store.dispose()
  })
})
