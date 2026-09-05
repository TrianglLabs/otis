# Otis Agent Instructions

## Product direction

Otis is a general interactive terminal agent, with coding as an important capability. Keep the product centered on the
OpenTUI CLI.

Otis is locally controlled. It has no user accounts, invite codes, hosted control plane, remote profile, cloud usage
database, or cloud synchronization dependency. Hosted inference goes directly to Fireworks with a user-owned API key.
Local inference either runs Otis-managed `llama-server` on localhost or connects to an NVIDIA PAIR proxy on loopback;
PAIR owns its cluster and routes requests across the user's local network. Web search and extraction go directly to
Parallel's Search MCP.

## Current technical decisions

- Frontend: OpenTUI CLI, with shared application behavior in `src/app` for the terminal, headless, and future adapters.
  `src/app` owns conversation lifecycle and model-selection transactions; adapters own screens and rendering.
- Runtime and package manager: TypeScript on Bun.
- Inference: Fireworks' OpenAI-compatible API, called directly from the local runtime; local models via either
  Otis-managed llama.cpp `llama-server` or a user-managed NVIDIA PAIR endpoint on `127.0.0.1`.
- Web access: Parallel Search MCP, called directly from the local runtime.
- Models: curated official Hugging Face checkpoints for managed local GGUF, live user-managed PAIR endpoint inventory,
  plus user-selectable public serverless Fireworks models that explicitly support tool calling.
- Configuration: private local file, with `FIREWORKS_API_KEY` as an environment override.
- Sessions and usage: append-only local JSONL events.
- Tools: local structured tools plus direct Parallel-backed `web_search` and `web_read`.
- Distribution: GitHub Actions and GitHub Releases.

Do not introduce a service account, product login, invite flow, telemetry backend, provider-key proxy, Otis-hosted tool
proxy, or other Otis-owned runtime service without an explicit product decision.

## Model policy

Never offer a hosted model that the Fireworks public serverless catalog does not mark as tool-capable. Managed-local
catalog entries must use official Hugging Face checkpoints; GGUF files come from the model author when they publish
GGUF, otherwise from ggml-org or a conversion of those official weights. Keep requests portable across supported models.
PAIR models are not part of Otis' curated GGUF catalog; discover them only from PAIR's cluster-aggregated `/api/tags`
and `/v1/models` routes and do not send a preflight inference request before selection. Otis must not install or control
PAIR, its engines, or its cluster. Treat PAIR inventory context as a model-architecture maximum for display only. Never
persist it or use metadata from a route forwarded to one node as cluster-wide model or compaction state.
Otis defaults to the highest reasoning tier Fireworks documents for each known model family; keep that compatibility
policy centralized, and use the provider default when Fireworks has not documented a safe effort value. Avoid other
model-specific reasoning, sampling, or token settings without an explicit capability model. Do not enable llama.cpp
built-in `--tools`; Otis tools stay in the local runtime.

Preserve provider-native reasoning and tool-call history when sending later turns.

## Privacy and secrets

- Never log, persist in sessions, or place Fireworks API keys in model content. Hugging Face tokens, if present in the
  process environment for Hub downloads, are not written to sessions.
- Keep saved configuration and session files private on supported platforms.
- Do not add telemetry or remote usage reporting.
- Provider tests use fakes and must not access the network or real credentials.

## Editing guidance

- Prefer small, direct modules with names that describe their responsibility.
- Do not add compatibility layers unless persisted user data or a released interface requires one.
- Keep network transport, persistence, tool execution, and UI rendering in their existing source boundaries.
- Keep reusable conversation, session, and model coordination in `src/app`. `src/app` must not import OpenTUI,
  Electron, React, or anything from `src/cli`.
- Add tests that assert real behavior and failure modes. Remove obsolete tests instead of preserving dead product flows.
- Run the relevant tests, typecheck, formatter/linter checks, and release build before declaring work complete.
