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
/** The demo's scripted turn runs on real timers; its milestones need a wider polling budget. */
async function untilSlow(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (check()) return
    await pause(150)
  }
  throw new Error(message)
}
function assertTraceVisible() {
  const popup = element(".agentTrace").getBoundingClientRect()
  const scroller = element(".agentTrace .transcriptScroll")
  const viewport = scroller.getBoundingClientRect()
  assert(
    scroller.clientHeight > 0,
    `Coworker transcript has no visible height: popup=${popup.height}, viewport=${viewport.height}`,
  )
  assert(viewport.bottom <= popup.bottom, "Coworker transcript extends below its popup")
  const contentTop = element(".agentTrace .transcript").getBoundingClientRect().top + scroller.scrollTop
  assert(Math.abs(contentTop - viewport.top) < 1, "Coworker content adds an extra gap below the title bar")
  assert(
    Array.from(scroller.querySelectorAll(".transcriptEntry")).some((entry) => {
      const bounds = entry.getBoundingClientRect()
      return bounds.height > 0 && bounds.bottom > viewport.top && bounds.top < viewport.bottom
    }),
    "Coworker transcript entries exist but none are visible in the popup",
  )
}
const row = (id: number, text: string): TranscriptEntry => ({ id, kind: "message", speaker: "Otis", text })
// Fixture history lives in a private id range: the demo's scripted turn generates its own low entry ids,
// and a shared space would upsert demo entries into history rows instead of appending them.
const HISTORY_ID_BASE = 100_000
const markdown =
  "| Field | Value |\n| --- | --- |\n| test | " +
  "wide_content_".repeat(30) +
  " |\n\n```ts\nconst stable = true\n```\n\nAnswer"
const history: TranscriptEntry[] = Array.from({ length: 1500 }, (_, index) =>
  index % 3 === 0
    ? {
        id: HISTORY_ID_BASE + index,
        kind: "tool",
        speaker: "Tool",
        text: `Edit ${index}`,
        diff: `@@ -1,1 +1,21 @@\n-old\n${Array.from({ length: 21 }, (_, line) => `+line ${line}`).join("\n")}`,
      }
    : row(HISTORY_ID_BASE + index, `Message ${index}\n\n${markdown}`),
)
history.push({
  id: HISTORY_ID_BASE + 1501,
  kind: "reasoning",
  speaker: "Thinking",
  text: "Keep this expanded",
  durationMs: 1200,
})
history.push(row(HISTORY_ID_BASE + 1502, markdown))
history.push(row(HISTORY_ID_BASE + 1503, "Live answer"))

