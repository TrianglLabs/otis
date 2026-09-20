import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"
import { inlineText } from "./scripts/vite-inline-text.js"

export default defineConfig({
  // Mirror Bun's text imports for prompts and embedded skill resources.
  plugins: [
    // Automatic JSX runtime for renderer component tests (tests/desktop/renderer/*.tsx).
    react(),
    inlineText(),
  ],
  test: {
    environment: "node",
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      // OpenTUI integration tests require Bun, whose inspector does not expose V8 coverage APIs.
      exclude: ["**/*.test.ts", "src/cli/chat-ui.ts", "src/cli/theme.ts", "src/cli/ui/**"],
    },
  },
})
