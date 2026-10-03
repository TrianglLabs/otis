import type { BaseRenderable, InputRenderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { afterEach, vi } from "vitest"
import { createChatUI } from "../../../src/cli/chat-ui.js"
import { contextUsage, formatContextUsage } from "../../../src/cli/ui/format.js"
import type { ChatUI, ChatUIOptions } from "../../../src/cli/ui/types.js"
import type { HostedPickerChoice } from "../../../src/inference/picker-catalog.js"
import { matchesHostedModel } from "../../../src/inference/serving-path.js"
import type { HostedModel, HostedProvider } from "../../../src/inference/types.js"

export type ChatUIHarness = TestRendererSetup & {
  ui: ChatUI
  options: ChatUIOptions
  find<T extends BaseRenderable = BaseRenderable>(id: string): T | undefined
  get<T extends BaseRenderable = BaseRenderable>(id: string): T
  text(id: string): string
  childIds(id: string): string[]
  setChatInput(value: string): void
  submitChat(): void
  submitSetup(): void
  press(name: string): void
  pressCtrlC(): void
  typeText(value: string): Promise<void>
  destroy(): void
}

export function useChatHarness() {
  let current: ChatUIHarness | undefined

  afterEach(() => {
    current?.destroy()
    current = undefined
    vi.useRealTimers()
  })

  return async (overrides: Partial<ChatUIOptions> = {}) => {
    current = await createChatHarness(overrides)
    return current
  }
}

async function createChatHarness(overrides: Partial<ChatUIOptions>): Promise<ChatUIHarness> {
  const testRenderer = await createTestRenderer({
    width: 100,
    height: 30,
    kittyKeyboard: true,
    exitOnCtrlC: false,
    exitSignals: [],
  })
  const options: ChatUIOptions = {
    platform: "darwin",
    contextLabel: formatContextUsage(contextUsage(0, 1)),
    modelLabel: "Model: test",
    modeLabel: "› auto",
    sessionLabel: "default",
    workspaceLabel: "~/work/otis",
    onSubmit: vi.fn(),
    ...overrides,
  }
  const ui = createChatUI(testRenderer.renderer, options)
  const find = <T extends BaseRenderable = BaseRenderable>(id: string) => {
    return testRenderer.renderer.root.findDescendantById(id) as T | undefined
  }
  const get = <T extends BaseRenderable = BaseRenderable>(id: string) => {
    const renderable = find<T>(id)
    if (!renderable) throw new Error(`Renderable not found: ${id}`)
    return renderable
  }
  const text = (id: string) => {
    const renderable = get(id) as BaseRenderable & { plainText?: string; content?: unknown }
    if (typeof renderable.plainText === "string") return renderable.plainText
    if (typeof renderable.content === "string") return renderable.content
    throw new Error(`Renderable does not expose text: ${id}`)
  }

  return {
    ...testRenderer,
    ui,
    options,
    find,
    get,
    text,
    childIds: (id) =>
      get(id)
        .getChildren()
        .map((child) => child.id),
    setChatInput: (value) => {
      const input = get<TextareaRenderable>("otis-input")
      input.setText(value)
      input.onContentChange?.({} as never)
    },
    submitChat: () => {
      get<TextareaRenderable>("otis-input").submit()
    },
    submitSetup: () => {
      get<InputRenderable>("setup-input").submit()
    },
    press: (name) => press(testRenderer, name),
    pressCtrlC: () => testRenderer.mockInput.pressCtrlC(),
    typeText: (value) => testRenderer.mockInput.typeText(value),
    destroy: () => {
      ui.stopBusyIndicator()
      testRenderer.renderer.destroy()
    },
  }
}

function press(testRenderer: TestRendererSetup, name: string) {
  if (name === "return" || name === "enter") testRenderer.mockInput.pressEnter()
  else if (name === "escape") testRenderer.mockInput.pressEscape()
  else if (name === "tab") testRenderer.mockInput.pressTab()
  else if (name === "backspace") testRenderer.mockInput.pressBackspace()
  else if (name === "up" || name === "down" || name === "left" || name === "right") {
    testRenderer.mockInput.pressArrow(name)
  } else {
    testRenderer.mockInput.pressKey(name)
  }
}

/** A hosted picker row as the catalog lists it under `provider`; `currentModel` marks it active. */
export function hostedChoice(
  provider: HostedProvider,
  model: Omit<HostedModel, "provider"> & { provider?: HostedProvider },
  currentModel?: string,
): HostedPickerChoice {
  const hosted: HostedModel = { ...model, provider }
  return {
    kind: "model",
    ...hosted,
    available: true,
    active: currentModel ? matchesHostedModel(hosted, currentModel) : false,
  }
}
