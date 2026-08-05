import { realpath } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"
import { TOOL_NAMES, type ToolCall, type ToolName } from "../tools/index.js"
import { resolveWorkspacePath } from "../tools/workspace.js"

export const PERMISSION_EFFECTS = ["allow", "ask", "deny"] as const
export type PermissionEffect = (typeof PERMISSION_EFFECTS)[number]

export const PERMISSION_MODES = ["ask", "auto", "dontAsk"] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export type PermissionRule = {
  tool: ToolName | "*"
  resource?: string
  effect: PermissionEffect
}

export type PermissionConfig = {
  defaultMode?: PermissionMode
  rules: PermissionRule[]
}

export type PermissionDecision = {
  effect: PermissionEffect
  resources: string[]
  rule?: PermissionRule
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

const RESTRICTED_BY_DEFAULT = new Set<ToolName>(["bash", "write", "edit"])

export function createPermissionPolicy(options: PermissionPolicyOptions): PermissionPolicy {
  const rules = (options.rules ?? []).map((rule) => ({
    rule,
    tool: compilePattern(rule.tool),
    resource: compilePattern(rule.resource ?? "*"),
    shellResource: compilePattern(rule.resource ?? "*", { shellSafeWildcard: true }),
  }))
  return {
    async evaluate(call) {
      const resources = await permissionResources(call, options.cwd)
      const decisions = resources.map((resource) => {
        for (const effect of ["deny", "ask", "allow"] as const) {
          const candidate = rules.find(
            (candidate) =>
              candidate.rule.effect === effect &&
              candidate.tool.test(call.name) &&
              (call.name === "bash" && candidate.rule.effect === "allow"
                ? candidate.shellResource
                : candidate.resource
              ).test(resource),
          )
          if (candidate) return { effect, rule: candidate.rule }
        }
        return { effect: defaultEffect(call.name, options.mode) }
      })
      for (const effect of ["deny", "ask", "allow"] as const) {
        const decision = decisions.find((candidate) => candidate.effect === effect)
        if (decision) return { effect, resources, ...(decision.rule ? { rule: decision.rule } : {}) }
      }
      return { effect: defaultEffect(call.name, options.mode), resources }
    },
  }
}

export function parsePermissionConfig(value: unknown, label = "permissions"): PermissionConfig {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`)
  const defaultMode = optionalPermissionMode(value.defaultMode, `${label}.defaultMode`)
  if (value.rules !== undefined && !Array.isArray(value.rules)) throw new Error(`${label}.rules must be an array.`)
  const rules = value.rules ?? []
  return {
    ...(defaultMode ? { defaultMode } : {}),
    rules: rules.map((rule, index) => parsePermissionRule(rule, `${label}.rules[${index}]`)),
  }
}

export function parsePermissionRule(value: unknown, label = "permission rule"): PermissionRule {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`)
  const tool = value.tool
  const effect = value.effect
  const resource = value.resource
  if (typeof tool !== "string" || !isPermissionTool(tool)) {
    throw new Error(`${label}.tool must be * or a known tool name.`)
  }
  if (typeof effect !== "string" || !isPermissionEffect(effect)) {
    throw new Error(`${label}.effect must be allow, ask, or deny.`)
  }
  if (resource !== undefined && (typeof resource !== "string" || !resource.trim())) {
    throw new Error(`${label}.resource must be a non-empty string.`)
  }
  return { tool, effect, ...(typeof resource === "string" ? { resource: resource.trim() } : {}) }
}

export function parsePermissionRuleString(value: string, effect: PermissionEffect): PermissionRule {
  const input = value.trim()
  const open = input.indexOf("(")
  if (!input) throw new Error(`--${effect} requires a permission rule.`)
  if (open === -1) return parsePermissionRule({ tool: input, effect }, `--${effect}`)
  if (!input.endsWith(")") || open === 0) throw new Error(`Invalid --${effect} rule: ${value}`)
  return parsePermissionRule({ tool: input.slice(0, open), resource: input.slice(open + 1, -1), effect }, `--${effect}`)
}

async function permissionResources(call: ToolCall, cwd: string): Promise<string[]> {
  if (call.name === "bash") return [call.input.command]
  if (call.name === "web_read") return [call.input.url]
  if (call.name === "web_search") return call.input.searchQueries
  return workspaceResources(call.input.path, cwd)
}

async function workspaceResources(path: string, cwd: string) {
  const lexical = workspaceResource(resolve(cwd, path), cwd)
  const canonicalPath = await resolveWorkspacePath(path, { cwd }, { allowMissingLeaf: true })
  const canonical = workspaceResource(canonicalPath, await realpath(resolve(cwd)))
  return lexical === canonical ? [lexical] : [lexical, canonical]
}

function workspaceResource(absolute: string, cwd: string) {
  const local = relative(cwd, absolute)
  if (!local) return "."
  return local.split(sep).join("/")
}

function defaultEffect(tool: ToolName, mode: PermissionMode): PermissionEffect {
  if (!RESTRICTED_BY_DEFAULT.has(tool)) return "allow"
  if (mode === "auto") return "allow"
  if (mode === "dontAsk") return "deny"
  return "ask"
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

function optionalPermissionMode(value: unknown, label: string): PermissionMode | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string" && isPermissionMode(value)) return value
  throw new Error(`${label} must be ask, auto, or dontAsk.`)
}

function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value)
}

function isPermissionEffect(value: string): value is PermissionEffect {
  return (PERMISSION_EFFECTS as readonly string[]).includes(value)
}

function isPermissionTool(value: string): value is PermissionRule["tool"] {
  return value === "*" || (TOOL_NAMES as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
