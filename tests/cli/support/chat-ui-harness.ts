import type { BaseRenderable, InputRenderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { afterEach, vi } from "vitest"
import { type ChatUI, createChatUI } from "../../../src/cli/chat-ui.js"
import type { ChatUIOptions } from "../../../src/cli/ui/types.js"

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
  const testRenderer = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  const options: ChatUIOptions = {
    contextLabel: "□□□□□□□□ 0% · ~0",
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
