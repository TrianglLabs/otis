import { readFile, realpath } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { resolveArtifactSource } from "../artifacts/files.js"
import { TOOL_NAMES, type ToolCall, type ToolName } from "../tools/index.js"
import { editedDocumentPath, resolveWorkspacePath } from "../tools/workspace.js"

const PERMISSION_EFFECTS = ["allow", "ask", "deny"] as const
type PermissionEffect = (typeof PERMISSION_EFFECTS)[number]

const PERMISSION_MODES = ["ask", "auto", "dontAsk"] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto"

export type PermissionRule = {
  tool: ToolName | "*"
  resource?: string
  effect: PermissionEffect
}

export type PermissionConfig = {
  defaultMode?: PermissionMode
  rules: PermissionRule[]
}

type PermissionDecision = {
  effect: PermissionEffect
  resources: string[]
  rule?: PermissionRule
  /** Bind publication to the canonical file checked before an asynchronous approval. */
  artifactPath?: string
}

export type PermissionRequest = {
  call: ToolCall
  decision: PermissionDecision
}

export type PermissionPolicy = {
  evaluate(call: ToolCall): Promise<PermissionDecision>
}

type PermissionPolicyOptions = {
  cwd: string
  mode: PermissionMode
  rules?: PermissionRule[]
}

const RESTRICTED_BY_DEFAULT = new Set<ToolName>([
  "bash",
  "write",
  "edit",
  "edit_document",
  "document",
  "save_attachment",
])
const PRECEDENCE = ["deny", "ask", "allow"] as const

export function createPermissionPolicy(options: PermissionPolicyOptions): PermissionPolicy {
  const rules = (options.rules ?? []).map((rule) => ({
    rule,
    tool: compilePattern(rule.tool),
    resource: compilePattern(rule.resource ?? "*"),
    shellResource: compilePattern(rule.resource ?? "*", { shellSafeWildcard: true }),
  }))
  return {
    async evaluate(call) {
      const source =
        call.name === "publish_artifact"
          ? await resolveArtifactSource(call.input.path, options.cwd)
          : undefined
      const resources = source?.resources ?? (await permissionResources(call, options.cwd))
      // Publishing an external file needs approval even in auto mode; readiness checks never do.
      const mode = source?.external && options.mode === "auto" ? "ask" : options.mode
      const restricted =
        source?.external ||
        (RESTRICTED_BY_DEFAULT.has(call.name) &&
          !(call.name === "document" && call.input.operation === "check"))
      const fallback: PermissionEffect =
        !restricted || mode === "auto" ? "allow" : mode === "dontAsk" ? "deny" : "ask"
      const decisions = resources.map(
        (resource): { effect: PermissionEffect; rule?: PermissionRule } => {
          for (const effect of PRECEDENCE) {
            const candidate = rules.find(
              (candidate) =>
                candidate.rule.effect === effect &&
                candidate.tool.test(call.name) &&
                (call.name === "bash" && effect === "allow"
                  ? candidate.shellResource
                  : candidate.resource
                ).test(resource),
            )
            if (candidate) return { effect, rule: candidate.rule }
          }
          return { effect: fallback }
        },
      )
      const decision = decisions.sort(
        (left, right) => PRECEDENCE.indexOf(left.effect) - PRECEDENCE.indexOf(right.effect),
      )[0] ?? { effect: fallback }
      return {
        effect: decision.effect,
        resources,
        ...(decision.rule ? { rule: decision.rule } : {}),
        ...(source ? { artifactPath: source.path } : {}),
      }
    },
  }
}

