import type { MouseInputEvent } from "electron"
import { createRoot } from "react-dom/client"
import type { TranscriptEntry } from "../../../src/app/transcript.js"
import type { ArtifactMetadata, PublishedArtifactReference } from "../../../src/artifacts/types.js"
import type { DesktopEvent, DesktopStatus, TranscriptPatchOp } from "../../../src/desktop/contracts.js"
import { App } from "../../../src/desktop/renderer/App.js"
import { createDemoRuntime } from "../../../src/desktop/renderer/demo/demo-runtime.js"
import { FileArtifact } from "../../../src/desktop/renderer/features/canvas/FileArtifact.js"
import { PdfPreview } from "../../../src/desktop/renderer/features/canvas/PdfPreview.js"
import { catalogs, I18nProvider, type ResolvedLocale } from "../../../src/desktop/renderer/i18n/index.js"
import { DesktopProvider } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"
import { pdfFixture } from "./pdf-fixture.js"
import "../../../src/desktop/renderer/styles/tokens.css"
import "../../../src/desktop/renderer/styles/themes.css"
import "../../../src/desktop/renderer/styles/global.css"
import "../../../src/desktop/renderer/components/components.css"
import "../../../src/desktop/renderer/shell/shell.css"
import "../../../src/desktop/renderer/features/conversation/conversation.css"
import "../../../src/desktop/renderer/features/models/models.css"
import "../../../src/desktop/renderer/features/onboarding/onboarding.css"
import "../../../src/desktop/renderer/features/palette/palette.css"
import "../../../src/desktop/renderer/features/agents/agents.css"
import "../../../src/desktop/renderer/features/canvas/canvas.css"
import "../../../src/desktop/renderer/features/settings/settings.css"

const pause = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))
let inputId = 0
async function nativeInput(request: {
  size?: [number, number]
  events?: MouseInputEvent[]
  screenshot?: boolean
  screenshotName?: string
}) {
  const id = ++inputId
  await new Promise<void>((resolve, reject) => {
    const done = (event: Event) => {
      const detail = (event as CustomEvent<{ id: number; error?: string }>).detail
      if (detail.id !== id) return
      window.removeEventListener("otis-ui-input-done", done)
      if (detail.error) reject(new Error(detail.error))
      else resolve()
    }
    window.addEventListener("otis-ui-input-done", done)
    console.log(`OTIS_UI_INPUT:${JSON.stringify({ ...request, id })}`)
  })
}
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

