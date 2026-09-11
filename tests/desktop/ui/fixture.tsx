import { createRoot } from "react-dom/client"
import type { TranscriptEntry } from "../../../src/app/transcript.js"
import type { DesktopEvent, DesktopStatus, TranscriptPatchOp } from "../../../src/desktop/contracts.js"
import { App } from "../../../src/desktop/renderer/App.js"
import { createDemoRuntime } from "../../../src/desktop/renderer/demo/demo-runtime.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"
import "../../../src/desktop/renderer/styles/tokens.css"
import "../../../src/desktop/renderer/styles/themes.css"
import "../../../src/desktop/renderer/styles/global.css"
import "../../../src/desktop/renderer/components/components.css"
import "../../../src/desktop/renderer/shell/shell.css"
import "../../../src/desktop/renderer/features/conversation/conversation.css"
import "../../../src/desktop/renderer/features/models/models.css"
import "../../../src/desktop/renderer/features/palette/palette.css"
import "../../../src/desktop/renderer/features/agents/agents.css"
import "../../../src/desktop/renderer/features/settings/settings.css"

const pause = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector)
  assert(result, `Missing element: ${selector}`)
  return result
}
async function until(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (check()) return
    await pause(30)
  }
  throw new Error(message)
}
const row = (id: number, text: string): TranscriptEntry => ({ id, kind: "message", speaker: "Otis", text })
const markdown =
  "| Field | Value |\n| --- | --- |\n| test | " +
  "wide_content_".repeat(30) +
  " |\n\n```ts\nconst stable = true\n```\n\nAnswer"
const history: TranscriptEntry[] = Array.from({ length: 1500 }, (_, index) =>
  index % 3 === 0
    ? {
        id: index + 1,
        kind: "tool",
        speaker: "Tool",
        text: `Edit ${index}`,
        diff: `@@ -1,1 +1,21 @@\n-old\n${Array.from({ length: 21 }, (_, line) => `+line ${line}`).join("\n")}`,
      }
    : row(index + 1, `Message ${index}\n\n${markdown}`),
)
history.push({ id: 1501, kind: "reasoning", speaker: "Thinking", text: "Keep this expanded", durationMs: 1200 })
history.push(row(1502, markdown))
history.push(row(1503, "Live answer"))

