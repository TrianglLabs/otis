# Agent Skills

Otis implements the open [Agent Skills specification](https://agentskills.io/specification) in both interactive and
headless execution.

## Create a skill

Place personal skills in `~/.agents/skills/<name>/SKILL.md` and repository skills in
`.agents/skills/<name>/SKILL.md`. The directory name must match the skill name.

```txt
.agents/skills/release-notes/
├── SKILL.md
├── references/
│   └── STYLE.md
├── scripts/
│   └── collect-changes.ts
└── assets/
    └── template.md
```

```md
---
name: release-notes
description: Prepare release notes from shipped changes. Use for release summaries and changelogs.
---

# Release notes workflow

Read `references/STYLE.md`, then run `scripts/collect-changes.ts` if change discovery is required.
```

Otis validates the YAML frontmatter at startup. It initially gives the model only each skill's name and description.
When a task matches, the model uses the read-only `skill` tool to load the full instructions and any referenced text
resources it needs.

## Run a skill yourself

Type `/<name>` followed by any arguments, in the terminal or the desktop composer, to run a skill on purpose: the
model receives the skill's instructions with the arguments in place of `$ARGUMENTS` (or appended when the skill has
no placeholder), and the transcript shows the command as you typed it. Both composers complete skill names after a
slash; a built-in command such as `/skills` keeps its name over a skill called the same.

Two frontmatter switches, shared with Claude Code and Cursor, decide who may start a skill:

- `disable-model-invocation: true` keeps the skill out of the model's offer, so only your `/<name>` runs it. The
  skill still loads by name through the `skill` tool, so a skill that points at it keeps working. Settings marks
  such a skill **Manual**.
- `user-invocable: false` keeps the skill off your `/` menu, so only the model picks it.

A skill switched off in Settings is neither offered nor runnable.

Bundled skills load first, followed by personal skills. Repository skill directories then load from the filesystem root toward the current working
directory, so the nearest project definition wins when names collide.

## Bundled document workflow

Otis includes a first-party `documents` skill for PDF and DOCX deliverables. It is embedded in both CLI and desktop
releases and advertised without writing files at startup. Loading it materializes its instructions and helpers under
`<Otis data directory>/bundled-skills/<content revision>/documents`, with private permissions. Cached files must match
the release's embedded content; modified resources are rejected. A personal or project skill named `documents` can
explicitly override it. The `otis skills` management commands list and manage Git-backed collections, not this bundle.

Loading the skill does not execute scripts or install dependencies. The structured `document` tool runs its fixed
helpers and prepares their private environment under its own permission policy. Project skills can override the
instructions, but cannot replace the code that this tool executes. See [Document workflows](document-workflows.md).

## Install a Git-backed collection

Manage shared skill repositories without starting OpenTUI:

```sh
otis skills install https://github.com/obra/superpowers
otis skills list
otis skills update superpowers
otis skills remove superpowers
```

An installed repository may contain one skill at its root, skill directories at its root, a `skills/*` collection, an
`.agents/skills/*` collection, or a combination of those layouts; a directory in a collection that is not a valid
skill is skipped. An [Agent Plugin](https://agent-plugins.org) installs the same way: its `skills/` folder is read
by layout, and its `plugin.json` name, version, and description are recorded and shown with the source. A plugin's
`mcp.json` is not supported; Otis has no general MCP client. A folder link such as `https://github.com/cursor/plugins/tree/main/pstack` installs only that
folder of the repository, so suites such as [gstack](https://github.com/garrytan/gstack) and
[pstack](https://github.com/cursor/plugins/tree/main/pstack) install as they are published. Use
`--name <source-name>` when the repository name is not the desired local source name.

Otis keeps an isolated Git checkout in its private data directory and activates discovered skills with links under
`~/.agents/skills`. Installation never replaces an existing skill. Updates are fast-forward-only and transactional;
removal touches only links still owned by Otis. Restart a running terminal session after installing, updating, or
removing a source from the command line.

In the desktop app, Settings → Extensions lists every loaded skill with where it comes from, and installs, updates, or
removes Git collections; in the terminal, `/skills` does the same. Both reread the skills on disk, so a skill you add
by hand is available from the next turn without a restart.

## Trust and confinement

Review third-party skills before installing them. Skill resources are confined to the skill's canonical directory;
path traversal and escaping symlinks are rejected, and text resources must be UTF-8.

Arbitrary skill scripts run through the normal `bash` tool, subject to the same
permission policy as any other command. The experimental `allowed-tools` frontmatter field does not bypass Otis
permissions.

For discovery and activation internals, see the [Agent Skills architecture](architecture.md#agent-skills).