async function checkLocalServerFields(prefix: "settings" | "onboarding") {
  const address = element<HTMLInputElement>(`#${prefix}-omlx`)
  const key = element<HTMLInputElement>(`#${prefix}-omlx-key`)
  const fields = address.parentElement
  assert(fields, "Server fields are missing")
  const marks = Array.from(fields.querySelectorAll("label img")) as HTMLImageElement[]
  await until(() => marks.length === 3 && marks.every((mark) => mark.naturalWidth > 0), "Server logos did not load")
  for (const label of fields.querySelectorAll("label")) {
    const input = element<HTMLInputElement>(`#${label.htmlFor}`).getBoundingClientRect()
    const bounds = label.getBoundingClientRect()
    assert(bounds.right < input.left, `${prefix}: ${label.textContent} overlaps its input`)
    assert(Math.abs(bounds.top + bounds.height / 2 - input.top - input.height / 2) < 1, "Server label is misaligned")
  }
  const urlBounds = address.getBoundingClientRect()
  const keyBounds = key.getBoundingClientRect()
  assert(Math.abs(keyBounds.left - urlBounds.left) < 1, `${prefix}: API key is not aligned with the address`)
  assert(Math.abs(keyBounds.width - urlBounds.width) < 1, `${prefix}: API key width differs from the address`)
  assert(keyBounds.top >= urlBounds.bottom + 7, `${prefix}: API key overlaps the address`)
  assert(key.type === "password" && key.getAttribute("aria-label") && key.placeholder, "API key lacks a secure label")
  assert(fields.scrollWidth === fields.clientWidth, `${prefix}: Server fields overflow horizontally`)
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
  // Verify the shipped assets load, rather than silently testing a system-font fallback.
  for (const family of ["Inter", "JetBrains Mono"]) {
    for (const style of ["normal", "italic"]) {
      const faces = await document.fonts.load(`${style} 400 14px "${family}"`)
      assert(faces.length > 0 && faces.every((face) => face.status === "loaded"), `${family} ${style} failed to load`)
    }
  }
  const api = createDemoRuntime()
  const snapshot = {
    ...(await api.getSnapshot()),
    entries: history,
    subagents: [],
    artifact: null,
    busy: true,
    thinkingVisible: true,
  }
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
  const renderLanguage = (language: ResolvedLocale) =>
    root.render(
      <DesktopProvider value={{ api, store }}>
        <I18nProvider language={language}>
          <App />
        </I18nProvider>
      </DesktopProvider>,
    )
  renderLanguage("en")
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
  assert(element(".workspaceView").inert, "Settings left the workspace interactive")
  assert(getComputedStyle(element(".settingsLayer")).transitionDuration === "0s", "Settings still animates")
  const settingsSidebar = element(".settingsSidebar").getBoundingClientRect()
  const settingsContent = element(".settingsPage-content").getBoundingClientRect()
  const settingsPage = element(".settingsPage").getBoundingClientRect()
  const settingsTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.settingsSidebar [role="tab"]'))
  assert(settingsTabs.length === 3, "Settings sidebar does not list every section")
  assert(!document.querySelector(".settingsPage-header h1"), "Settings still has a title wordmark")
  assert(settingsSidebar.width >= 160, "Settings sidebar is too narrow")
  assert(Math.abs(settingsSidebar.top - settingsPage.top) < 1, "Settings sidebar does not reach the window top")
  assert(settingsSidebar.right <= settingsContent.left + 1, "Settings sidebar overlaps the active panel")
  // Exercise the platform/window classes emitted by AppShell in Chromium's actual layout and hit testing.
  const settingsShell = element(".appShell")
  const originalShellClasses = settingsShell.className
  for (const platform of ["darwin", "linux", "win32"]) {
    for (const fullscreen of [false, true]) {
      settingsShell.classList.remove("platform-darwin", "platform-linux", "platform-win32")
      settingsShell.classList.add(`platform-${platform}`)
      settingsShell.classList.toggle("windowFullscreen", fullscreen)
      const tab = settingsTabs[0].getBoundingClientRect()
      const header = element(".settingsPage-header").getBoundingClientRect()
      const close = element(".settingsPage-header button").getBoundingClientRect()
      const nativeControls = platform === "darwin" && !fullscreen
      const expectedTop = nativeControls ? header.bottom + 16 : settingsPage.top + 16
      assert(Math.abs(tab.top - expectedTop) < 1, `${platform} fullscreen=${fullscreen}: excess space above tabs`)
      assert(
        Math.abs(close.top + close.height / 2 - (header.top + header.height / 2)) < 1,
        `${platform} fullscreen=${fullscreen}: close button is not centered in the header`,
      )
      assert(
        settingsTabs[0].contains(document.elementFromPoint(tab.left + tab.width / 2, tab.top + tab.height / 2)),
        `${platform} fullscreen=${fullscreen}: title bar intercepts the first tab`,
      )
      await pause() // Let the compositor paint the new platform layout before taking a screenshot.
      await nativeInput({
        screenshot: true,
        screenshotName: `settings-${platform}-${fullscreen ? "fullscreen" : "windowed"}`,
      })
    }
  }
  settingsShell.className = originalShellClasses
  assert(settingsTabs[0].getAttribute("aria-selected") === "true", "Inference is not the initial settings section")
  assert(
    element(".settingsProviderCards").previousElementSibling?.textContent === "Providers",
    "Provider cards have no title",
  )
  const providerCards = Array.from(document.querySelectorAll<HTMLElement>(".settingsCard-provider"))
  assert(providerCards.length === 2, "Provider settings are not grouped into separate cards")
  assert(getComputedStyle(providerCards[0]).backgroundColor !== "rgba(0, 0, 0, 0)", "Settings card has no background")
  providerCards[1].querySelector("button")?.click()
  await until(() => !!document.querySelector("#settings-omlx-key"), "Local server settings did not open")
  await checkLocalServerFields("settings")
  await pause()
  await nativeInput({ screenshot: true, screenshotName: "settings-local-servers" })
  assert(document.querySelectorAll(".settingsUsage-bar").length === 28, "Provider usage activity is incomplete")
  settingsTabs[1].click()
  await until(() => !!document.querySelector(".themeGrid"), "Appearance tab did not open")
  assert(document.querySelectorAll(".settingsCard").length === 2, "Appearance settings are not grouped into cards")
  assert(
    document.querySelectorAll(".settingsGroup > .settings-section").length === 2,
    "Appearance section titles are not outside their cards",
  )
  assert(
    element('[role="tabpanel"]').getAttribute("aria-labelledby") === settingsTabs[1].id,
    "Settings panel is not labelled by its active tab",
  )
  element<HTMLButtonElement>('[aria-label="Close settings (Esc)"]').click()
  await until(() => !document.querySelector(".settingsLayer"), "Settings did not unmount on close")
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
  await untilSlow(
    () => (document.querySelector<HTMLIFrameElement>('iframe[title="launch-plan.docx"]')?.clientHeight ?? 0) > 0,
    "Demo Word document did not render a visible Canvas frame",
  )
  await nativeInput({ screenshot: true, screenshotName: "canvas-word" })
  await api.openArtifact({ source: "workspace", path: "product-brief.pdf", kind: "pdf" })
  await untilSlow(
    () => (document.querySelector<HTMLCanvasElement>(".canvas-pdfPage")?.getBoundingClientRect().height ?? 0) > 0,
    "Demo PDF did not render a visible page in Canvas",
  )
  await nativeInput({ screenshot: true, screenshotName: "canvas-pdf" })
  await api.openArtifact({ source: "workspace", path: "canvas-overview.html", kind: "html" })
  await untilSlow(
    () => (document.querySelector<HTMLIFrameElement>('iframe[title="canvas-overview.html"]')?.clientHeight ?? 0) > 0,
    "Demo webpage did not render a visible Canvas frame",
  )
  // Run under the shipped parent CSP: inline preview code works, while the inherited sandbox
  // policy still blocks network access even when user markup contains a fake head or permissive meta.
  const webpage = element<HTMLIFrameElement>('iframe[title="canvas-overview.html"]')
  const previewChecks: { running?: boolean; isolated?: boolean; blocked?: string }[] = []
  const onPreviewCheck = (event: MessageEvent) => {
    if (event.data?.type === "otis-webpage-check") previewChecks.push(event.data)
  }
  window.addEventListener("message", onPreviewCheck)
  const source = `<!-- <head> --><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline'">
    </head><body><script>
      const report = data => top.postMessage({ type: 'otis-webpage-check', ...data }, '*');
      let isolated = false;
      try { parent.document.body; } catch { isolated = true; }
      report({ running: true, isolated });
      document.addEventListener('securitypolicyviolation', event => report({ blocked: event.effectiveDirective }));
      fetch('https://preview.invalid/network-probe').catch(() => {});
      const image = new Image(); image.src = 'https://preview.invalid/image-probe';
    </script></body></html>`
  const sendPreviewCheck = () =>
    webpage.contentWindow?.postMessage({ type: "otis-webpage-source", source, title: "Policy regression" }, "*")
  webpage.addEventListener("load", sendPreviewCheck, { once: true })
  sendPreviewCheck()
  await untilSlow(
    () =>
      previewChecks.some((check) => check.running && check.isolated) &&
      previewChecks.some((check) => check.blocked === "connect-src") &&
      previewChecks.some((check) => check.blocked === "img-src"),
    "Webpage preview did not run scripts with isolated, network-blocked policy",
  )
  webpage.removeEventListener("load", sendPreviewCheck)
  window.removeEventListener("message", onPreviewCheck)
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

  // Measure the coworker header on first appearance with real translated labels: the collapse button must
  // retain its full hit target, and long tab names must not push it beyond the clipped rail.
  const completedRuns = store.getState()?.subagents ?? []
  for (const locale of Object.keys(catalogs) as ResolvedLocale[]) {
    status({ subagents: [], artifact: null })
    await until(() => !document.querySelector(".workspaceRail"), "Empty side panel did not unmount")
    renderLanguage(locale)
    await until(() => document.documentElement.lang === locale, `Language did not switch to ${locale}`)
    status({ subagents: completedRuns })
    await until(() => !!document.querySelector(".workspaceRail"), `${locale}: first coworker did not open the panel`)
    await until(() => {
      const rail = element(".workspaceRail").getBoundingClientRect()
      const collapse = element<HTMLButtonElement>(".workspaceRail-header > .iconBtn").getBoundingClientRect()
      const tabs = Array.from(document.querySelectorAll<HTMLElement>('.workspaceRail-tabs button[role="tab"]'))
      const lastTab = tabs.at(-1)?.getBoundingClientRect()
      return (
        collapse.width >= 26 &&
        collapse.right <= rail.right &&
        tabs.every((tab) => tab.scrollWidth <= tab.clientWidth) &&
        (lastTab?.right ?? Number.POSITIVE_INFINITY) <= collapse.left
      )
    }, `${locale}: translated tabs did not receive enough room`)
    const rail = element(".workspaceRail").getBoundingClientRect()
    const tabsElement = element(".workspaceRail-tabs")
    const tabs = tabsElement.getBoundingClientRect()
    const collapse = element<HTMLButtonElement>(".workspaceRail-header > .iconBtn")
    const button = collapse.getBoundingClientRect()
    assert(button.width >= 26 && button.right <= rail.right, `${locale}: collapse button is clipped or shrunk`)
    const tabButtons = Array.from(tabsElement.querySelectorAll<HTMLElement>('button[role="tab"]'))
    assert(
      tabButtons.every((tab) => tab.scrollWidth <= tab.clientWidth),
      `${locale}: a tab label is truncated`,
    )
    assert(
      (tabButtons.at(-1)?.getBoundingClientRect().right ?? tabs.right) <= button.left,
      `${locale}: tabs overlap the collapse button`,
    )
    const hit = document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2)
    assert(hit === collapse || (hit !== null && collapse.contains(hit)), `${locale}: collapse button cannot be clicked`)
  }
  renderLanguage("en")
  await until(() => document.documentElement.lang === "en", "Language did not return to English")
  const coworkerTab = element<HTMLButtonElement>('.workspaceRail-tabs button[role="tab"]')
  coworkerTab.click()
  await until(() => coworkerTab.getAttribute("aria-selected") === "true", "Coworker tab did not activate")
  await pause(260)

  const resizer = element<HTMLHRElement>(".workspaceRail-resizeHandle")
  const widthBeforeResize = element(".workspaceRail").getBoundingClientRect().width
  const divider = resizer.getBoundingClientRect()
  const dragX = Math.round(divider.x + 4)
  const dragY = Math.round(divider.y + divider.height / 2)
  await nativeInput({
    events: [
      { type: "mouseMove", x: dragX, y: dragY },
      { type: "mouseDown", button: "left", clickCount: 1, x: dragX, y: dragY },
      { type: "mouseMove", x: dragX - 64, y: dragY },
    ],
  })
  await until(
    () => element(".workspaceRail").getBoundingClientRect().width >= widthBeforeResize + 63,
    "Dragging the side-panel divider did not resize the panel",
  )
  await nativeInput({ events: [{ type: "mouseUp", button: "left", clickCount: 1, x: dragX - 64, y: dragY }] })
  assert(
    resizer.getAttribute("aria-valuenow") === String(Math.round(widthBeforeResize + 64)),
    "Resize divider did not expose its new width",
  )
  resizer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
  await until(
    () => Math.abs(element(".workspaceRail").getBoundingClientRect().width - 240) < 1,
    "Double-clicking the side-panel divider did not restore its default width",
  )

  // Mermaid stays ordinary transcript content until its explicit Canvas action is used.
  let canvasResult:
    | {
        ok: boolean
        message?: string
        width?: number
        diagramTop?: number
        controlsBottom?: number
        controls?: boolean
      }
    | undefined
  const onCanvasMessage = (event: MessageEvent) => {
    if (event.data?.type === "otis-canvas-render") canvasResult = event.data
  }
  window.addEventListener("message", onCanvasMessage)
  const diagramCount = 4
  patch({
    op: "upsert",
    entry: row(
      HISTORY_ID_BASE + 1600,
      [
        ...Array.from(
          { length: diagramCount - 1 },
          (_, index) => `\`\`\`mermaid\nflowchart LR\n  Prompt${index} --> Canvas${index}\n\`\`\``,
        ),
        "```mermaid\nflowchart LR\n  This diagram is malformed -->\n```",
      ].join("\n\n"),
    ),
  })
  await until(
    () => document.querySelectorAll('[aria-label^="Open in Canvas:"]').length === diagramCount,
    "Completed Mermaid blocks did not expose Canvas actions",
  )
  const diagramEntry = element(`[data-entry-id="${HISTORY_ID_BASE + 1600}"]`)
  const diagramBody = diagramEntry.querySelector<HTMLElement>(".md")
  assert(diagramBody, "Mermaid artifacts lost their message text column")
  const diagramCards = Array.from(diagramEntry.querySelectorAll<HTMLElement>(".artifactCard-mermaid"))
  assert(diagramCards.length === diagramCount, "Mermaid artifacts did not stay in their transcript entry")
  const firstDiagramCard = diagramCards[0]
  assert(firstDiagramCard, "Mermaid artifacts lost their first card")
  const bodyWidth = diagramBody.getBoundingClientRect().width
  assert(
    diagramCards.every((card) => Math.abs(card.getBoundingClientRect().width - bodyWidth) < 1),
    "Mermaid artifacts no longer match the message text width",
  )
  const diagramGaps = diagramCards.slice(1).map((card, index) => {
    const previousCard = diagramCards[index]
    assert(previousCard, "Mermaid artifact spacing lost its previous card")
    return card.getBoundingClientRect().top - previousCard.getBoundingClientRect().bottom
  })
  const firstDiagramGap = diagramGaps[0]
  assert(
    firstDiagramGap !== undefined &&
      firstDiagramGap >= 9 &&
      diagramGaps.every((gap) => Math.abs(gap - firstDiagramGap) < 1),
    "Consecutive Mermaid artifacts do not have consistent spacing",
  )
  const borderBeforeHover = getComputedStyle(firstDiagramCard).borderTopColor
  const firstDiagramBounds = firstDiagramCard.getBoundingClientRect()
  await nativeInput({
    events: [
      {
        type: "mouseMove",
        x: Math.round(firstDiagramBounds.left + firstDiagramBounds.width / 2),
        y: Math.round(firstDiagramBounds.top + firstDiagramBounds.height / 2),
      },
    ],
  })
  assert(
    getComputedStyle(firstDiagramCard).borderTopColor === borderBeforeHover,
    "Artifact hover changed the neutral border color",
  )
  assert(
    element<HTMLButtonElement>('[role="tab"][aria-selected="true"]').textContent?.trim() === "Coworkers",
    "Mermaid output opened Canvas without a user request",
  )
  element<HTMLButtonElement>('[aria-label^="Open in Canvas:"]').click()
  await untilSlow(() => canvasResult !== undefined, "Canvas iframe did not finish rendering Mermaid")
  assert(canvasResult?.ok, `Canvas iframe rejected a valid diagram: ${canvasResult?.message ?? "unknown error"}`)
  const expectedCanvasWidth = Math.min(560, Math.max(280, Math.round(window.innerWidth * 0.38)))
  await until(
    () => Math.abs(element(".workspaceRail-canvas").getBoundingClientRect().width - expectedCanvasWidth) < 1,
    `Canvas rail width did not settle at its responsive default of ${expectedCanvasWidth}`,
  )
  assert(!document.querySelector(".canvas-tabs"), "Canvas retained an artifact tab list")
  assert(document.querySelectorAll(".canvas-frame").length === 1, "Canvas mounted more than the requested diagram")
  assert((canvasResult?.width ?? Number.POSITIVE_INFINITY) <= 480, "Canvas enlarged the selected diagram")
  assert(canvasResult?.controls, "Canvas did not initialize pan and zoom controls")
  assert(
    (canvasResult?.diagramTop ?? 0) >= (canvasResult?.controlsBottom ?? Number.POSITIVE_INFINITY),
    "Canvas initially positioned the diagram underneath its controls",
  )
  assert(
    element<HTMLIFrameElement>(".canvas-frame").sandbox.contains("allow-scripts"),
    "Canvas iframe lost its sandbox",
  )
  assert(
    getComputedStyle(element(".workspaceRail-view-canvas")).transitionDuration !== "0s",
    "Coworkers and Canvas lost their content transition",
  )
  assert(getComputedStyle(element(".updateFab")).display === "none", "Narrow layout kept the update button visible")

  await nativeInput({ size: [1600, 850] })
  await until(
    () =>
      Math.abs(element(".workspaceRail").getBoundingClientRect().width - 560) < 1 &&
      resizer.getAttribute("aria-valuenow") === "560",
    "Canvas width and ARIA did not follow the resized window",
  )
  resizer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }))
  await until(
    () => Math.abs(element(".workspaceRail").getBoundingClientRect().width - 544) < 1,
    "Keyboard resizing jumped from a stale Canvas width",
  )
  await nativeInput({ size: [960, 850] })
  await until(
    () => Math.abs(element(".workspaceRail").getBoundingClientRect().width - 480) < 1,
    "User-sized panel did not respect the smaller window",
  )
  await nativeInput({ size: [1600, 850] })
  await until(
    () => Math.abs(element(".workspaceRail").getBoundingClientRect().width - 544) < 1,
    "Growing the window lost the user's preferred width",
  )

  const canvasDivider = resizer.getBoundingClientRect()
  const canvasX = Math.round(canvasDivider.x + 4)
  const canvasY = Math.round(canvasDivider.y + canvasDivider.height / 2)
  const iframeX = window.innerWidth - 50
  await nativeInput({
    events: [
      { type: "mouseMove", x: canvasX, y: canvasY },
      { type: "mouseDown", button: "left", clickCount: 1, x: canvasX, y: canvasY },
      { type: "mouseMove", x: iframeX, y: canvasY },
    ],
  })
  await until(
    () => resizer.getAttribute("aria-valuenow") === resizer.getAttribute("aria-valuemin"),
    "Dragging into the Canvas iframe lost pointer movement",
  )
  assert(document.elementFromPoint(iframeX, canvasY)?.matches(".canvas-frame"), "Drag did not cross the Canvas iframe")
  await nativeInput({ events: [{ type: "mouseUp", button: "left", clickCount: 1, x: iframeX, y: canvasY }] })
  await until(
    () => !element(".workspaceRail").classList.contains("workspaceRail-resizing"),
    "Releasing over Canvas left the panel stuck resizing",
  )
  const releasedWidth = resizer.getAttribute("aria-valuenow")
  await nativeInput({ events: [{ type: "mouseMove", x: canvasX - 50, y: canvasY }] })
  assert(resizer.getAttribute("aria-valuenow") === releasedWidth, "Panel continued resizing after release over Canvas")
  await nativeInput({ size: [1000, 850] })
  resizer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
  await until(
    () => Math.abs(element(".workspaceRail").getBoundingClientRect().width - 380) < 1,
    "Canvas default width did not restore",
  )

  const validCanvasResult = canvasResult
  const canvasActions = document.querySelectorAll<HTMLButtonElement>('[aria-label^="Open in Canvas:"]')
  canvasActions[canvasActions.length - 1]?.click()
  await untilSlow(() => canvasResult !== validCanvasResult, "Canvas iframe did not report a malformed Mermaid diagram")
  assert(
    canvasResult && !canvasResult.ok && !!canvasResult.message,
    "Canvas did not contain and report the Mermaid parse error",
  )

  const invalidCanvasResult = canvasResult
  canvasActions[0]?.click()
  await untilSlow(
    () => canvasResult !== invalidCanvasResult,
    "Canvas iframe did not recover after the Mermaid parse error",
  )
  assert(canvasResult?.ok, `Canvas did not recover with a valid diagram: ${canvasResult?.message ?? "unknown error"}`)

  const recoveredCanvasResult = canvasResult
  element<HTMLIFrameElement>(".canvas-frame").contentWindow?.postMessage(
    {
      type: "otis-canvas-source",
      source: `flowchart LR\n${"A".repeat(50_001)}`,
      colors: {
        background: "#1a1a1a",
        surface: "#262626",
        text: "#d8dee9",
        muted: "#808080",
        accent: "#8b7cff",
        border: "#444444",
      },
    },
    "*",
  )
  await untilSlow(() => canvasResult !== recoveredCanvasResult, "Canvas iframe ignored an oversized Mermaid diagram")
  assert(
    !canvasResult?.ok && canvasResult?.message?.includes("too large to render"),
    "Canvas did not explain its Mermaid source limit",
  )
  window.removeEventListener("message", onCanvasMessage)

  element<HTMLButtonElement>('[aria-label="Hide side panel"]').click()
  status({ agentsPanelVisible: false })
  await until(() => element(".workspaceRail").classList.contains("workspaceRail-hidden"), "Side panel did not collapse")
  await pause(260)
  const collapsedWidth = element(".workspaceRail").getBoundingClientRect().width
  assert(collapsedWidth < 1, `Collapsed side panel retained ${collapsedWidth}px of layout width`)
  element<HTMLButtonElement>('[aria-label="Show side panel"]').click()
  status({ agentsPanelVisible: true })
  await until(() => !element(".workspaceRail").classList.contains("workspaceRail-hidden"), "Side panel did not reopen")
  await pause(260)
  assert(
    element(".workspaceRail").getBoundingClientRect().width >= 350,
    "Reopened side panel did not restore its width",
  )

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
  scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }))
  scroll.scrollTop -= 120
  await until(() => !!document.querySelector(".jumpToLatest"), "Jump-to-latest control did not appear")
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

  // Long prose and code lines wrap inside the diff instead of requiring horizontal scrolling.
  const longDiffLine = "A resume paragraph with descriptive experience and measurable outcomes. ".repeat(30)
  status({ session: { id: "wrapped-diff", title: "Wrapped diff" }, busy: false })
  patch({
    op: "reset",
    entries: [
      { id: 1, kind: "tool", speaker: "Tool", text: "Edit resume.md", diff: `@@ -1 +1 @@\n-old\n+${longDiffLine}` },
    ],
  })
  await until(() => !!document.querySelector(".diffLine-add"), "Wrapped diff did not render")
  const wrappedDiff = element(".diffView")
  const wrappedText = element(".diffLine-add .diffLine-text")
  await until(
    () => wrappedText.getBoundingClientRect().height > Number.parseFloat(getComputedStyle(wrappedText).lineHeight) * 2,
    "Long diff line did not wrap",
  )
  assert(wrappedDiff.scrollWidth <= wrappedDiff.clientWidth + 1, "Wrapped diff still scrolls horizontally")

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

  // Fresh start requests the reset immediately; content and session metadata arrive in one update.
  status({ busy: false, phase: "idle" })
  api.startNewSession = async () => {
    const current = store.getState()
    assert(current, "Snapshot is missing")
    send({
      type: "status",
      revision: ++revision,
      status: { ...current, session: null, diffs: { added: 0, removed: 0 }, subagents: [] },
      ops: [{ op: "reset", entries: [] }],
    })
    return { ok: true }
  }
  await until(() => !!document.querySelector(".workspaceHeader-new"), "Fresh start did not become available")
  const previousTranscript = element(".transcriptScroll")
  element<HTMLButtonElement>(".workspaceHeader-new").click()
  await until(
    () => !!document.querySelector(".home") && element(".workspaceView").className === "workspaceView",
    "Fresh start did not return to Home",
  )
  assert(getComputedStyle(element(".workspaceView")).transitionDuration === "0s", "Fresh start still animates")
  assert(!document.querySelector(".workspaceHeader-title"), "Home retained the old session title")
  assert(!previousTranscript.isConnected, "Home kept the previous transcript mounted")

  // Thinking effort uses discrete native model levels and remains inside the viewport.
  const thinkingModel = "Qwen/Qwen3.8-27B"
  status({
    model: { id: thinkingModel, provider: "local", supportsImageInput: false },
    modelState: "ready",
    localThinking: {
      modelId: thinkingModel,
      levels: ["off", "low", "medium", "xhigh"],
      defaultLevel: "xhigh",
      selected: "default",
    },
  })
  api.setLocalThinking = async (_model, selected) => {
    const current = store.getState()?.localThinking
    assert(current, "Missing thinking state")
    status({ localThinking: { ...current, selected } })
  }
  await pause()
  element<HTMLButtonElement>(".thinkingControl-trigger").click()
  await pause()
  const panel = element(".thinkingControl-panel").getBoundingClientRect()
  assert(panel.left >= 0 && panel.right <= innerWidth && panel.top >= 0, "Thinking slider exceeds the viewport")
  const thinkingRange = element<HTMLInputElement>('.thinkingControl input[type="range"]')
  assert(document.activeElement === thinkingRange, "Thinking slider does not receive keyboard focus")
  const track = thinkingRange.getBoundingClientRect()
  await nativeInput({
    events: [
      {
        type: "mouseDown",
        button: "left",
        clickCount: 1,
        x: Math.round(track.left + (track.width * 2) / 3),
        y: Math.round(track.top + track.height / 2),
      },
      {
        type: "mouseUp",
        button: "left",
        clickCount: 1,
        x: Math.round(track.left + (track.width * 2) / 3),
        y: Math.round(track.top + track.height / 2),
      },
    ],
  })
  await until(() => store.getState()?.localThinking?.selected === "medium", "Thinking slider did not persist Medium")
  await nativeInput({ screenshot: true })
  thinkingRange.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await pause()
  assert(!document.querySelector(".thinkingControl-panel"), "Escape did not dismiss thinking control")

  // Select each new palette through the same controls users use, with the conversation still mounted.
  api.setTheme = async (theme) => status({ theme })
  element<HTMLButtonElement>('[aria-label="Settings"]').click()
  await pause()
  element<HTMLButtonElement>('[role="tab"][id="settings-tab-appearance"]').click()
  await pause()
  for (const theme of ["pearl", "sage", "titanium"] as const) {
    const tile = element<HTMLSpanElement>(`.themeTile-preview[data-theme="${theme}"]`).closest("button")
    assert(tile, `${theme} is missing from Appearance`)
    tile.click()
    await until(() => document.documentElement.dataset.theme === theme, `${theme} did not apply`)
    assert(tile.getAttribute("aria-pressed") === "true", `${theme} selection is not reflected in Appearance`)
    assert(
      getComputedStyle(element('.themeTile-preview[data-theme="default"]')).backgroundColor === "rgb(26, 26, 26)",
      "Default theme preview inherited the active palette",
    )
    await pause()
    await nativeInput({ screenshot: true, screenshotName: theme })
  }
  await api.setTheme("default")

  element<HTMLButtonElement>('[aria-label="Close settings (Esc)"]').click()
  status({ model: null, modelState: "unconfigured" })
  await until(() => !!document.querySelector(".onboarding"), "Onboarding did not open")
  element<HTMLButtonElement>(".onboarding-cards button:last-child").click()
  await until(() => !!document.querySelector(".onboarding-providerMarks"), "Local setup did not open")
  const marks = Array.from(document.querySelectorAll<HTMLImageElement>(".onboarding-providerMarks img"))
  await until(
    () => marks.length === 3 && marks.every((mark) => mark.naturalWidth > 0),
    "Local setup lacks provider logos",
  )
  await pause(250)
  await nativeInput({ screenshot: true, screenshotName: "onboarding-local" })
  element<HTMLButtonElement>(".onboarding-cards button:last-child").click()
  await until(() => !!document.querySelector("#onboarding-omlx-key"), "Local server setup did not open")
  await nativeInput({ size: [960, 600] })
  await pause(250)
  for (const language of Object.keys(catalogs) as ResolvedLocale[]) {
    renderLanguage(language)
    await pause()
    await checkLocalServerFields("onboarding")
  }
  renderLanguage("en")
  await pause()
  await nativeInput({ screenshot: true, screenshotName: "onboarding-local-servers" })
  await nativeInput({ size: [1000, 850] })

  root.unmount()
  store.dispose()
  const pdfHost = document.createElement("div")
  pdfHost.style.cssText = "display:flex;width:560px;height:600px"
  document.body.append(pdfHost)
  const pdfRoot = createRoot(pdfHost)
  pdfRoot.render(<PdfPreview source={pdfFixture(120)} />)
  await untilSlow(
    () => (pdfHost.querySelector<HTMLCanvasElement>(".canvas-pdfPage")?.width ?? 0) > 300,
    "Long PDF did not render its first page",
  )
  const firstPage = pdfHost.querySelector<HTMLCanvasElement>(".canvas-pdfPage")
  assert(firstPage, "PDF first page is missing")
  assert(pdfHost.querySelectorAll(".canvas-pdfPage").length < 8, "PDF eagerly mounted all pages")
  const pdfScroll = element(".canvas-pdfPages")
  const hostBounds = pdfHost.getBoundingClientRect()
  const scrollBounds = pdfScroll.getBoundingClientRect()
  const pageBounds = firstPage.getBoundingClientRect()
  assert(Math.abs(scrollBounds.right - hostBounds.right) < 1, "PDF scrollbar is inset from the panel edge")
  assert(Math.abs(scrollBounds.left - hostBounds.left) < 1, "PDF scroller does not fill the panel")
  assert(Math.abs(pageBounds.left - scrollBounds.left - 16) < 1, "PDF left page inset is incorrect")
  assert(
    Math.abs(scrollBounds.left + pdfScroll.clientWidth - pageBounds.right - 16) < 1,
    "PDF page touches its scrollbar or has an uneven right inset",
  )
  assert(pdfScroll.scrollWidth === pdfScroll.clientWidth, "PDF preview scrolls horizontally")
  pdfScroll.scrollTop = pdfScroll.scrollHeight
  await untilSlow(() => !!pdfHost.querySelector('[aria-label="Page 120"]'), "PDF final page is unreachable")
  assert(!firstPage.isConnected && firstPage.width === 0, "PDF retained an offscreen page bitmap")
  assert(pdfHost.querySelectorAll(".canvas-pdfPage").length < 8, "PDF scrolling accumulated page canvases")
  pdfRoot.unmount()
  pdfHost.remove()

  const artifactHost = document.createElement("div")
  artifactHost.style.cssText = "display:flex;width:280px;height:400px"
  document.body.append(artifactHost)
  const artifactRoot = createRoot(artifactHost)
  const publication: PublishedArtifactReference = {
    source: "published",
    artifactId: "12345678-1234-1234-1234-123456789abc",
    version: 2,
    sourcePath: "/workspace/report.md",
    name: "A very long document title with multiple words.md",
    kind: "markdown",
    sha256: "a".repeat(64),
  }
  const artifact: ArtifactMetadata = {
    id: `published:${publication.artifactId}`,
    source: "published",
    title: publication.name,
    kind: "markdown",
    revision: 1,
    mimeType: "text/markdown",
    editable: false,
    publication: { reference: publication, versions: [1, 2], followingLatest: true },
  }
  const artifactApi = createDemoRuntime()
  artifactApi.getArtifact = async () => ({ ...artifact, encoding: "utf8", content: "# Saved document" })
  artifactRoot.render(
    <DesktopProvider value={{ api: artifactApi, store: new DesktopViewStore(artifactApi) }}>
      <FileArtifact artifact={artifact} />
    </DesktopProvider>,
  )
  await until(() => !!artifactHost.querySelector("select"), "Artifact version selector did not render")
  const header = artifactHost.querySelector<HTMLElement>(".canvas-artifactHeader")
  assert(header && header.scrollWidth <= header.clientWidth, "Artifact header overflows at narrow widths")
  assert(artifactHost.querySelector("select")?.value === "latest", "Artifact did not default to the latest revision")
  assert(artifactHost.querySelectorAll("option").length === 3, "Artifact history omitted saved revisions")
  artifactRoot.unmount()
  artifactHost.remove()
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