async function runDesktopUiChecks() {
  const api = createDemoRuntime()
  const snapshot = { ...(await api.getSnapshot()), entries: history, subagents: [], busy: true, thinkingVisible: true }
  let revision = snapshot.revision
  const listeners = new Set<(event: DesktopEvent) => void>()
  api.getSnapshot = async () => snapshot
  api.subscribe = (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const store = new DesktopViewStore(api)
  const send = (event: DesktopEvent) => {
    for (const listener of listeners) listener(event)
  }
  const patch = (...ops: TranscriptPatchOp[]) => send({ type: "transcript", revision: ++revision, ops })
  const status = (values: Partial<DesktopStatus>) => {
    const state = store.getState()
    assert(state, "Snapshot is missing")
    send({ type: "status", revision: ++revision, status: { ...state, ...values } })
  }
  api.setThinkingVisible = async (thinkingVisible) => status({ thinkingVisible })
  await store.start()
  const root = createRoot(element("#root"))
  root.render(
    <DesktopProvider value={{ api, store }}>
      <App />
    </DesktopProvider>,
  )
  await until(() => !!document.querySelector('[data-entry-id="1503"]'), "Long history did not open at the latest entry")
  await pause(250)
  const scroll = element(".transcriptScroll")
  const mounted = document.querySelectorAll(".transcriptEntry").length
  assert(mounted < 40, `Mounted ${mounted} entries from a 1503-entry conversation`)
  const bottomGap = () => scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop
  assert(bottomGap() <= 33, `Initial bottom gap: ${bottomGap()}`)

  // Expanded cards survive virtualization and the Settings round trip.
  element<HTMLButtonElement>('[data-entry-id="1501"] .reasoning-header').click()
  await pause()
  assert(!!document.querySelector('[data-entry-id="1501"] .reasoning-body'), "Reasoning did not expand")
  scroll.scrollTop = 0
  await pause(300)
  assert(
    !document.querySelector('[data-entry-id="1501"]'),
    `History did not unmount offscreen rows: scrollTop=${scroll.scrollTop}, height=${scroll.scrollHeight}, items=${Array.from(
      document.querySelectorAll(".transcriptEntry"),
    )
      .map((entry) => entry.getAttribute("data-entry-id"))
      .join(",")}`,
  )
  element<HTMLButtonElement>(".jumpToLatest").click()
  await until(
    () => !!document.querySelector('[data-entry-id="1501"] .reasoning-body'),
    "Virtualization lost expanded reasoning",
  )
  await pause(150)
  const beforeSettings = scroll.scrollTop
  element<HTMLButtonElement>('[aria-label="Settings"]').click()
  await pause()
  element<HTMLButtonElement>('[aria-label="Close settings (Esc)"]').click()
  await pause(150)
  assert(element(".transcriptScroll") === scroll, "Settings replaced the conversation")
  assert(Math.abs(scroll.scrollTop - beforeSettings) < 2, "Settings lost the reading position")
  assert(!!document.querySelector('[data-entry-id="1501"] .reasoning-body'), "Settings collapsed reasoning")

  const table = element('[data-entry-id="1502"] .md-tableWrap')
  const code = element('[data-entry-id="1502"] .codeBlock')
  table.scrollLeft = 90
  const text = element('[data-entry-id="1502"] code').firstChild
  const selection = window.getSelection()
  assert(text && selection, "Code text selection is unavailable")
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 5)
  selection.removeAllRanges()
  selection.addRange(range)
  const selected = selection.toString()
  await pause()
  const selectionTop = scroll.scrollTop
  patch({ op: "upsert", entry: row(1503, `Live answer ${"\n\nMore detail".repeat(40)}`) })
  await pause(180)
  assert(Math.abs(scroll.scrollTop - selectionTop) < 2, "Output scrolled away from selected text")
  assert(selection.toString() === selected, "Output discarded selected text")
  assert(element('[data-entry-id="1502"] .md-tableWrap') === table, "Output replaced the selected message")
  assert(element('[data-entry-id="1502"] .codeBlock') === code, "Output remounted completed code")
  assert(table.scrollLeft === 90, "Output reset table scroll")
  selection.removeAllRanges()
  element<HTMLButtonElement>(".jumpToLatest").click()
  await pause(180)

  const input = element<HTMLTextAreaElement>('[aria-label="Prompt"]')
  const setInputValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
  assert(setInputValue, "Native textarea setter is unavailable")
  input.focus()
  const delays: number[] = []
  let previous = performance.now()
  for (let index = 0; index < 40; index++) {
    patch({ op: "upsert", entry: row(1503, `Live answer ${"\n\nMore detail".repeat(index)}`) })
    setInputValue.call(input, `Draft ${index}`)
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await pause(32)
    const now = performance.now()
    delays.push(now - previous)
    previous = now
  }
  await pause(200)
  assert(bottomGap() <= 33, `Streaming stopped following the bottom: ${bottomGap()}`)
  assert(input.value === "Draft 39" && document.activeElement === input, "Streaming disrupted typing")
  const maxUpdateDelay = Math.max(...delays)
  assert(maxUpdateDelay < 250, `Streaming stalled the UI for ${Math.round(maxUpdateDelay)}ms`)

  // A user reading history stays in place while the live tail grows offscreen.
  scroll.scrollTop -= 1200
  await pause(200)
  const top = scroll.scrollTop
  patch({ op: "upsert", entry: row(1503, `Live answer\n\n${"more\n\n".repeat(60)}`) })
  await pause(200)
  assert(Math.abs(scroll.scrollTop - top) < 2, "Streaming moved the user's reading position")
  element<HTMLButtonElement>(".jumpToLatest").click()
  await pause(250)
  assert(bottomGap() <= 33, "Latest button did not reach the bottom")

  // One huge diff must also stay bounded, and its final line must remain reachable.
  const diff = `@@ -0,0 +1,12000 @@\n${Array.from({ length: 12000 }, (_, index) => `+added_${index + 1}`).join("\n")}`
  status({ session: { id: "large-diff", title: "Large diff" }, busy: false })
  patch({ op: "reset", entries: [{ id: 1, kind: "tool", speaker: "Tool", text: "Large edit", diff }] })
  await until(() => !!document.querySelector(".diffView-windowed .diffLine"), "Large diff did not render")
  const diffScroll = element(".diffView-windowed")
  assert(document.querySelectorAll(".diffLine").length < 100, "Large diff mounted all of its lines")
  diffScroll.scrollTop = diffScroll.scrollHeight
  await until(() => diffScroll.textContent?.includes("added_12000") === true, "Final diff line is not reachable")
  const diffRowsMounted = document.querySelectorAll(".diffLine").length

  // Session-local row IDs repeat. New sessions must not inherit the old viewport/disclosure state.
  status({ session: { id: "thinking", title: "Thinking visibility" }, thinkingVisible: false })
  patch({
    op: "reset",
    entries: [
      row(1, "hello"),
      { id: 2, kind: "reasoning", speaker: "Thinking", text: "hidden old trace" },
      { id: 3, kind: "reasoning", speaker: "Thinking", text: "hidden live trace", streaming: true },
    ],
  })
  await until(() => !!document.querySelector(".reasoning-text"), "Hidden thinking did not show its live status")
  assert(!document.querySelector('[data-entry-id="2"]'), "Finished thinking was not filtered")
  assert(!document.body.textContent?.includes("hidden live trace"), "Hidden thinking leaked its content")
  patch({
    op: "upsert",
    entry: { id: 3, kind: "reasoning", speaker: "Thinking", text: "hidden live trace", streaming: false },
  })
  await until(() => !document.querySelector(".reasoning-text"), "Settled hidden thinking remained mounted")
  status({ thinkingVisible: true, permission: { id: 1, label: "Test approval", kind: "shell", resources: [] } })
  await until(
    () => !!document.querySelector('[data-entry-id="2"] .reasoning-header'),
    "Thinking toggle did not reveal finished traces",
  )
  assert(!document.querySelector(".reasoning-body"), "New session inherited expanded reasoning")
  assert(document.body.textContent?.includes("Test approval"), "Permission footer was not rendered")

  // An expanded tool run must stay virtualized: its actions become ordinary windowed rows instead of mounting
  // at once inside the run's row.
  status({ session: { id: "long-run", title: "Long run" }, thinkingVisible: true, permission: null })
  const longRun: TranscriptEntry[] = Array.from({ length: 800 }, (_, index) => ({
    id: index + 1,
    kind: "tool",
    speaker: "Tool",
    text: `Running command: step-${index + 1}`,
    activityKind: "shell",
  }))
  patch({ op: "reset", entries: longRun })
  await until(() => !!document.querySelector(".toolRun-header"), "Long tool run did not condense")
  const mountedCollapsed = document.querySelectorAll(".transcriptEntry").length
  assert(mountedCollapsed < 40, `Collapsed run mounted ${mountedCollapsed} rows for 800 actions`)
  element<HTMLButtonElement>(".toolRun-header").click()
  await pause(300)
  const mountedExpanded = document.querySelectorAll(".transcriptEntry").length
  assert(mountedExpanded < 100, `Expanded run mounted ${mountedExpanded} of 800 actions`)
  assert(!document.querySelector('[data-entry-id="400"]'), "Expanded run mounted an offscreen action")
  // Session switching creates a new scroller; exercise that live element, not the old session's detached one.
  const runScroll = element(".transcriptScroll")
  runScroll.scrollTop = 0
  await until(() => !!document.querySelector('[data-entry-id="1"]'), "Expanded run's first action is unreachable")
  assert(!document.querySelector('[data-entry-id="800"]'), "Scrolling up kept the end of the run mounted")
  runScroll.scrollTop = (runScroll.scrollHeight - runScroll.clientHeight) / 2
  await until(() => !!document.querySelector('[data-entry-id="400"]'), "Expanded run's middle action is unreachable")
  runScroll.scrollTop = runScroll.scrollHeight
  await until(() => !!document.querySelector('[data-entry-id="800"]'), "Expanded run's final action is unreachable")

  root.unmount()
  store.dispose()
  return {
    passed: true,
    historyEntries: history.length,
    mountedEntries: mounted,
    diffLines: 12000,
    diffRowsMounted,
    expandedRunActions: 800,
    expandedRunMounted: mountedExpanded,
    maxStreamingDelayMs: Math.round(maxUpdateDelay),
  }
}

Object.assign(window, { runDesktopUiChecks })
