// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PendingPermission } from "../../../src/desktop/contracts.js"
import { PermissionCard } from "../../../src/desktop/renderer/features/conversation/PermissionCard.js"

afterEach(() => cleanup())

const permission: PendingPermission = {
  id: 7,
  kind: "shell",
  label: "Running command: bun test",
  resources: ["bun test"],
}

describe("PermissionCard", () => {
  it.each([
    ["Deny", false],
    ["Allow once", true],
  ] as const)("%s responds to the currently displayed request", (name, allow) => {
    const onRespond = vi.fn()
    const { getByRole, rerender } = render(<PermissionCard permission={permission} onRespond={onRespond} />)
    const next = { ...permission, id: 8, label: "Running command: bun run check", resources: ["bun run check"] }
    rerender(<PermissionCard permission={next} onRespond={onRespond} />)
    expect(onRespond).not.toHaveBeenCalled()
    fireEvent.click(getByRole("button", { name }))
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(8, allow)
  })

  it("keeps complete multiline commands and paths readable as literal text", () => {
    const command = `printf '<script>not markup</script>'\n${"long_argument_".repeat(100)}`
    const resources = [command, "../shared/folder with spaces/settings.json"]
    const { getByRole, queryByText, container } = render(
      <PermissionCard permission={{ ...permission, resources }} onRespond={() => {}} />,
    )
    const list = getByRole("list", { name: "Requested resources" })
    expect(Array.from(list.querySelectorAll("code"), (code) => code.textContent)).toEqual(resources)
    expect(container.querySelector("script")).toBeNull()
    expect(list.tabIndex).toBe(0)
    expect(queryByText("Run this command?")).toBeNull()
    expect(queryByText(permission.label)).toBeNull()
  })

  it("describes the request without requiring a resources list", () => {
    const { getByRole, queryByRole } = render(
      <PermissionCard permission={{ ...permission, resources: [] }} onRespond={() => {}} />,
    )
    const dialog = getByRole("alertdialog", { name: "Approval needed" })
    const descriptions = dialog
      .getAttribute("aria-describedby")
      ?.split(" ")
      .map((id) => document.getElementById(id)?.textContent)
    expect(descriptions).toEqual([permission.label])
    expect(queryByRole("list")).toBeNull()
    expect(getByRole("button", { name: "Deny" })).toBeTruthy()
    expect(getByRole("button", { name: "Allow once" })).toBeTruthy()
  })
})
