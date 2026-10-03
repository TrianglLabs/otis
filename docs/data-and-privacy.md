# Local data and privacy

Otis is locally controlled. It has no product account, hosted control plane, cloud usage database, telemetry backend,
or synchronization dependency. Configuration, session history, tool activity, diffs, and usage statistics live on the
computer running Otis.

## Storage locations

By default, Otis uses the platform's standard user directories:

| Data | macOS | Linux |
| --- | --- | --- |
| Configuration | `~/Library/Application Support/otis/config.json` | `~/.config/otis/config.json` |
| Sessions and usage | `~/Library/Application Support/otis/` | `~/.local/share/otis/` |
| Managed skill sources | `~/Library/Application Support/otis/skills/` | `~/.local/share/otis/skills/` |
| Memory that holds everywhere | `~/Library/Application Support/otis/memory.md` | `~/.local/share/otis/memory.md` |
| Memory for one workspace | `~/Library/Application Support/otis/sessions/<workspace>/memory.md` | `~/.local/share/otis/sessions/<workspace>/memory.md` |

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` are respected on Linux. Set `OTIS_HOME` to keep all Otis state in one specific
directory.

Configuration is written atomically. On macOS and Linux, its directory uses mode `0700` and `config.json` uses mode
`0600`. State lives outside the executable and survives `otis update`.

On Omarchy, Otis also keeps one record for the desktop's agents bar panel at
`~/.local/state/omarchy/agents/usage/otis.json` (under `XDG_STATE_HOME` when set). It holds prompt and session
counts, token totals by day and by model name, and whether models ran locally, hosted, or both, derived from local
sessions after each turn. It contains no conversation content or keys and is written only when the `omarchy` state
directory exists.

## Sessions and secrets

Sessions are append-only JSONL event streams. They retain messages, tool cards, diffs, titles, provider-reported token
usage, and attached image or document source data so a resumed conversation preserves its history. Document sources
are stored locally with their extracted text and SHA-256 identity. The original PDF or DOCX bytes are not sent through
the portable model request path; Otis sends the locally extracted text and bounded metadata, including the source
SHA-256 used to distinguish attachments with the same filename, instead. That extracted
content is still part of the hosted prompt when a hosted model is selected.

Canvas previews and exports read workspace files through their resolved path and refuse symlinks that leave the
workspace. A hard link inside the workspace to a file outside it is indistinguishable from an ordinary file and is
read as workspace content; this is a known limitation of path-based checks.

Saving an attachment for editing creates a separate private workspace file under the normal write policy. Bundled
document helpers process files locally and do not call a document API. Installing their optional Python dependencies
uses the Python package index; loading the skill alone performs no installation or network request.

Provider keys are never written to sessions, transcripts, tool results, or usage records. A `FIREWORKS_API_KEY`,
`TOGETHER_API_KEY`, `BASETEN_API_KEY`, or `PRIME_API_KEY` environment value overrides the saved key for that provider
without being copied into `config.json`. The managed `llama-server` child and
its device probe receive an allowlisted environment; Hugging Face tokens and provider keys are never forwarded to them.

Model-provided thinking is assistant history and is retained in local sessions even when hidden in the UI. Treat it as
potentially sensitive. Visible traces show a short preview and can be expanded in OpenTUI.

## Network boundaries

- Hosted prompts go directly from Otis to the selected provider (Fireworks, Together AI, Baseten, or Prime Intellect)
  using the user's key for that provider; a key is sent only to its own provider. Fireworks states that open-model
  inference uses Zero Data Retention by default unless the user opts in; service metadata such as token counts may
  still be recorded. Prime Intellect's gateway models route to third-party model vendors under Prime Intellect's
  terms. Check each provider's data policy before sending sensitive content.
- NVIDIA PAIR traffic goes to a loopback proxy. PAIR owns communication and routing within the user's cluster.
- Web search and page reading go directly to Parallel's Search MCP from the local runtime.
- Managed llama.cpp inference stays on `127.0.0.1`.

Read the [Fireworks Zero Data Retention policy](https://docs.fireworks.ai/guides/security_compliance/data_handling)
and the data policies of [Together AI](https://www.together.ai/privacy),
[Baseten](https://www.baseten.co/privacy-policy), and [Prime Intellect](https://www.primeintellect.ai/privacy-policy),
the [architecture guide](architecture.md) for complete runtime boundaries, and [SECURITY.md](../SECURITY.md) for private
vulnerability reporting.
