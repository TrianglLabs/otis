import { createRoot } from "react-dom/client"
import type { DesktopApi } from "../contracts.js"
import { App, BridgeMissing } from "./App.js"
import { I18nProvider } from "./i18n/index.js"
import { applyStoredTheme, DesktopProvider, useDesktopSelector } from "./runtime.js"
import { DesktopViewStore } from "./state.js"
import "./styles/tokens.css"
import "./styles/themes.css"
import "./styles/global.css"
import "./components/components.css"
import "./shell/shell.css"
import "./features/conversation/conversation.css"
import "./features/models/models.css"
import "./features/palette/palette.css"
import "./features/agents/agents.css"
import "./features/canvas/canvas.css"
import "./features/settings/settings.css"
import "./features/onboarding/onboarding.css"

const container = document.getElementById("root")
if (!container) throw new Error("Missing #root element")

// Before the first render so the boot screen already uses the theme from last session.
applyStoredTheme()

const root = createRoot(container)

void bootstrap()

/**
 * Demo mode is UI-review tooling: it exists only in dev servers and bundles built with `--mode
 * demo`, so release builds neither contain the fixture nor honor the query flag. In a release build
 * `?demo` falls through to the real bridge.
 */
async function bootstrap() {
  const demoRequested = new URLSearchParams(location.search).has("demo")
  if (demoRequested && (import.meta.env.DEV || import.meta.env.MODE === "demo")) {
    const { createDemoRuntime } = await import("./demo/demo-runtime.js")
    const api = createDemoRuntime(window.otis)
    // The demo fixture resolves its snapshot in one tick, so the boot screen never paints. Hold the
    // first snapshot briefly to keep "Loading workspace…" reviewable; the real bridge shows it
    // exactly as long as startup takes.
    const getSnapshot = api.getSnapshot.bind(api)
    let held = false
    api.getSnapshot = async () => {
      if (!held) {
        held = true
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
      return getSnapshot()
    }
    mount(api)
  } else if (window.otis) {
    mount(window.otis)
  } else {
    root.render(
      <I18nProvider>
        <BridgeMissing />
      </I18nProvider>,
    )
  }
}

function mount(api: DesktopApi) {
  const store = new DesktopViewStore(api)
  void store.start()
  root.render(
    <DesktopProvider value={{ api, store }}>
      <LocalizedApp />
    </DesktopProvider>,
  )
}

function LocalizedApp() {
  const language = useDesktopSelector((state) => state?.language ?? "system")
  return (
    <I18nProvider language={language}>
      <App />
    </I18nProvider>
  )
}
