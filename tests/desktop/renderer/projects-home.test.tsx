// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ProjectSummary } from "../../../src/desktop/contracts.js"
import { ProjectsHome } from "../../../src/desktop/renderer/features/projects/ProjectsHome.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"
import { fakeApi, snapshotFixture } from "../support/desktop-api.js"

afterEach(() => cleanup())

const otis: ProjectSummary = {
  dirName: "otis-0123456789ab",
  path: "/Users/dev/otis",
  label: "otis",
  pinned: true,
  sessions: 2,
  updatedAt: new Date().toISOString(),
  open: true,
}
const notes: ProjectSummary = {
  dirName: "notes-0123456789ab",
  path: "/Users/dev/notes",
  label: "Reading",
  pinned: false,
  sessions: 0,
  open: false,
}

const session = (id: string, title: string) => ({
  id,
  title,
  detail: "now",
  dirName: otis.dirName,
  workspaceLabel: "otis",
  workspacePath: otis.path,
})

async function mount(projects: ProjectSummary[], sessions = [session("s1", "Fix the lock")]) {
  const api = fakeApi(snapshotFixture({ projects, sessions }), {
    readProjectInstructions: vi.fn(async () => "Prefer bun."),
  })
  const store = new DesktopViewStore(api)
  await store.start()
  const onHome = vi.fn()
  const view = render(
    <DesktopProvider value={{ api, store }}>
      <ProjectsHome onHome={onHome} />
    </DesktopProvider>,
  )
  return { ...view, api, onHome }
}

describe("ProjectsHome", () => {
  it("lists projects with their activity and opens one into its page", async () => {
    const { getByText, getByRole, queryByRole, api, onHome } = await mount([otis, notes])
    expect(getByText("2 sessions", { exact: false })).toBeTruthy()
    expect(getByText("0 sessions")).toBeTruthy()
    // The pinned project sits in a row of its own above the rest.
    const headings = [...document.querySelectorAll(".home-heading")].map(
      (heading) => heading.firstChild?.textContent,
    )
    expect(headings).toEqual(["Pinned", "Projects"])
    expect(
      getByText("otis").compareDocumentPosition(getByText("Reading")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // Each card carries its pin; the pinned one offers to unpin.
    await act(async () => fireEvent.click(getByRole("button", { name: "Pin" })))
    expect(api.setProject).toHaveBeenCalledWith(notes.dirName, { pinned: true })
    expect(getByRole("button", { name: "Unpin" })).toBeTruthy()
    fireEvent.click(getByText("Reading"))
    expect(getByText("/Users/dev/notes")).toBeTruthy()
    expect(getByText("No sessions yet.")).toBeTruthy()
    // The instructions show their first line on the card; Edit opens a sheet whose Save writes
    // them only when changed, and Cancel discards the draft.
    await waitFor(() => expect(getByText("Prefer bun.")).toBeTruthy())
    fireEvent.click(getByRole("button", { name: "Edit" }))
    const editor = getByRole("dialog").querySelector("textarea") as HTMLTextAreaElement
    expect(editor.value).toBe("Prefer bun.")
    await act(async () => fireEvent.click(getByRole("button", { name: "Save" })))
    expect(api.writeProjectInstructions).not.toHaveBeenCalled()
    fireEvent.click(getByRole("button", { name: "Edit" }))
    fireEvent.change(getByRole("dialog").querySelector("textarea") as HTMLTextAreaElement, {
      target: { value: "Prefer bun. Keep it short." },
    })
    await act(async () => fireEvent.click(getByRole("button", { name: "Save" })))
    expect(api.writeProjectInstructions).toHaveBeenCalledWith(
      notes.dirName,
      "Prefer bun. Keep it short.",
    )
    expect(getByText("Prefer bun. Keep it short.")).toBeTruthy()
    fireEvent.click(getByRole("button", { name: "Edit" }))
    fireEvent.change(getByRole("dialog").querySelector("textarea") as HTMLTextAreaElement, {
      target: { value: "Discarded" },
    })
    fireEvent.click(within(getByRole("dialog")).getByRole("button", { name: "Cancel" }))
    expect(queryByRole("dialog")).toBeNull()
    expect(api.writeProjectInstructions).toHaveBeenCalledTimes(1)
    // A new session is the folder opened afresh, shown on Home.
    await act(async () => fireEvent.click(getByRole("button", { name: "New session" })))
    expect(api.openWorkspace).toHaveBeenCalledWith("/Users/dev/notes")
    expect(onHome).toHaveBeenCalledOnce()
  })

  it("renames a project from its title and lists the project's own sessions", async () => {
    const { getByText, getByRole, getByLabelText, api } = await mount([otis])
    fireEvent.click(getByText("otis"))
    fireEvent.click(getByRole("button", { name: "Rename" }))
    const field = getByLabelText("Project name") as HTMLInputElement
    fireEvent.change(field, { target: { value: "Otis desktop" } })
    await act(async () => fireEvent.submit(field.closest("form") as HTMLFormElement))
    expect(api.setProject).toHaveBeenCalledWith(otis.dirName, { name: "Otis desktop" })
    fireEvent.click(getByText("Fix the lock"))
    expect(api.selectSession).toHaveBeenCalledWith("s1", otis.dirName)
    // Back returns to the list.
    fireEvent.click(getByRole("button", { name: "Projects" }))
    expect(getByText("2 sessions", { exact: false })).toBeTruthy()
  })

  it("pages projects and a project's sessions four at a time", async () => {
    const projects = Array.from({ length: 5 }, (_, i) => ({
      ...notes,
      dirName: `p${i}-0123456789ab`,
      label: `Project ${i}`,
    }))
    const sessions = Array.from({ length: 6 }, (_, i) => session(`s${i}`, `Session ${i}`))
    const { getByText, queryByText, getByRole } = await mount([otis, ...projects], sessions)
    expect(getByText("Project 3")).toBeTruthy()
    expect(queryByText("Project 4")).toBeNull()
    expect(getByText("1 of 2")).toBeTruthy()
    fireEvent.click(getByRole("button", { name: "Next page" }))
    expect(getByText("Project 4")).toBeTruthy()
    // The pinned project is not among the pages; it stays in its own row.
    fireEvent.click(getByText("otis"))
    expect(getByText("Session 3")).toBeTruthy()
    expect(queryByText("Session 4")).toBeNull()
    fireEvent.click(getByRole("button", { name: "Next page" }))
    expect(getByText("Session 4")).toBeTruthy()
    expect(queryByText("Session 0")).toBeNull()
  })
})
