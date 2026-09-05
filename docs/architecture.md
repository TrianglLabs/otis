# Architecture

## Overview

Otis is a local terminal application with direct hosted inference, optional Otis-managed llama.cpp inference, and an
optional connection to NVIDIA PAIR on loopback.

```txt
User terminal or server process
  -> OpenTUI CLI or headless command
    -> shared application
      -> agent loop, tools, permissions, sessions, and inference
      -> local Agent Skills
      -> local JSONL sessions and usage
      -> Fireworks API with the user's key
      -> llama-server on 127.0.0.1
      -> NVIDIA PAIR proxy on loopback -> one eligible Ollama or LM Studio engine
      -> Parallel Search MCP
```

There is no Otis control plane. Users do not create an Otis account, and the runtime has no dependency on an Otis
server, remote profile, cloud database, or Otis-hosted tool service.

## Source boundaries

```txt
src/cli
  +-> src/app ------> src/core ------> src/inference
  |                     |      +----------> src/tools
  |                     |                       +------> src/web
  |                     +-> src/skills -----> local skill packages
  |                     +-> src/local -----> src/storage
  |                     +-> src/storage ---> src/core message types
  +-> OpenTUI rendering and headless process adapters
```

- `src/cli` owns command routing, OpenTUI rendering, and headless process adapters. It must not be imported by
  `src/app` or backend modules. Headless commands do not initialize OpenTUI.
- `src/app` owns shared application composition: conversation projection and turn lifecycle, session ownership, model
  selection transactions, and workspace loading. Adapters call this layer; it does not import OpenTUI, Electron, React,
  or `src/cli`. `Application.shutdown()` cancels an active conversation and in-flight model selection, then stops the
  model runtime.
- `src/core` owns the agent loop, project instruction loading, and conversation compaction.
- `src/inference` owns Fireworks, PAIR, and local llama.cpp request serialization, model discovery, hardware fit, the
  human-authored `system-prompt.txt`, prompt assembly and project-context bounds, and SSE parsing.
- `src/local` owns platform paths, the private provider configuration file, and home-screen statistic derivation.
- `src/skills` owns portable Agent Skill discovery, manifest validation, precedence, and confined resource reads.
- `src/storage` owns append-only session events, validation, replay, titles, tool cards, and diffs.
- `src/tools` owns structured tool contracts, local execution, and the provider-neutral web-tool adapter.
- `src/web` owns Parallel request serialization, response validation, and error handling.

Keep network transport, persistence, and tool execution outside the UI layer. Keep provider response shapes inside
`src/inference` and `src/web` so the rest of the runtime uses smaller internal models.

## Fireworks boundary

The user supplies a Fireworks API key. Otis sends it only to the Fireworks API in a bearer header and never writes it
to a session or transcript.

Model selection comes from Fireworks' public serverless catalog. Otis filters out every model that does not explicitly
report tool support; unverified model IDs are not accepted through the normal UI. Chat requests use Fireworks'
OpenAI-compatible streaming endpoint and retain text, reasoning content, structured tool calls, tool results, and final
token usage. Verified display-name and context-window metadata are saved with the selection so the context meter and
auto-compaction threshold remain safe for smaller tool-capable models.

Image input is represented as provider-neutral ordered user-content parts. File loading validates the actual image
signature, enforces Fireworks' per-request count and base64-size limits, and places images before text for portability
across supported vision model families. The Fireworks adapter alone converts those parts to `image_url` data URLs.
Catalog-provided image capability is saved with model metadata; both OpenTUI and headless execution reject images
before inference when the selected model lacks that capability. Compaction and title prompts contain attachment
metadata rather than copied base64 data. OpenTUI claims a text paste only when the entire payload parses as one or
more supported shell-escaped image paths; ordinary text continues through the normal editor paste path. Paths are
never evaluated by a shell. The local `read` tool rejects image and binary files instead of decoding them as text.

Reasoning effort is selected by one conservative compatibility policy because Fireworks does not expose a maximum
reasoning tier in its model catalog. Otis requests `max` for documented model families that support it, `high` for
families whose highest accepted tier is `high`, and the provider default for unknown or non-configurable families.
Requests otherwise avoid model-specific sampling and token settings.

