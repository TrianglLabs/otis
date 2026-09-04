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

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` are respected on Linux. Set `OTIS_HOME` to keep all Otis state in one specific
directory.

Configuration is written atomically. On macOS and Linux, its directory uses mode `0700` and `config.json` uses mode
`0600`. State lives outside the executable and survives `otis update`.

## Sessions and secrets

Sessions are append-only JSONL event streams. They retain messages, tool cards, diffs, titles, provider-reported token
usage, and attached image data so a resumed conversation preserves its history.

Provider keys are never written to sessions, transcripts, tool results, or usage records. A `FIREWORKS_API_KEY`
environment value overrides a saved key without being copied into `config.json`.

Model-provided thinking is assistant history and is retained in local sessions even when hidden in the UI. Treat it as
potentially sensitive. Visible traces show a short preview and can be expanded in OpenTUI.

## Network boundaries

- Hosted prompts go directly from Otis to Fireworks using the user's API key. Fireworks states that open-model
  inference uses Zero Data Retention by default unless the user opts in; service metadata such as token counts may
  still be recorded.
- NVIDIA PAIR traffic goes to a loopback proxy. PAIR owns communication and routing within the user's cluster.
- Web search and page reading go directly to Parallel's Search MCP from the local runtime.
- Managed llama.cpp inference stays on `127.0.0.1`.

Read the [Fireworks Zero Data Retention policy](https://docs.fireworks.ai/guides/security_compliance/data_handling),
the [architecture guide](architecture.md) for complete runtime boundaries, and [SECURITY.md](../SECURITY.md) for private
vulnerability reporting.