export function parsePermissionConfig(value: unknown, label = "permissions"): PermissionConfig {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`)
  const defaultMode = value.defaultMode
  if (
    defaultMode !== undefined &&
    !(
      typeof defaultMode === "string" &&
      (PERMISSION_MODES as readonly string[]).includes(defaultMode)
    )
  )
    throw new Error(`${label}.defaultMode must be ask, auto, or dontAsk.`)
  if (value.rules !== undefined && !Array.isArray(value.rules))
    throw new Error(`${label}.rules must be an array.`)
  const rules = value.rules ?? []
  return {
    ...(defaultMode ? { defaultMode: defaultMode as PermissionMode } : {}),
    rules: rules.map((rule, index) => parsePermissionRule(rule, `${label}.rules[${index}]`)),
  }
}

function parsePermissionRule(value: unknown, label = "permission rule"): PermissionRule {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`)
  const tool = typeof value.tool === "string" ? value.tool.toLowerCase() : ""
  if (tool !== "*" && !(TOOL_NAMES as readonly string[]).includes(tool))
    throw new Error(`${label}.tool must be * or a known tool name.`)
  const effect = value.effect
  if (typeof effect !== "string" || !(PERMISSION_EFFECTS as readonly string[]).includes(effect))
    throw new Error(`${label}.effect must be allow, ask, or deny.`)
  const resource = value.resource
  if (resource !== undefined && (typeof resource !== "string" || !resource.trim()))
    throw new Error(`${label}.resource must be a non-empty string.`)
  return {
    tool: tool as PermissionRule["tool"],
    effect: effect as PermissionEffect,
    ...(typeof resource === "string" ? { resource: resource.trim() } : {}),
  }
}

export function parsePermissionRuleString(value: string, effect: PermissionEffect): PermissionRule {
  const input = value.trim()
  const open = input.indexOf("(")
  if (!input) throw new Error(`--${effect} requires a permission rule.`)
  if (open === -1) return parsePermissionRule({ tool: input, effect }, `--${effect}`)
  if (!input.endsWith(")") || open === 0) throw new Error(`Invalid --${effect} rule: ${value}`)
  return parsePermissionRule(
    { tool: input.slice(0, open), resource: input.slice(open + 1, -1), effect },
    `--${effect}`,
  )
}

async function permissionResources(call: ToolCall, cwd: string): Promise<string[]> {
  if (call.name === "bash") return [call.input.command]
  if (call.name === "skill") return [`${call.input.skill}/${call.input.path ?? "SKILL.md"}`]
  if (call.name === "web_read") return [call.input.url]
  if (call.name === "web_search") return call.input.searchQueries
  if (call.name === "agent") return [call.input.description]
  const paths =
    call.name === "edit_document"
      ? [
          call.input.path,
          ...(call.input.replaceOriginal
            ? []
            : [call.input.outputPath ?? editedDocumentPath(call.input.path)]),
        ]
      : call.name === "document"
        ? [call.input.path, call.input.specPath, call.input.outputPath].filter(
            (path): path is string => Boolean(path),
          )
        : [call.input.path]
  if (paths.length === 0) return ["check"]
  const resources = await Promise.all(
    paths.map(async (path) => {
      const lexical = workspaceResource(resolve(cwd, path), cwd)
      const canonicalPath = await resolveWorkspacePath(path, { cwd }, { allowMissingLeaf: true })
      const canonical = workspaceResource(canonicalPath, await realpath(resolve(cwd)))
      return lexical === canonical ? [lexical] : [lexical, canonical]
    }),
  )
  return [...new Set(resources.flat())]
}

function workspaceResource(absolute: string, cwd: string) {
  const local = relative(cwd, absolute)
  if (!local) return "."
  return local.split(sep).join("/")
}

function compilePattern(pattern: string, options: { shellSafeWildcard?: boolean } = {}) {
  const wildcard = options.shellSafeWildcard ? "[^;&|`$<>\\r\\n]*" : ".*"
  const single = options.shellSafeWildcard ? "[^;&|`$<>\\r\\n]" : "."
  const expression = pattern
    .split("")
    .map((character) => {
      if (character === "*") return wildcard
      if (character === "?") return single
      return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character
    })
    .join("")
  return new RegExp(`^${expression}$`, "u")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function loadProjectPermissionRules(cwd: string): Promise<PermissionRule[]> {
  const content = await readFile(join(cwd, ".otis", "permissions.json"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (content === undefined) return []
  let value: { version?: unknown; defaultMode?: unknown; rules?: unknown } | null
  try {
    value = JSON.parse(content)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid project permissions: ${message}`)
  }
  if (typeof value !== "object" || value?.version !== 1)
    throw new Error("Invalid project permissions: expected version 1.")
  if (value.defaultMode !== undefined)
    throw new Error("Invalid project permissions: project policy may not set defaultMode.")
  const config = parsePermissionConfig({ rules: value.rules }, "project permissions")
  if (config.rules.some((rule) => rule.effect === "allow")) {
    throw new Error(
      "Invalid project permissions: project rules may ask or deny, but may not grant access.",
    )
  }
  return config.rules
}
