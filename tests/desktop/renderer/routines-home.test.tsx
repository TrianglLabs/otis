// @vitest-environment happy-dom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { RoutineStatus } from "../../../src/desktop/contracts.js"
import { RoutinesHome } from "../../../src/desktop/renderer/features/routines/RoutinesHome.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"
import type { RoutineRun } from "../../../src/local/routines.js"
import { fakeApi, snapshotFixture } from "../support/desktop-api.js"

afterEach(() => cleanup())

const finished: RoutineRun = {
  startedAt: "2026-10-05T07:30:00.000Z",
  finishedAt: "2026-10-05T07:31:00.000Z",
  status: "complete",
  sessionId: "s9",
  dirName: "otis-abc",
}

const digest: RoutineStatus = {
  id: "r1",
  name: "Morning digest",
  prompt: "Summarize yesterday's changes.",
  cwd: "/Users/dev/otis",
  folder: "otis",
  schedule: { kind: "daily", time: "07:30" },
  auto: false,
  enabled: true,
  createdAt: "2026-09-28T07:00:00.000Z",
  lastRun: finished,
  nextRunAt: "2026-10-06T07:30:00.000Z",
}

async function mount(routines: RoutineStatus[]) {
  const api = fakeApi(snapshotFixture({ routines }))
  const store = new DesktopViewStore(api)
  await store.start()
  const view = render(
    <DesktopProvider value={{ api, store }}>
      <RoutinesHome />
    </DesktopProvider>,
  )
  return { ...view, api }
}

describe("RoutinesHome", () => {
  it("lists routines by folder and schedule, and opens the last run from the editor", async () => {
    const { getByText, getByRole, api, container } = await mount([digest])
    expect(getByText("otis · Daily at 7:30 AM")).toBeTruthy()
    // A finished run nobody has looked at carries the home cards' dot.
    expect(container.querySelector(".home-cardDot")).not.toBeNull()
    expect(container.querySelector(".stateDot-failed, .stateDot-paused")).toBeNull()
    // The card opens the last run; the pencil opens the editor.
    fireEvent.click(getByText("Morning digest"))
    expect(api.openSessionAt).toHaveBeenCalledExactlyOnceWith("/Users/dev/otis", "s9", "otis-abc")
    fireEvent.click(getByRole("button", { name: "Edit routine" }))
    fireEvent.click(getByRole("button", { name: "Run now" }))
    expect(api.runRoutine).toHaveBeenCalledExactlyOnceWith("r1")
  })

  it("saves a new routine in the focused folder and refuses one without a prompt", async () => {
    const { getByText, getByRole, getByLabelText, queryByRole, api } = await mount([])
    fireEvent.click(getByText("New routine"))
    const save = getByRole("button", { name: "Save" }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(getByLabelText("Name"), { target: { value: "Nightly tests" } })
    fireEvent.change(getByLabelText("Prompt"), { target: { value: "Run the suite." } })
    fireEvent.click(getByText("Every"))
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    expect(api.saveRoutine).toHaveBeenCalledExactlyOnceWith({
      name: "Nightly tests",
      prompt: "Run the suite.",
      cwd: "/ws",
      schedule: { kind: "interval", minutes: 60 },
      auto: false,
      enabled: true,
    })
    await waitFor(() => expect(queryByRole("button", { name: "Save" })).toBeNull())
  })

  it("says so when a card has no run to open", async () => {
    const { getByText, queryByRole, api } = await mount([{ ...digest, lastRun: undefined }])
    fireEvent.click(getByText("Morning digest"))
    expect(api.openSessionAt).not.toHaveBeenCalled()
    expect(queryByRole("dialog")).toBeNull()
    expect(getByText("This routine hasn't run yet.")).toBeTruthy()
  })

  it("colours the dot for a paused routine and a failed run", async () => {
    const { container } = await mount([
      { ...digest, id: "p", enabled: false },
      { ...digest, id: "f", lastRun: { ...finished, status: "error", seen: true } },
    ])
    expect(container.querySelectorAll(".stateDot-paused")).toHaveLength(1)
    expect(container.querySelectorAll(".stateDot-failed")).toHaveLength(1)
  })

  it("shows six cards a page, New routine first, and pages through the rest", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      ...digest,
      id: `r${i}`,
      name: `Routine ${i}`,
    }))
    const { getByText, queryByText, getByRole, container } = await mount(many)
    expect(container.querySelectorAll(".home-card")).toHaveLength(6)
    expect(container.querySelector(".home-card")?.textContent).toContain("New routine")
    expect(getByText("Routine 4")).toBeTruthy()
    expect(queryByText("Routine 5")).toBeNull()
    expect(getByText("1 of 2")).toBeTruthy()
    fireEvent.click(getByRole("button", { name: "Next page" }))
    expect(getByText("Routine 5")).toBeTruthy()
    expect(queryByText("Routine 0")).toBeNull()
    expect(container.querySelector(".home-card")?.textContent).toContain("New routine")
    expect((getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("offers to watch or stop a running routine", async () => {
    const { getByText, getByRole, queryByRole, api, container } = await mount([
      { ...digest, runtime: 4, lastRun: { ...finished, seen: true } },
    ])
    expect(container.querySelector(".home-cardDot")).toBeNull()
    // The card of a running routine brings its session on screen.
    fireEvent.click(getByText("Morning digest"))
    expect(api.focusSession).toHaveBeenCalledExactlyOnceWith(4)
    fireEvent.click(getByRole("button", { name: "Edit routine" }))
    expect(queryByRole("button", { name: "Run now" })).toBeNull()
    fireEvent.click(getByRole("button", { name: "Watch" }))
    expect(api.focusSession).toHaveBeenCalledTimes(2)
    fireEvent.click(getByRole("button", { name: "Stop" }))
    expect(api.cancelRoutine).toHaveBeenCalledExactlyOnceWith("r1")
  })
})
