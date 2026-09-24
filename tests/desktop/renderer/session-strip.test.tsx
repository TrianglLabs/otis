// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { RuntimeSummary } from "../../../src/desktop/contracts.js"
import { SessionStrip } from "../../../src/desktop/renderer/features/conversation/Transcript.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"
import { fakeApi, snapshotFixture } from "../support/desktop-api.js"

afterEach(() => cleanup())

const runtime = (id: number, title: string | null, extra: Partial<RuntimeSummary> = {}) => ({
  runtime: id,
  session: title ? { id: `s${id}`, title, dirName: "ws" } : null,
  focused: false,
  busy: false,
  unseen: false,
  diffs: { added: 0, removed: 0 },
  contextTokens: 0,
  ...extra,
})

async function mount(
  runtimes: RuntimeSummary[],
  panes = [runtimes.find((entry) => entry.focused)?.runtime ?? 0],
) {
  const api = fakeApi(snapshotFixture({ runtimes, panes }))
  const store = new DesktopViewStore(api)
  await store.start()
  const view = render(
    <DesktopProvider value={{ api, store }}>
      <SessionStrip />
    </DesktopProvider>,
  )
  return { ...view, api }
}

describe("SessionStrip", () => {
  it("stays out of the way when every open session is on screen", async () => {
    const alone = await mount([runtime(1, "Only one", { focused: true })])
    expect(alone.container.querySelector(".sessionStrip")).toBeNull()
    alone.unmount()
    const both = await mount([runtime(1, "Left", { focused: true }), runtime(2, "Right")], [1, 2])
    expect(both.container.querySelector(".sessionStrip")).toBeNull()
  })

  it("lists the sessions not on screen in order, marks their state, and shows the one clicked", async () => {
    const { getAllByRole, getByRole, api } = await mount([
      runtime(1, "Refactor", { busy: true }),
      runtime(2, "Docs", { unseen: true }),
      runtime(3, null, { focused: true }),
    ])
    const chips = getAllByRole("button")
    expect(chips.map((chip) => chip.textContent)).toEqual(["Refactor", "Docs"])
    expect(chips[0]?.querySelector(".stateDot-working")).not.toBeNull()
    expect(chips[1]?.querySelector(".stateDot")).not.toBeNull()
    fireEvent.click(getByRole("button", { name: "Refactor" }))
    expect(api.focusSession).toHaveBeenCalledExactlyOnceWith(1)
  })
})
