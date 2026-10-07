// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TranscriptEntry } from "../../../src/app/transcript.js"
import type {
  DesktopApi,
  DesktopSnapshot,
  SubagentTraceView,
} from "../../../src/desktop/contracts.js"
import { createDemoRuntime } from "../../../src/desktop/renderer/demo/demo-runtime.js"
import { AgentTraceOverlay } from "../../../src/desktop/renderer/features/agents/AgentTraceOverlay.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"

// Layout and virtualized scrolling are tested in the real Electron fixture; render every row here.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[]
    itemContent: (index: number, item: unknown, context: unknown) => React.ReactNode
  }) => <div>{data.map((item, index) => itemContent(index, item, {}))}</div>,
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** A manually resolved promise, for controlling when a trace load settles. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const message = (id: number, text: string): TranscriptEntry => ({
  id,
  kind: "message",
  speaker: "Otis",
  text,
})

/**
 * The trace overlay over a live run, with every getSubagentTrace call handed back as a deferred
 * promise.
 */
async function mountTrace(status: "running" | "complete" = "running") {
  vi.useFakeTimers()
  const api = createDemoRuntime()
  const snapshot: DesktopSnapshot = {
    ...(await api.getSnapshot()),
    subagents: [{ toolCallId: "trace", title: "Test trace", status, tools: 0 }],
  }
  api.getSnapshot = async () => snapshot
  const loads: ReturnType<typeof deferred<SubagentTraceView>>[] = []
  const getTrace = vi.fn<DesktopApi["getSubagentTrace"]>(() => {
    const load = deferred<SubagentTraceView>()
    loads.push(load)
    return load.promise
  })
  api.getSubagentTrace = getTrace
  const store = new DesktopViewStore(api)
  await store.start()
  const view = render(
    <DesktopProvider value={{ api, store }}>
      <AgentTraceOverlay toolCallId="trace" onClose={() => {}} />
    </DesktopProvider>,
  )
  await act(async () => {})
  return { view, loads, getTrace, poll: () => act(async () => vi.advanceTimersByTime(250)) }
}

describe("trace loader", () => {
  it("lets an in-flight load finish and coalesces refreshes into one follow-up", async () => {
    const trace = await mountTrace()
    expect(trace.getTrace).toHaveBeenCalledTimes(1)
    await trace.poll()
    await trace.poll()
    await trace.poll()
    // Polls queue behind the in-flight load instead of discarding it.
    expect(trace.getTrace).toHaveBeenCalledTimes(1)

    await act(async () =>
      trace.loads[0].resolve({ revision: 1, entries: [message(1, "First entry")] }),
    )
    expect(screen.getByText("First entry")).toBeTruthy()
    // Exactly one coalesced follow-up, asking only for what is newer than revision 1.
    expect(trace.getTrace).toHaveBeenCalledTimes(2)
    expect(trace.getTrace).toHaveBeenLastCalledWith("trace", 1)
    // Nothing newer: the entries shown stay as they are.
    await act(async () => trace.loads[1].resolve({ revision: 1 }))
    expect(screen.getByText("First entry")).toBeTruthy()
    expect(screen.queryByText("Second entry")).toBeNull()
    await trace.poll()
    expect(trace.getTrace).toHaveBeenLastCalledWith("trace", 1)
    await act(async () =>
      trace.loads[2].resolve({
        revision: 2,
        entries: [message(1, "First entry"), message(2, "Second entry")],
      }),
    )
    expect(screen.getByText("Second entry")).toBeTruthy()
    expect(trace.getTrace).toHaveBeenCalledTimes(3)
  })

  it("drops late responses after the view is torn down", async () => {
    const trace = await mountTrace()
    trace.view.unmount()
    await act(async () =>
      trace.loads[0].resolve({ revision: 1, entries: [message(1, "Late entry")] }),
    )
    expect(screen.queryByText("Late entry")).toBeNull()
    expect(trace.getTrace).toHaveBeenCalledTimes(1)
  })

  it("recovers after a failed load", async () => {
    const trace = await mountTrace()
    await act(async () => trace.loads[0].reject(new Error("gone")))
    await trace.poll()
    expect(trace.getTrace).toHaveBeenCalledTimes(2)
    await act(async () =>
      trace.loads[1].resolve({ revision: 1, entries: [message(1, "Recovered entry")] }),
    )
    expect(screen.getByText("Recovered entry")).toBeTruthy()
  })
})
