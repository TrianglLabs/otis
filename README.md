<!-- LOGO -->

<h1>
<p align="center">
  <img src="resources/icon.png" alt="Otis" width="128">
  <br>Otis
</h1>
  <p align="center">
    Your personal AI agent, powered by open models.
    <br />
    <a href="#why-otis">About</a>
    ·
    <a href="#install">Download</a>
    ·
    <a href="#documentation">Documentation</a>
    ·
    <a href="CONTRIBUTING.md">Contributing</a>
  </p>
</p>

<p align="center">
  <img src="docs/otis-gui.png" alt="Otis desktop interface" width="720">
</p>

Otis is an open-source personal AI agent with a native desktop app, an OpenTUI terminal interface, and a headless mode
for scripts and CI. Use it for everyday work, from planning a trip and drafting an email to exploring a codebase and
fixing a bug. Otis can inspect files, edit code, run commands, search the web, and delegate focused work to subagents.

Otis makes local models easy to run. During setup it recommends a model for your hardware, downloads it, and runs it
through llama.cpp. With a local model, Otis works fully offline: there is no account, telemetry, hosted control plane,
or cloud synchronization, and your configuration and history stay on disk.

If you have additional NVIDIA hardware on your network, Otis can connect to an
[NVIDIA PAIR](https://github.com/NVIDIA/Personal-AI-Router) cluster. When you want a larger open-weight model, it can
also connect directly to Fireworks with your own API key; Fireworks documents Zero Data Retention for open-model
inference by default.

## Install

Otis supports macOS and Linux on arm64 and x64.

### Desktop app

Download Otis for macOS or Linux from [triangllabs.ai/otis](https://triangllabs.ai/otis). Every desktop build is also
available from [GitHub Releases](https://github.com/TrianglLabs/otis/releases/latest).

### Terminal

```sh
curl -fsSL https://github.com/triangllabs/otis/releases/latest/download/install.sh | bash
otis
```

Update an existing CLI installation with:

```sh
otis update
```

## Why Otis

- **Your machine, your state.** Configuration, sessions, tool activity, diffs, and usage statistics stay local.
- **Your choice of open model.** Use an Otis-managed GGUF, let PAIR route across your computers, or use Fireworks
  serverless when you want hosted performance.
- **Desktop, terminal, or automation.** Use the native desktop app, the OpenTUI interface, or headless mode with the
  same agent behavior and local sessions.
- **Focused delegation.** Otis can hand off exploration and research to subagents whose work remains inspectable.
- **Direct provider connections.** Hosted inference goes directly to Fireworks with your API key; web access goes
  directly to Parallel's Search MCP.
- **Inspectable history.** Append-only JSONL sessions preserve messages, tool cards, diffs, and provider-reported usage.

## How it works

```txt
Desktop app / OpenTUI terminal / headless CLI
  └─ Otis shared application runtime
      ├─ Conversation lifecycle, tools, permissions, and subagents
      ├─ Private local configuration, sessions, diffs, and stats
      ├─ llama.cpp ── Otis-managed local GGUF inference
      ├─ NVIDIA PAIR ── routing across your local AI cluster
      ├─ Fireworks API ── hosted inference and model discovery
      └─ Parallel Search MCP ── web search and page reading
```

## Get started

Open the desktop app or run `otis`, complete first-time setup, and choose where Otis thinks.

### Local inference

Local inference offers two independent paths:

- **This machine** opens a hardware-aware catalog, downloads a curated and checksum-verified GGUF, and runs it through
  an Otis-managed `llama-server` on `127.0.0.1`.
- **NVIDIA PAIR** connects to PAIR's Ollama or LM Studio proxy on this computer. PAIR then routes each complete request
  to an eligible computer in your cluster.

Neither path requires a hosted inference API key. For a good managed-local experience, use Apple silicon with at least
24 GB of unified memory, or Linux with at least 24 GB of RAM. A Vulkan-capable GPU improves Linux performance.

PAIR is installed and managed separately. Otis pre-fills PAIR's standard loopback addresses; replace either one if the
PAIR Endpoints window shows a custom port. At least one working endpoint is enough. See [NVIDIA PAIR](docs/nvidia-pair.md)
for setup, routing, and model-metadata behavior.

### Hosted inference

Hosted inference uses your own Fireworks API key and has no local hardware requirement. Setup opens the key page and
continues with a public serverless model that Fireworks marks as tool-capable.

| Provider | Used for | Get a key |
| --- | --- | --- |
| Fireworks | Model discovery, inference, streaming, reasoning, and tool calling | [Fireworks API keys](https://app.fireworks.ai/api-keys) |

You can enter the key during setup or provide it through the environment:

```sh
export FIREWORKS_API_KEY=fw_your_key
otis
```

Open `/model` at any time to switch between managed-local, configured PAIR, and hosted models in one picker. The active
model label identifies local models with `Local` and routed models with `NVIDIA PAIR`.

## Terminal commands

The OpenTUI interface supports these commands and controls:

| Command | Action |
| --- | --- |
| `/home` | Return to the home screen |
| `/new` | Start a new session |
| `/history` | Browse, open, or delete local sessions |
| `/model` | Choose a managed-local, PAIR, or hosted model |
| `/settings` | Configure Fireworks or PAIR, delete local models, or toggle debug mode |
| `/fast` | Toggle Fast serving when the current model supports it |
| `/compact [instructions]` | Summarize older conversation and free context |
| `/thinking` | Toggle model-provided thinking traces |
| `/exit` | Exit Otis |

| Control | Action |
| --- | --- |
| `Tab` | Toggle automatic execution and permission prompts |
| `Esc` | Interrupt the active model turn |
| `Ctrl+C` | Exit |

Drag text files, PDFs, DOCX documents, or images into the terminal to attach them to the next message. Otis recognizes
the shell-escaped paths emitted by common macOS and Linux terminals; terminals that expose binary clipboard data can
also attach copied images directly. Numbered tokens appear in the composer, Backspace removes the last attachment when
the input is empty, and attachments clear after the prompt enters the session. Only image attachments require a vision
model.

## Headless execution

Use `otis exec` in scripts, CI jobs, containers, or server workers. It runs the same agent turn engine without starting
OpenTUI.

```sh
otis exec "Explain this repository"
otis exec --continue --auto "Run the tests and fix the failure"
otis exec --image screenshot.png "Explain this error"
otis exec --file requirements.pdf --file notes.docx "Compare these documents"
```

Plain output reserves stdout for the final response. JSON and streaming JSONL are available for programmatic use.
Headless mode never prompts and denies unmatched write, edit, and shell calls unless policy or `--auto` permits them.
Run `otis exec --help` or read [Headless execution](docs/headless.md) for formats, sessions, limits, permissions, and
file attachments.

## Local data and privacy

Otis writes private configuration and append-only sessions to standard platform user directories. Set `OTIS_HOME` to
keep all state under one location. Provider keys are never written to sessions, transcripts, tool results, or usage
records.

Managed inference stays on loopback. Hosted prompts go directly to Fireworks, which documents Zero Data Retention for
open-model inference by default unless the user opts in; service metadata such as token counts may still be recorded.
Web requests go directly to Parallel, and PAIR owns traffic within the user's cluster.

Read [Local data and privacy](docs/data-and-privacy.md) for paths and retention details, [the architecture guide](docs/architecture.md)
for complete runtime boundaries, and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Documentation

- [Desktop app and downloads](https://triangllabs.ai/otis) — native macOS and Linux builds
- [Managed local inference](docs/local-inference.md) — hardware fit, downloads, context, and model deletion
- [NVIDIA PAIR](docs/nvidia-pair.md) — endpoint setup, routing, inventory, and metadata
- [Headless execution](docs/headless.md) — output formats, limits, sessions, and attachments
- [Agent Skills](docs/agent-skills.md) — authoring, precedence, Git-backed collections, and trust
- [Tool permissions](docs/tool-permissions.md) — modes, rule syntax, and policy precedence
- [Local data and privacy](docs/data-and-privacy.md) — storage, secrets, sessions, and network boundaries
- [Architecture](docs/architecture.md) — implementation ownership and runtime boundaries

## Development

[Bun](https://bun.sh/) is the runtime and package manager.

```sh
git clone https://github.com/TrianglLabs/otis.git
cd otis
bun install --frozen-lockfile
bun run dev          # OpenTUI terminal interface
bun run dev:desktop  # Desktop app
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for source boundaries, testing guidance, and the verification checklist.

## License

Otis is released under the [MIT License](LICENSE). Copyright © 2026 Triangl Labs.

The terminal interface is built with [OpenTUI](https://github.com/anomalyco/opentui). Otis-managed local inference uses
[llama.cpp](https://github.com/ggml-org/llama.cpp); PAIR remains a separately installed application. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled third-party license notices.
