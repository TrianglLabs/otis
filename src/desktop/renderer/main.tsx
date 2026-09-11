import { createRoot } from "react-dom/client"
import type { DesktopApi } from "../contracts.js"
import { App, BridgeMissing } from "./App.js"
import { DesktopProvider } from "./runtime.js"
import { DesktopViewStore } from "./state.js"
import { applyStoredTheme } from "./theme.js"

import "./styles/tokens.css"
import "./styles/themes.css"
import "./styles/global.css"
import "./components/components.css"
import "./shell/shell.css"
import "./features/conversation/conversation.css"
import "./features/models/models.css"
import "./features/palette/palette.css"
import "./features/agents/agents.css"
import "./features/settings/settings.css"
import "./features/onboarding/onboarding.css"

const container = document.getElementById("root")
if (!container) throw new Error("Missing #root element")

// Before the first render so the boot screen already uses the theme from last session.
applyStoredTheme()

const root = createRoot(container)

void bootstrap()

/**
 * Demo mode is UI-review tooling: it exists only in dev servers and bundles built with `--mode demo`, so release
 * builds neither contain the fixture nor honor the query flag. In a release build `?demo` falls through to the
 * real bridge.
 */
async function bootstrap() {
  const demoRequested = new URLSearchParams(location.search).has("demo")
  if (demoRequested && (import.meta.env.DEV || import.meta.env.MODE === "demo")) {
    const { createDemoRuntime } = await import("./demo/demo-runtime.js")
    mount(holdBootScreen(createDemoRuntime()))
  } else if (window.otis) {
    mount(window.otis)
  } else {
    root.render(<BridgeMissing />)
  }
}

/**
 * The demo fixture resolves its snapshot in one tick, so the boot screen never paints. Hold the first snapshot
 * briefly to keep "Loading workspace…" reviewable; the real bridge shows it exactly as long as startup takes.
 */
function holdBootScreen(api: DesktopApi): DesktopApi {
  const getSnapshot = api.getSnapshot.bind(api)
  let held = false
  api.getSnapshot = async () => {
    if (!held) {
      held = true
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    return getSnapshot()
  }
  return api
}

function mount(api: DesktopApi) {
  const store = new DesktopViewStore(api)
  void store.start()
  root.render(
    <DesktopProvider value={{ api, store }}>
      <App />
    </DesktopProvider>,
  )
}
