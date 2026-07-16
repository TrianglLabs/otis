# Otis Agent Instructions

## Product direction

Otis is a general interactive terminal agent, with coding as an important capability. Keep the product centered on the
OpenTUI CLI.

Otis is locally controlled. It has no user accounts, invite codes, hosted control plane, remote profile, cloud usage
database, or cloud synchronization dependency. Inference goes directly to Fireworks with a user-owned API key.
Web search and extraction go directly to Parallel with a separate user-owned API key.

## Current technical decisions

- Frontend: OpenTUI.
- Runtime and package manager: TypeScript on Bun.
- Inference: Fireworks' OpenAI-compatible API, called directly from the local runtime.
- Web access: Parallel Search and Extract APIs, called directly from the local runtime.
- Models: user-selectable public serverless Fireworks models that explicitly support tool calling.
- Configuration: private local file, with `FIREWORKS_API_KEY` and `PARALLEL_API_KEY` as environment overrides.
- Sessions and usage: append-only local JSONL events.
- Tools: local structured tools plus direct Parallel-backed `web_search` and `web_read`.
- Distribution: GitHub Actions and GitHub Releases.

Do not introduce a service account, product login, invite flow, telemetry backend, provider-key proxy, Otis-hosted tool
proxy, or other Otis-owned runtime service without an explicit product decision.

## Model policy

Never offer a model that the Fireworks public serverless catalog does not mark as tool-capable. Keep requests portable
across supported models. Otis defaults to the highest reasoning tier Fireworks documents for each known model family;
keep that compatibility policy centralized, and use the provider default when Fireworks has not documented a safe
effort value. Avoid other model-specific reasoning, sampling, or token settings without an explicit capability model.

Preserve provider-native reasoning and tool-call history when sending later turns.

## Privacy and secrets

- Never log, persist in sessions, or place Fireworks or Parallel API keys in model content.
- Keep saved configuration and session files private on supported platforms.
- Do not add telemetry or remote usage reporting.
- Provider tests use fakes and must not access the network or real credentials.

## Editing guidance

- Prefer small, direct modules with names that describe their responsibility.
- Do not add compatibility layers unless persisted user data or a released interface requires one.
- Keep network transport, persistence, tool execution, and UI rendering in their existing source boundaries.
- Add tests that assert real behavior and failure modes. Remove obsolete tests instead of preserving dead product flows.
- Run the relevant tests, typecheck, formatter/linter checks, and release build before declaring work complete.