Model-provided reasoning is represented as ordered assistant content rather than UI status. The shared runtime assigns
each streamed reasoning block an Otis-owned ID and start/end timing, emits start/delta/end lifecycle events, and keeps
the original Fireworks field so later tool-use requests receive the reasoning context required for interleaved
thinking. Sessions persist the complete block for replay. Display policy is independent: OpenTUI hides thinking by
default and saves the user's `/thinking` visibility preference. Visible blocks render a compact three-line preview
and keep per-block expansion as ephemeral UI state, while headless output includes trace text only when
`--include-reasoning` is explicitly requested. These traces are provider output and may contain sensitive context.

## Local llama.cpp boundary

`/model` lists a curated local catalog above Fireworks. Identities are official Hugging Face checkpoints. GGUF files
come from the model author when they publish GGUF, otherwise from ggml-org or a conversion of those official Instruct
weights. Each row reports a fitted context and memory estimate; models that cannot fit even 64K context stay visible and
unselectable. Context is the largest window that still fits, up to the checkpoint's native length. Memory math uses
each checkpoint's real KV groups (full-attention layers vs sliding-window layers), not a uniform transformer cache.
Hard availability is based on host memory because llama.cpp can split a model between a discrete GPU and system RAM.
The preflight estimate reserves 15% of Apple unified memory (at least 3 GiB), 10% of other system memory (at least
2 GiB), and another 1.5 GiB for runtime buffers. It never requires the complete model to fit in VRAM. On Linux,
`nvidia-smi` detects NVIDIA devices and DRM render nodes detect any other Vulkan-capable GPU, including AMD and Intel.
If no render device is present, Otis uses the CPU build.

Picker and settings rows are a provider-tagged catalog: Fireworks entries may include a Fast serving path; managed-local
entries carry a fitted context and never a `fastId`; PAIR entries carry their endpoint identity. Managed-local rows not
currently serving label that context `Est.`; the active managed-local row receives the context returned by llama.cpp
and labels it `loaded`.

Selecting a runnable local model downloads Otis' pinned llama.cpp `b10622` GitHub release (Metal on Apple Silicon,
Vulkan on Linux with a render device, otherwise CPU) and the selected GGUF into the platform local-data directory.
macOS and Linux on arm64 and x64 are supported; other targets are disabled before selection. Runtime asset sizes and
SHA-256 digests are pinned with the release, and the archive is verified while streaming to disk. Updating the runtime
requires an explicit Otis source change. Existing compatible manifest-v1 and pre-manifest bundles remain usable for
released installations; newly installed bundles record the artifact digest, and obsolete `b*` directories are removed
after the pinned runtime is available.

Each GGUF URL contains an immutable Hugging Face revision. Otis verifies the pinned byte count and Git LFS SHA-256,
publishes the completed file atomically, and records a private sidecar manifest so a verified cache does not need to be
hashed on every launch. Interrupted downloads retain one stable partial file and resume with a validated byte-range
request. A per-model lock serializes concurrent downloads and deletion across Otis processes.

Download percent and a loading state appear next to the model name in the `/model` picker. Local rows already on disk
show `Downloaded` next to the name. Otis then starts `llama-server` on `127.0.0.1` with `--jinja` and without llama.cpp
`--tools`. Chat then uses the same OpenAI-compatible SSE path as Fireworks, without Fireworks-only `service_tier` or
`reasoning_effort` fields. Otis tools remain in the local runtime. `OTIS_LLAMA_SERVER` overrides the bundled binary.
llama.cpp's native fitter is authoritative at startup. Otis passes 1 GiB of fit headroom for a discrete GPU, or the
system-memory headroom for unified-memory and CPU backends, then reads `/props` and persists the context actually
loaded. Layers that do not fit in discrete GPU memory remain in system RAM. Otis also removes inherited `LLAMA_ARG_*`
variables from the child environment so a separate llama.cpp configuration cannot silently alter its managed server.
When cached GGUFs exist, Settings exposes a second-level local-model deletion list. It only targets files in Otis'
model cache, stops Otis' server before deleting the active or final model, and clears an active selection before
offering the model picker again. Inactive model deletion does not interrupt a different active local model.
Interactive `/exit`, Ctrl+C, and SIGINT/SIGTERM wait for `llama-server` to stop before destroying the OpenTUI renderer.
Headless `otis exec` awaits that stop in `finally`.

