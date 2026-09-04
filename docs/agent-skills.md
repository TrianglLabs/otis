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

Personal skills load first. Repository skill directories then load from the filesystem root toward the current working
directory, so the nearest project definition wins when names collide.

## Install a Git-backed collection

Manage shared skill repositories without starting OpenTUI:

```sh
otis skills install https://github.com/obra/superpowers
otis skills list
otis skills update superpowers
otis skills remove superpowers
```

An installed repository may contain one skill at its root, a `skills/*` collection, an `.agents/skills/*` collection,
or a combination of those layouts. Use `--name <source-name>` when the repository name is not the desired local source
name.

Otis keeps an isolated Git checkout in its private data directory and activates discovered skills with links under
`~/.agents/skills`. Installation never replaces an existing skill. Updates are fast-forward-only and transactional;
removal touches only links still owned by Otis. Restart a running Otis process after installing, updating, or removing
a source.

## Trust and confinement

Review third-party skills before installing them. Skill resources are confined to the skill's canonical directory;
path traversal and escaping symlinks are rejected, and text resources must be UTF-8.

Bundled scripts are not implicitly trusted. The model runs them through the normal `bash` tool, subject to the same
permission policy as any other command. The experimental `allowed-tools` frontmatter field does not bypass Otis
permissions.

For discovery and activation internals, see the [Agent Skills architecture](architecture.md#agent-skills).
