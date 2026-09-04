# Tool permissions

Otis evaluates every structured tool call through one permission policy shared by OpenTUI and `otis exec`. A rule
matches a tool and its primary resource: a shell command, workspace-relative path, URL, or search query.

## Effects and modes

Matching effects are resolved in this order:

1. `deny`
2. `ask`
3. `allow`

Rules support `*` and `?` wildcards. Shell allow-rule wildcards do not cross control operators, command substitutions,
or redirections, so authorize compound commands explicitly.

The available modes are:

- `ask`: request approval for unmatched mutating calls in OpenTUI; fail closed in headless execution.
- `auto`: allow unmatched write, edit, and shell calls. Explicit deny rules still apply.
- `dontAsk`: deny unmatched mutating calls without prompting.

Interactive Otis defaults to `auto`; press Tab to switch between automatic execution and approval prompts. `otis exec`
defaults to `dontAsk` and never prompts. Read-only tools are allowed by default in both interfaces.

## User configuration

User rules live in Otis's private `config.json`:

```json
{
  "version": 1,
  "permissions": {
    "defaultMode": "auto",
    "rules": [
      { "tool": "bash", "resource": "git status", "effect": "allow" },
      { "tool": "bash", "resource": "git push *", "effect": "ask" },
      { "tool": "read", "resource": "*.env", "effect": "deny" }
    ]
  }
}
```

## Project and one-run rules

A repository may add `.otis/permissions.json` with `{ "version": 1, "rules": [...] }`. Project rules may use only
`ask` or `deny`, so opening a repository cannot silently grant itself access.

For a single headless run, pass repeatable rules using `tool(resource)` syntax:

```sh
otis exec --allow 'bash(git status)' --deny 'read(*.env)' "Inspect the project"
```

Temporary CLI rules combine with user and project policy under the same deny-first precedence. See
[Headless execution](headless.md) for the other process controls and the [tool-call architecture](architecture.md#tool-calls)
for implementation boundaries.