First-run setup offers local and hosted inference before requesting credentials. Local inference then offers the
existing Otis-managed path and the external PAIR path as separate choices. The managed route opens the hardware-filtered
catalog without a hosted inference API key; the hosted route requests the current provider's key and selects a verified
tool-capable default model. Headless `otis exec --model <local-id>` also does not require a hosted inference API key.
`/settings` can validate and save that key later without replacing the selected local model, connect or reconnect
PAIR, open cached-model deletion when a GGUF is present, and own the ephemeral debug-mode toggle.

## NVIDIA PAIR boundary

PAIR is external, user-managed infrastructure. Otis does not install PAIR, pair nodes together, control engines,
download PAIR models, inspect the PAIR broker, or reproduce its scheduling logic. It connects only to loopback HTTP
endpoints copied from PAIR's Endpoints window. Each proxy exposes the standard OpenAI `/v1/models` and
`/v1/chat/completions` surface for its supported PAIR engine. The Ollama-compatible proxy normally uses port `11434`;
the LM Studio-compatible proxy normally uses `1234`, although PAIR can move either. Otis accepts only `127.0.0.1`,
`localhost`, or `::1`, so it never bypasses PAIR's local ingress boundary by addressing another cluster node directly.

Model discovery uses only PAIR's cluster-aggregated Ollama `/api/tags` and LM Studio `/v1/models` routes. Each
configured field has a known engine, so Otis sends one request to its corresponding inventory route instead of probing
routes to infer the engine. Otis consumes the exact context, quantization, and capabilities currently reported in an
aggregate Ollama record. It does not query LM Studio's native `/api/v1/models` route because PAIR forwards that route to
one scheduled node rather than aggregating it; LM Studio metadata therefore remains unavailable when `/v1/models`
contains only model IDs. The picker labels reported architecture limits as `model max`; they are neither persisted nor
used for compaction. Missing metadata remains `Context unavailable` and `Quant unavailable`. Engine plus model ID is
the stable selection identity, but every PAIR model appears under one NVIDIA PAIR section in the shared model picker.
Internally, PAIR uses the same 64K minimum as managed-local admission solely as a conservative compaction guard while
the routed-node runtime context is unknown; that guard is not represented as model metadata. Duplicate model IDs on
its Ollama and LM Studio routes remain independently selectable.

Selection is transactional but does not send a preflight inference request. Otis creates the normal OpenAI-compatible
client, stops an active Otis-managed local runtime, saves the endpoint and model metadata to private settings, and
activates the prepared selection. A preparation or persistence failure leaves the previous selection and runtime
intact. Actual turns use Otis' local tool definitions, validation, permission policy, and execution; llama.cpp's
built-in `--tools` is still not used. A model that cannot produce compatible tool calls reports that limitation during
the conversation instead of being probed during selection.

PAIR receives one complete inference request and routes it to one eligible engine. It does not split a request across
machines, and it is not a subagent or orchestration layer. The OpenAI-compatible endpoint is deliberately transparent,
so a PAIR proxy and a native compatible server cannot be distinguished through this API alone. Blank endpoint setup
is avoided: setup presents separate Ollama and LM Studio fields pre-filled with the standard ports, then probes both
independently. Copying the addresses from PAIR is the reliable way to select cluster routing when either proxy moves.
Selecting PAIR stops only an Otis-managed `llama-server`, if one is active. Selecting a managed-local model later starts
the original Otis process again. Every verified PAIR endpoint remains available in the shared picker when the active
provider changes; the persisted selected engine resolves its endpoint from the engine-keyed endpoint map.

## Parallel boundary

Web search and page reading call Parallel's Search MCP directly from the local runtime. Otis does not send a Parallel
API key. Requests POST JSON-RPC `tools/call` to `https://search.parallel.ai/mcp`.

Otis keeps its own `web_search` and `web_read` tools. The Parallel adapter maps those to MCP `web_search` and
`web_fetch`, unwraps the MCP text payload, and validates the inner result. Search uses Parallel's basic MCP mode.
Page reads do not request full page content. `session_id` is the Otis session id, truncated to 100 characters, which
Parallel uses as the free-tier rate-limit key. `model_name` is the selected inference model.

