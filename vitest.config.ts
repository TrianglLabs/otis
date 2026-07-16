import { readFile } from "node:fs/promises"
import { defineConfig } from "vitest/config"

export default defineConfig({
  // Mirror Bun's built-in .txt loader in Vitest's Vite pipeline.
  plugins: [
    {
      name: "inline-text",
      enforce: "pre",
      async load(id) {
        if (!id.endsWith(".txt")) return null
        return `export default ${JSON.stringify(await readFile(id, "utf8"))}`
      },
    },
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
