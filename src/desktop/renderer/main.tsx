import { createRoot } from "react-dom/client"
import type { DesktopApi } from "../contracts.js"
import { App, BridgeMissing } from "./App.js"
import { DesktopProvider } from "./runtime.js"
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
import "./features/settings/settings.css"
import "./features/onboarding/onboarding.css"

const container = document.getElementById("root")
if (!container) throw new Error("Missing #root element")

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
    mount(createDemoRuntime())
  } else if (window.otis) {
    mount(window.otis)
  } else {
    root.render(<BridgeMissing />)
  }
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