The Fireworks API key is not written to sessions, transcripts, tool results, or usage events. Environment values override
saved values without being copied into `config.json`. Keys entered through setup are written atomically to the
platform user-config directory; on macOS and Linux, that directory is mode `0700` and `config.json` is mode `0600`.
This location is separate from the Otis executable, and the updater replaces only that executable.

## Tool calls

The runtime validates provider-native structured tool calls, evaluates every call through a centralized permission
policy, executes approved tools in the local workspace, and appends bounded results to the conversation. The policy
normalizes each call to a tool and resource, merges private user policy with restrictive project policy and temporary
CLI rules, and resolves matching rules deny-first. An `ask` result is sent to the OpenTUI approval surface or denied in
non-interactive execution. Current tools cover skill loading, web search, web reading, file reading, file search, file
creation, exact edits, shell commands, and subagent delegation. Web tools call
Parallel directly; local file and shell tools never pass through a remote Otis service.

The `agent` tool runs a nested, read-only agent loop inside the same process. The child shares the parent's inference
client, workspace, permission policy, approval handler, usage sink, and abort signal, but starts from a fresh history
that contains only the delegated brief. Its tool set is the read-only subset of the parent's tools: file reading and
search, web search and reading, and skill loading. It never receives `write`, `edit`, `bash`, or `agent`, so a
subagent cannot mutate the workspace or delegate again. The child honors the parent's step limit or a fixed default
when the parent has none. Only the child's final assistant text returns to the parent as the tool result; its own
text, reasoning, and context accounting stay private.

The `agent` tool and its system-prompt guidance are offered only for hosted Fireworks models and NVIDIA PAIR
clusters, which can serve several requests at once. Otis' managed `llama-server` runs a single slot, so local models
receive the catalog without `agent`; headless `--tools` can narrow a provider's catalog but never widen it.

Adjacent `agent` calls in one model response run concurrently, and their results are appended in the model's order.
Every other tool call still runs one at a time so workspace mutations stay ordered. The approval surface accepts one
request at a time, so concurrent children take turns when a rule requires approval.

Every child event surfaces through the parent's event stream wrapped in a `subagent` envelope that names the
delegating call and the run's title. The parent's own conversation still receives only the final report, but the
interface can show the whole run. OpenTUI keeps the transcript flat with one agent card per delegation and lists the
session's runs in a right-hand panel whose titles shimmer while they work; selecting a run swaps the conversation for
that run's full trace, rendered by the same transcript view, until Escape or the next prompt returns to the chat. The
panel also hides on narrow terminals and when `/settings subagents` turns it off; that preference is saved locally.
Headless JSONL emits the envelope as `subagent` events with the inner public event,
and plain output indents a child's tool lines beneath the delegation. Each run persists in the turn event as a
subagent record with its title, status, messages, tool cards, and duration, validated against an `agent` tool call in
the turn, so a resumed session can still open every trace; compaction keeps only the records whose delegating call
survives.

OpenTUI starts in `auto` mode unless private user configuration selects another mode. Headless execution keeps its
fail-closed `dontAsk` default and requires `--auto` or an explicitly configured auto mode for unmatched mutations.

Shell resources are currently matched against the complete command string. Patterns are anchored and Otis does not
split compound commands at shell control operators for deny matching. For example, `bash(rm -rf *)` matches a command
that begins with `rm -rf`, but does not match `cd /tmp && rm -rf x`. Allow-rule wildcards cannot cross shell control
operators, but explicit deny rules in permissive modes should use a broader pattern when compound commands must be
covered. Per-command-segment policy evaluation is a future hardening boundary.

## Agent Skills

Interactive and headless execution share one Agent Skills catalog. Otis discovers global skills under
`~/.agents/skills` and project skills under `.agents/skills` at each ancestor of the working directory. Sources are
applied global-first and root-first, with the nearest project definition winning on duplicate names. Every discovered
`SKILL.md` is parsed as YAML plus Markdown and validated against the portable name and description constraints before
inference begins.

