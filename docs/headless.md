# Headless execution

`otis exec` runs one agent task without initializing OpenTUI. It uses the same shared application, model clients,
agent loop, tools, permissions, sessions, and compaction behavior as the interactive terminal.

## Examples

```sh
otis exec "Explain this repository"
printf '%s\n' "Review the supplied context" | otis exec --ephemeral --output-format json
otis exec --continue --auto "Run the tests and fix the failure"
otis exec --image screenshot.png "Explain this error"
otis exec --file report.pdf --file notes.docx "Compare these files"
```

Run `otis exec --help` for the complete option list.

## Output formats

- `plain` writes only the final assistant response to stdout and sends progress to stderr.
- `json` writes one result object.
- `jsonl` streams versioned Otis events and finishes with a result event.

Model-provided reasoning is omitted unless `--include-reasoning` is passed. With that option, JSON includes completed
traces and JSONL emits structured reasoning lifecycle events.

## Permissions and execution limits

Headless mode never displays an approval prompt. It defaults to `dontAsk`, so unmatched `write`, `edit`,
`edit_document`, `document` (except `check`), `save_attachment`, and `bash` calls are denied. Pass `--auto`, configure auto mode, or add a matching `--allow` rule to
permit them. Explicit deny rules
remain effective in auto mode.

Use repeatable `--allow`, `--ask`, and `--deny` flags for one-run rules. `ask` fails closed in headless mode because
there is no approval interface. Use `--tools` to narrow the available tools and `--timeout` to set an optional wall-clock
limit. Runs have no fixed model-step limit. See [Tool permissions](tool-permissions.md) for rule syntax and precedence.

## Sessions

By default, a completed run is stored in the same local session format as an interactive turn.

- `--continue` resumes the latest session for the working directory.
- `--session <id>` resumes a specific session.
- `--ephemeral` prevents the run from writing a local session.

Processes take an exclusive lock while resuming a session so concurrent workers cannot append duplicate sequence
numbers.

## Attachments

Use repeatable `--image <path>` options to attach PNG, JPEG, GIF, BMP, TIFF, or PPM files. The selected model must be
identified as vision-capable by its catalog or inventory metadata.

Use repeatable `--file <path>` options for images, UTF-8 text and source files, text-bearing PDFs, and modern Word `.docx`
documents. Document attachments work with text-only models: Otis keeps the original local bytes in the session and
sends locally extracted text to the selected model. Legacy `.doc` files and scanned PDFs without an embedded text
layer are rejected; scanned PDF OCR is not yet supported.

For the process contract and event model, see the [headless architecture](architecture.md#headless-execution).
