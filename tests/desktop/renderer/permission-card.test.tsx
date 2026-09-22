// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  DesktopApi,
  DesktopEvent,
  DesktopSnapshot,
  PendingPermission,
} from "../../../src/desktop/contracts.js"
import { ConversationView } from "../../../src/desktop/renderer/features/conversation/Transcript.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"

// Happy DOM has no layout; the footer slot is all the approval card needs from the virtualizer.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    components,
    context,
  }: {
    components?: { Footer?: (props: { context: unknown }) => ReactNode }
    context: unknown
  }) => <div>{components?.Footer ? <components.Footer context={context} /> : null}</div>,
}))

afterEach(() => cleanup())

const permission: PendingPermission = {
  id: 7,
  kind: "shell",
  label: "Running command: bun test",
  resources: ["bun test"],
}

const SNAPSHOT: DesktopSnapshot = {
  busy: true,
  phase: "working",
  model: { id: "m", provider: "fireworks", supportsImageInput: false },
  modelState: "ready",
  modelError: undefined,
  session: { id: "session-1", title: "Test session" },
  artifact: null,
  needsWorkspace: false,
  sessions: [],
  contextTokens: undefined,
  contextLimit: 32_768,
  diffs: { added: 0, removed: 0 },
  permission,
  stats: undefined,
  modelLoad: null,
  subagents: [],
  agentsPanelVisible: true,
  workspacePanelWidth: undefined,
  theme: "default",
  language: "system",
  thinkingVisible: false,
  permissionMode: "ask",
  localThinking: null,
  fastServing: { available: false, enabled: false },
  hostedConfigured: true,
  pairConfigured: false,
  pairEndpoints: {},
  debug: false,
  platform: "darwin",
  version: "0.0.0-test",
  update: { status: "idle" },
  workspace: { label: "ws", path: "/ws" },
  entries: [],
  revision: 1,
}

/** The conversation with the given approval request pinned to the transcript's end. */
async function renderConversation(pending: PendingPermission) {
  let listener: ((event: DesktopEvent) => void) | undefined
  const respondToPermission = vi.fn(async () => {})
  const api = {
    getSnapshot: async () => ({ ...SNAPSHOT, permission: pending }),
    getWindowState: async () => ({ fullscreen: false }),
    subscribeWindowState: () => () => {},
    listModels: async () => [],
    respondToPermission,
    subscribe: (next: (event: DesktopEvent) => void) => {
      listener = next
      return () => {
        listener = undefined
      }
    },
  } as unknown as DesktopApi
  const store = new DesktopViewStore(api)
  await store.start()
  const view = render(
    <DesktopProvider value={{ api, store }}>
      <ConversationView />
    </DesktopProvider>,
  )
  return {
    ...view,
    respondToPermission,
    /** A newer request replaces the card, the way the main process supersedes a cancelled one. */
    replace: (next: PendingPermission) =>
      act(() =>
        listener?.({ type: "status", revision: 2, status: { ...SNAPSHOT, permission: next } }),
      ),
  }
}

describe("PermissionCard", () => {
  it.each([
    ["Deny", false],
    ["Allow once", true],
  ] as const)("%s responds to the currently displayed request", async (name, allow) => {
    const { getByRole, respondToPermission, replace } = await renderConversation(permission)
    replace({
      ...permission,
      id: 8,
      label: "Running command: bun run check",
      resources: ["bun run check"],
    })
    expect(respondToPermission).not.toHaveBeenCalled()
    fireEvent.click(getByRole("button", { name }))
    expect(respondToPermission).toHaveBeenCalledExactlyOnceWith(8, allow)
  })

  it("keeps complete multiline commands and paths readable as literal text", async () => {
    const command = `printf '<script>not markup</script>'\n${"long_argument_".repeat(100)}`
    const resources = [command, "../shared/folder with spaces/settings.json"]
    const { getByRole, queryByText, container } = await renderConversation({
      ...permission,
      resources,
    })
    const list = getByRole("list", { name: "Requested resources" })
    expect(Array.from(list.querySelectorAll("code"), (code) => code.textContent)).toEqual(resources)
    expect(container.querySelector("script")).toBeNull()
    expect(list.tabIndex).toBe(0)
    expect(queryByText("Run this command?")).toBeNull()
    expect(queryByText(permission.label)).toBeNull()
  })

  it("describes the request without requiring a resources list", async () => {
    const { getByRole, queryByRole } = await renderConversation({ ...permission, resources: [] })
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