The provider-independent `otis skills` command manages optional Git-backed sources without initializing OpenTUI or
inference. Each source has a private checkout under the platform local-data directory and an atomic manifest recording
the skill activations it owns. Install validates the complete source before creating activation symlinks under
`~/.agents/skills`; collisions fail without replacing existing content. Update permits fast-forward-only pulls and
rolls the checkout, links, and manifest back if validation or activation fails. Remove first verifies ownership and
never deletes an activation replaced by another process. A process lock serializes lifecycle operations, and provider
credentials are removed from the environment of Git subprocesses.

Prompt assembly advertises only validated names and descriptions. The `skill` structured tool loads the full
instructions or a requested text resource on demand, preserving progressive disclosure and allowing global skills to
work without expanding the workspace file tool's sandbox. Canonical-path checks keep resource reads inside the chosen
skill even through symlinks. Script execution remains a normal `bash` call and therefore passes through the same
permission policy as any other command; skill metadata cannot pre-approve tools. If tool selection disables `skill`,
skill metadata is not advertised to the model.

## Sessions and local statistics

The agent checks context before every model request, including requests within a tool loop and after steering input.
The trigger is 80% of the serving context, capped at 250,000 tokens; unknown context uses the 250,000-token fallback.
Hosted and managed-local models use their configured serving context, while PAIR uses its separate conservative
65,536-token policy budget. A completed task waits until the next request before compacting.

The runtime and context meter share one estimator, including the assembled system prompt, tool definitions, native
reasoning, and tool history. During an active run, the last request's reported prompt and completion usage informs
context checks, with estimates for newly added content. New turns, reopened sessions, and freshly compacted history
use character estimates until the next response reports usage. Token accounting adds no metadata to chat messages.

Compaction targets half the trigger budget, retains a bounded suffix of complete tool exchanges, and preserves
unanswered user messages. A summary is accepted only when it reduces context, fits the target, and has not reported an
incomplete finish. Oversized histories are summarized in bounded chunks. Provider errors surface without automatic
compaction retries. A failed summary leaves the original history unchanged.

An active-turn compaction saves a `compacted` checkpoint before inference continues. Its prompt ID associates later
completion or interruption with the continuation; its admission sequence and consumed steering count preserve queued
prompts and steering received during summarization. Live transcripts and replay use the same checkpoint plus
continuation messages. Compaction usage and child-agent checkpoints remain separate from the parent's context.

Each session is an append-only JSONL event stream. A completed turn stores model-facing messages separately from local
tool-card metadata, which preserves diffs and activity history without placing UI state into future model requests.
Image bytes are stored inline as base64 in the same private local session stream so resumed turns preserve native
multimodal history without a second mutable attachment store. Provider request limits bound each admitted image turn.
Headless processes take an exclusive lock while resuming a session so concurrent workers cannot append turns with the
same sequence numbers. Ephemeral headless turns bypass session persistence entirely.

## Headless execution

`otis exec` is a one-turn process interface over the same shared application and agent loop used by OpenTUI. Its plain mode
reserves stdout for the final assistant message and sends progress to stderr. JSON mode emits one result object; JSONL
mode emits versioned, Otis-owned events rather than exposing provider stream shapes. The command accepts explicit
working-directory, model, tool-allowlist, step-limit, timeout, and session policies, making process invocation the
stable boundary for CI and server workers.

Headless execution never prompts. Write, edit, and shell calls are denied by default and require an allow rule, a
configured auto default, or the explicit `--auto` policy. Explicit deny rules remain effective in auto mode. This
approval policy is separate from OS sandboxing; a future sandbox can be added at the tool-executor boundary
without changing command output or session contracts.

Every completed inference request that reports usage adds a validated `usage_recorded` event before the surrounding
agent turn, title generation, or compaction operation continues. Home-screen totals are calculated across local
workspace session directories. Session counts, durations, and activity streaks are also derived from those local event
timestamps.

The home-screen stats row is absent until at least one provider credential is available. Once visible, every card has
a stable label and displays zero until enough local session data exists to calculate a non-zero value.

The event parser remains backward-compatible with sessions written before local usage events and reasoning trace
identity/timing metadata were introduced.

## Distribution

GitHub Actions verifies and cross-compiles the four supported targets. Versioned archives, checksums, the manifest, and
installer are published as GitHub Release assets. `otis update` resolves the latest or requested release there and
verifies the archive checksum before replacing the installed binary.
