# Headless execution

`otis exec` runs one agent task without initializing OpenTUI. It uses the same shared application, model clients,
agent loop, tools, permissions, sessions, and compaction behavior as the interactive terminal.

## Examples

```sh
otis exec "Explain this repository"
printf '%s\n' "Review the supplied context" | otis exec --ephemeral --output-format json
otis exec --continue --auto "Run the tests and fix the failure"
otis exec --image screenshot.png "Explain this error"
```

Run `otis exec --help` for the complete option list.

## Output formats

- `plain` writes only the final assistant response to stdout and sends progress to stderr.
- `json` writes one result object.
- `jsonl` streams versioned Otis events and finishes with a result event.

Model-provided reasoning is omitted unless `--include-reasoning` is passed. With that option, JSON includes completed
traces and JSONL emits structured reasoning lifecycle events.

## Permissions and execution limits

Headless mode never displays an approval prompt. It defaults to `dontAsk`, so unmatched write, edit, and shell calls
are denied. Pass `--auto`, configure auto mode, or add a matching `--allow` rule to permit them. Explicit deny rules
remain effective in auto mode.

Use repeatable `--allow`, `--ask`, and `--deny` flags for one-run rules. `ask` fails closed in headless mode because
there is no approval interface. Use `--tools` to narrow the available tools, `--max-steps` to bound the agent loop, and
`--timeout` to set a wall-clock limit. See [Tool permissions](tool-permissions.md) for rule syntax and precedence.

## Sessions

By default, a completed run is stored in the same local session format as an interactive turn.

- `--continue` resumes the latest session for the working directory.
- `--session <id>` resumes a specific session.
- `--ephemeral` prevents the run from writing a local session.

Processes take an exclusive lock while resuming a session so concurrent workers cannot append duplicate sequence
numbers.

## Images

Use repeatable `--image <path>` options to attach PNG, JPEG, GIF, BMP, TIFF, or PPM files. The selected model must be
identified as vision-capable by its catalog or inventory metadata.

For the process contract and event model, see the [headless architecture](architecture.md#headless-execution).
