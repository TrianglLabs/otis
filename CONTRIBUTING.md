# Contributing to Otis

Otis favors focused changes, explicit boundaries, and tests that prove observable behavior.

## Setup

Otis uses Bun for dependency management, development, tests, and release builds. macOS and Linux on arm64 and x64 are
the supported targets.

```sh
git clone https://github.com/TrianglLabs/otis.git
cd otis
bun install --frozen-lockfile
bun run dev
```

To exercise the complete agent locally, set `FIREWORKS_API_KEY` or enter it through the first-run UI. Never commit API
keys, local configuration, session data, or captured provider payloads.

## Before opening a pull request

Run the standard verification suite:

```sh
bun run verify
```

Run `bun run build` when changing startup, OpenTUI integration, dependencies, the installer, inference transport, or
release tooling.

## Code organization

- `src/cli` owns command routing and terminal interaction.
- `src/core` owns the agent loop and conversation behavior.
- `src/inference` owns Fireworks HTTP transport, model discovery, and stream parsing.
- `src/local` owns local configuration, paths, and derived statistics.
- `src/storage` owns local session persistence and replay.
- `src/tools` owns structured tool definitions, local execution, and web-tool adapters.
- `src/web` owns direct Parallel HTTP transport and response validation.

Keep dependencies pointed toward those boundaries. Do not put network transport, persistence, or tool execution into
the UI controller.

## Tests

Add tests for observable behavior, regressions, persisted-data compatibility, and security boundaries. Avoid assertions
that only prove a module imports, a mock was called without checking its effect, or a function did not throw.

Tests mirror the source tree under `tests/`. OpenTUI integration tests use the real `@opentui/core/testing` renderer and
therefore run Vitest through Bun; use the package scripts instead of invoking `vitest` directly.

Provider tests must use documented response shapes or local fakes. They must never call Fireworks or Parallel or
depend on a real API key.

## Pull requests

Keep pull requests focused. Explain user-visible behavior, important tradeoffs, persisted-format changes, and how the
change was verified. Call out changes to API-key handling, session events, tool permissions, installer verification, or
provider request serialization explicitly because they carry compatibility or security risk.
