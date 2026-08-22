# Architecture

## Overview

Otis is a local terminal application with direct hosted inference.

```txt
User terminal or server process
  -> OpenTUI CLI or headless command
    -> shared local TypeScript turn runtime
      -> local tools
      -> local Agent Skills
      -> local JSONL sessions and usage
      -> Fireworks API with the user's key
      -> Parallel Search MCP
```

There is no Otis control plane. Users do not create an Otis account, and the runtime has no dependency on an Otis
server, remote profile, cloud database, or Otis-hosted tool service.

## Source boundaries

```txt
src/cli
  +-> src/core ------> src/inference
  |      +----------> src/tools
  |                       +------> src/web
  +-> src/skills -----> local skill packages
  +-> src/local -----> src/storage
  +-> src/storage ---> src/core message types
```

- `src/cli` owns command routing, the UI-neutral turn coordinator, headless output adapters, application state, and
  OpenTUI rendering. Headless commands do not initialize OpenTUI.
- `src/core` owns the agent loop, project instruction loading, and conversation compaction.
- `src/inference` owns Fireworks request serialization, model discovery, the human-authored `system-prompt.txt`, prompt
  assembly and project-context bounds, and SSE parsing.
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

## Parallel boundary

Web search and page reading call Parallel's Search MCP directly from the local runtime. Otis does not send a Parallel
API key. Requests POST JSON-RPC `tools/call` to `https://search.parallel.ai/mcp`.

Otis keeps its own `web_search` and `web_read` tools. The Parallel adapter maps those to MCP `web_search` and
`web_fetch`, unwraps the MCP text payload, and validates the inner result. Search uses Parallel's basic MCP mode.
Page reads do not request full page content. `session_id` is the Otis session id, truncated to 100 characters, which
Parallel uses as the free-tier rate-limit key. `model_name` is the selected Fireworks model.

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
creation, exact edits, and shell commands. Web tools call
Parallel directly; local file and shell tools never pass through a remote Otis service.

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

Each session is an append-only JSONL event stream. A completed turn stores model-facing messages separately from local
tool-card metadata, which preserves diffs and activity history without placing UI state into future model requests.
Image bytes are stored inline as base64 in the same private local session stream so resumed turns preserve native
multimodal history without a second mutable attachment store. Provider request limits bound each admitted image turn.
Headless processes take an exclusive lock while resuming a session so concurrent workers cannot append turns with the
same sequence numbers. Ephemeral headless turns bypass session persistence entirely.

## Headless execution

`otis exec` is a one-turn process interface over the same coordinator and agent loop used by OpenTUI. Its plain mode
reserves stdout for the final assistant message and sends progress to stderr. JSON mode emits one result object; JSONL
mode emits versioned, Otis-owned events rather than exposing provider stream shapes. The command accepts explicit
working-directory, model, tool-allowlist, step-limit, timeout, and session policies, making process invocation the
stable boundary for CI and server workers.

Headless execution never prompts. Write, edit, and shell calls are denied by default and require an allow rule, a
configured auto default, or the explicit `--auto` policy. Explicit deny rules remain effective in auto mode. This
approval policy is separate from OS sandboxing; a future sandbox can be added at the tool-executor boundary
without changing command output or session contracts.

Every completed Fireworks request that reports usage adds a validated `usage_recorded` event before the surrounding
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