async function runDesktopUiChecks() {
  const api = createDemoRuntime()
  const snapshot = { ...(await api.getSnapshot()), entries: history, subagents: [], busy: true, thinkingVisible: true }
  let revision = snapshot.revision
  const listeners = new Set<(event: DesktopEvent) => void>()
  api.getSnapshot = async () => snapshot
  // Bridge both channels: the fixture injects events through `send`, while the demo's scripted turn emits
  // through its own registry. The store's listener must sit in both; each event still arrives exactly once.
  const originalSubscribe = api.subscribe.bind(api)
  api.subscribe = (listener) => {
    listeners.add(listener)
    const unsubscribe = originalSubscribe(listener)
    return () => {
      listeners.delete(listener)
      unsubscribe()
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
  await until(
    () => !!document.querySelector('[data-entry-id="101503"]'),
    "Long history did not open at the latest entry",
  )
  await pause(250)
  let scroll = element(".transcriptScroll")
  const mounted = document.querySelectorAll(".transcriptEntry").length
  assert(mounted < 40, `Mounted ${mounted} entries from a 1503-entry conversation`)
  const bottomGap = () => scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop
  assert(bottomGap() <= 33, `Initial bottom gap: ${bottomGap()}`)

  // Expanded cards survive virtualization and the Settings round trip. Deliberately injection-free: the
  // scripted coworker turn below must be the first thing to advance the store's revision, or the demo's
  // own events would arrive stale and be dropped.
  element<HTMLButtonElement>('[data-entry-id="101501"] .reasoning-header').click()
  await pause()
  assert(!!document.querySelector('[data-entry-id="101501"] .reasoning-body'), "Reasoning did not expand")
  scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -1000, bubbles: true }))
  scroll.scrollTop = 0
  await pause(300)
  assert(
    !document.querySelector('[data-entry-id="101501"]'),
    `History did not unmount offscreen rows: scrollTop=${scroll.scrollTop}, height=${scroll.scrollHeight}, items=${Array.from(
      document.querySelectorAll(".transcriptEntry"),
    )
      .map((entry) => entry.getAttribute("data-entry-id"))
      .join(",")}`,
  )
  element<HTMLButtonElement>(".jumpToLatest").click()
  await until(
    () => !!document.querySelector('[data-entry-id="101501"] .reasoning-body'),
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
  assert(!!document.querySelector('[data-entry-id="101501"] .reasoning-body'), "Settings collapsed reasoning")

  // A coworker run driven by the demo's own script — the real fetch path, not an injected trace. It runs
  // before any fixture-injected events, so the demo's revisions stay fresh for the store; afterwards the
  // fixture's counter continues from the demo's last revision. The rail row must open a trace with entries,
  // both while the run is live and after it settles.
  let demoRevision = snapshot.revision
  const demoEventLog: string[] = []
  originalSubscribe((event) => {
    demoRevision = Math.max(demoRevision, event.revision)
    demoEventLog.push(
      event.type === "status"
        ? `status(subagents=${event.status.subagents.length},busy=${event.status.busy})`
        : event.type,
    )
  })
  const promptResult = await api.sendPrompt("fix the keyboard handling")
  assert(promptResult.accepted === true, "Demo prompt was not accepted")
  await untilSlow(
    () => !!document.querySelector(".agentsRow"),
    `Coworkers rail did not list the scripted run; demo events: ${demoEventLog.slice(-12).join(" | ")}`,
  )
  // A follow-up sent mid-turn parks as queued: the list-end icon replaces the old text badge.
  const queuedResult = await api.sendPrompt("also check the session locks")
  assert(
    queuedResult.accepted === true && queuedResult.delivery === "queued",
    "Follow-up prompt was not queued while the turn was busy",
  )
  await until(
    () => !!document.querySelector(".queuedIndicator"),
    `Queued follow-up did not render its list-end icon; in DOM: ${document.body.textContent?.includes(
      "also check",
    )}; last store entry: ${store.getState()?.entries.at(-1)?.text?.slice(0, 40) ?? "?"}`,
  )
  element<HTMLButtonElement>(".agentsRow").click()
  await until(() => !!document.querySelector(".agentTrace"), "Trace overlay did not open")
  await untilSlow(
    () => document.querySelectorAll(".agentTrace .transcriptEntry").length > 0,
    `Trace overlay rendered no entries while the run was live: ${
      document.querySelector(".agentTrace")?.textContent?.slice(0, 120) ?? ""
    }; demo events: ${demoEventLog.slice(-12).join(" | ")}`,
  )
  assertTraceVisible()
  // The queued follow-up flushes into a second scripted turn once the first finishes; each turn parks at
  // its own permission ask. Answer them all and hold past the flush gap before declaring the run settled.
  for (let ask = 0; ask < 5; ask++) {
    await untilSlow(
      () => !!document.querySelector(".permissionCard") || store.getState()?.busy === false,
      "Scripted turn did not ask for permission",
    )
    if (!document.querySelector(".permissionCard")) {
      await pause(700)
      if (!document.querySelector(".permissionCard") && store.getState()?.busy === false) break
      continue
    }
    const deny = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Deny")
    assert(deny, "Permission card's Deny button is missing")
    deny.click()
  }
  await untilSlow(() => store.getState()?.busy === false, "Scripted turns never settled after their permission answers")
  assert(
    document.querySelectorAll(".agentTrace .transcriptEntry").length > 0,
    "Trace overlay lost its entries after the run settled",
  )
  assertTraceVisible()
  element<HTMLButtonElement>('[aria-label="Close trace"]').click()
  await until(() => !document.querySelector(".agentTrace"), "Trace overlay did not close")
  // Opening an already-completed run must also allocate a visible viewport on its first layout.
  element<HTMLButtonElement>(".agentsRow").click()
  await until(
    () => document.querySelectorAll(".agentTrace .transcriptEntry").length > 0,
    "Completed coworker trace did not reopen",
  )
  assertTraceVisible()
  element<HTMLButtonElement>('[aria-label="Close trace"]').click()
  await until(() => !document.querySelector(".agentTrace"), "Completed coworker trace did not close")
  revision = demoRevision

  // Streaming output must not disturb a reader mid-message. The scripted turns appended their own entries
  // to the transcript, so reset to the pristine fixture history for deterministic positioning first.
  status({ session: { id: "expanded-cards", title: "Expanded cards" }, subagents: [], busy: false, permission: null })
  patch({ op: "reset", entries: history })
  await until(
    () => !!document.querySelector('[data-entry-id="101503"]'),
    "Reset did not reopen the fixture history at the latest entry",
  )
  // The session switch remounts the conversation, and the reset op swaps the data — Virtuoso collapses
  // to an empty list before re-laying it out, so wait for a real pinned view, not a vacuous bottom gap.
  scroll = element(".transcriptScroll")
  await until(
    () =>
      scroll.scrollHeight > scroll.clientHeight &&
      bottomGap() <= 33 &&
      !!document.querySelector('[data-entry-id="101503"]'),
    "Reset did not pin the reopened history at the latest entry",
  )
  // Row heights are still being re-measured after the swap; a correction pass can re-window the list and
  // destroy a selection set too early. Wait for the scroll position to stop drifting before selecting.
  let settled = false
  for (let attempt = 0; attempt < 20 && !settled; attempt++) {
    const first = scroll.scrollTop
    await pause(250)
    settled = Math.abs(scroll.scrollTop - first) < 1 && bottomGap() <= 33
  }
  assert(settled, `Transcript did not settle after the reset: scrollTop=${scroll.scrollTop}, gap=${bottomGap()}`)
  const mountedIds = Array.from(document.querySelectorAll(".transcriptEntry"))
    .map((entry) => entry.getAttribute("data-entry-id") ?? `run:${entry.getAttribute("data-run-id")}`)
    .join(",")
  assert(
    !!document.querySelector('[data-entry-id="101502"]'),
    `Markdown entry did not mount after the reset: scrollTop=${scroll.scrollTop}, mounted=${mountedIds}`,
  )

  const table = element('[data-entry-id="101502"] .md-tableWrap')
  const code = element('[data-entry-id="101502"] .codeBlock')
  table.scrollLeft = 90
  const text = element('[data-entry-id="101502"] code').firstChild
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
  patch({ op: "upsert", entry: row(101503, `Live answer ${"\n\nMore detail".repeat(40)}`) })
  await pause(180)
  assert(
    Math.abs(scroll.scrollTop - selectionTop) < 2,
    `Output scrolled away from selected text: ${scroll.scrollTop} vs ${selectionTop}, selection="${
      selection.toString() || "<empty>"
    }", jumpVisible=${!!document.querySelector(".jumpToLatest")}`,
  )
  assert(selection.toString() === selected, "Output discarded selected text")
  assert(element('[data-entry-id="101502"] .md-tableWrap') === table, "Output replaced the selected message")
  assert(element('[data-entry-id="101502"] .codeBlock') === code, "Output remounted completed code")
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
    patch({ op: "upsert", entry: row(101503, `Live answer ${"\n\nMore detail".repeat(index)}`) })
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

  // A permission card mounts in the list footer below the fold; follow mode must keep it in view, and
  // answering it must re-pin the newest content.
  status({ permission: { id: 2, label: "Running command: bun test", kind: "shell", resources: ["bun test"] } })
  await until(() => !!document.querySelector(".permissionCard"), "Permission card did not render")
  await until(() => bottomGap() <= 33, `Permission card was not followed into view: ${bottomGap()}`)
  status({ permission: null })
  await until(() => !document.querySelector(".permissionCard"), "Permission card did not clear")
  await until(() => bottomGap() <= 33, "Answering the card left the view off the bottom")

  // A user reading history stays in place while the live tail grows offscreen.
  scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -1200, bubbles: true }))
  scroll.scrollTop -= 1200
  await pause(200)
  const top = scroll.scrollTop
  patch({ op: "upsert", entry: row(101503, `Live answer\n\n${"more\n\n".repeat(60)}`) })
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
  status({
    session: { id: "long-run", title: "Long run" },
    thinkingVisible: true,
    permission: null,
    subagents: [],
  })
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
  runScroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -1000, bubbles: true }))
  runScroll.scrollTop = 0
  await until(() => !!document.querySelector('[data-entry-id="1"]'), "Expanded run's first action is unreachable")
  assert(!document.querySelector('[data-entry-id="800"]'), "Scrolling up kept the end of the run mounted")
  runScroll.scrollTop = (runScroll.scrollHeight - runScroll.clientHeight) / 2
  await until(() => !!document.querySelector('[data-entry-id="400"]'), "Expanded run's middle action is unreachable")
  runScroll.scrollTop = runScroll.scrollHeight
  await until(() => !!document.querySelector('[data-entry-id="800"]'), "Expanded run's final action is unreachable")

  // Follow a new response through line wraps and the transition from live thinking to the final answer.
  status({
    session: { id: "streaming-transitions", title: "Streaming transitions" },
    busy: true,
    thinkingVisible: true,
  })
  const thinking: TranscriptEntry = {
    id: 101504,
    kind: "reasoning",
    speaker: "Thinking",
    text: "Consider the first approach.\nCheck another approach.\nCompare the results.",
    streaming: true,
  }
  patch({ op: "reset", entries: [...history, thinking] })
  await until(() => !!document.querySelector('[data-entry-id="101504"]'), "Live thinking did not mount")
  scroll = element(".transcriptScroll")
  await pause(300)
  assert(bottomGap() <= 33, `Thinking did not open at the bottom: ${bottomGap()}`)
  // Repeat growth and shrinkage to exercise reflow as well as steadily increasing text.
  for (let turn = 0; turn < 8; turn++) {
    patch({ op: "upsert", entry: { ...thinking, streaming: false } })
    await pause(16)
    for (let chunk = 1; chunk <= 12; chunk++) {
      patch({
        op: "upsert",
        entry: row(101505, `Answer ${turn}\n\n${"A streamed sentence that wraps across the line. ".repeat(chunk * 4)}`),
      })
      await pause(16)
    }
    await pause(200)
    assert(
      bottomGap() <= 33,
      `Following stopped after thinking settled in turn ${turn}: gap=${bottomGap()}, top=${scroll.scrollTop}, height=${scroll.scrollHeight}`,
    )
    patch({ op: "upsert", entry: thinking })
    await pause(100)
  }

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
