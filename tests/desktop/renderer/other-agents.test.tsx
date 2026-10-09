// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopApi, OtherAgentImport } from "../../../src/desktop/contracts.js"
import { App } from "../../../src/desktop/renderer/App.js"
import { I18nProvider } from "../../../src/desktop/renderer/i18n/index.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"
import { fakeApi, snapshotFixture } from "../support/desktop-api.js"

const CLAUDE: OtherAgentImport = {
  id: "claude-code",
  name: "Claude Code",
  instructions: {
    path: "/home/n/.claude/CLAUDE.md",
    text: "Prefer small commits.",
    imported: false,
  },
  facts: [
    {
      scope: "workspace",
      topic: "claude-code/feedback",
      text: "Run the suite first.",
      imported: false,
    },
    { scope: "global", topic: "claude-code/user", text: "Likes bun.", imported: true },
  ],
}

async function renderApp(api: DesktopApi) {
  const store = new DesktopViewStore(api)
  await store.start()
  render(
    <DesktopProvider value={{ api, store }}>
      <I18nProvider language="en">
        <App />
      </I18nProvider>
    </DesktopProvider>,
  )
}

afterEach(() => cleanup())

describe("other agents in Settings", () => {
  it("lists what each agent holds, imports the picked items, and toggles reading in place", async () => {
    const listOtherAgents = vi.fn(async () => [CLAUDE])
    const importOtherAgent = vi.fn(async () => ({ ok: true as const }))
    const api = fakeApi(
      snapshotFixture({ session: { id: "s", title: "Session" }, otherAgentsEnabled: false }),
      { listOtherAgents, importOtherAgent },
    )
    await renderApp(api)
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    fireEvent.click(screen.getByRole("tab", { name: "Extensions" }))
    fireEvent.click(screen.getByRole("tab", { name: "Import" }))
    await act(async () => {})
    const panel = within(screen.getByRole("tabpanel", { name: "Extensions" }))

    // Reading in place follows the setting.
    const toggle = panel.getByRole("switch", { name: "Use other agents' instructions and skills" })
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(toggle)
    expect(api.setOtherAgentsEnabled).toHaveBeenCalledWith(true)

    // Everything not yet imported starts picked; an imported fact is checked and locked.
    const boxes = panel.getAllByRole("checkbox") as HTMLInputElement[]
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([
      [true, false],
      [true, false],
      [true, true],
    ])
    expect(panel.getByText("Global instructions from /home/n/.claude/CLAUDE.md")).toBeTruthy()
    expect(panel.getByText("Likes bun.").parentElement?.textContent).toContain("Imported")
    fireEvent.click(boxes[1])
    const listed = listOtherAgents.mock.calls.length
    fireEvent.click(panel.getByRole("button", { name: "Import selected" }))
    await act(async () => {})
    expect(importOtherAgent).toHaveBeenCalledWith("claude-code", { instructions: true, facts: [] })
    // The list is read again, so what was just imported shows as such.
    expect(listOtherAgents.mock.calls.length).toBe(listed + 1)
  })

  it("says so when no agent was found", async () => {
    await renderApp(fakeApi(snapshotFixture({ session: { id: "s", title: "Session" } })))
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    fireEvent.click(screen.getByRole("tab", { name: "Extensions" }))
    fireEvent.click(screen.getByRole("tab", { name: "Import" }))
    await act(async () => {})
    expect(
      screen.getByText("No other agents with instructions or memory were found on this machine."),
    ).toBeTruthy()
  })
})
