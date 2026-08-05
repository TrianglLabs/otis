import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { type PermissionRule, parsePermissionConfig } from "./policy.js"

export async function loadProjectPermissionRules(cwd: string): Promise<PermissionRule[]> {
  const file = join(cwd, ".otis", "permissions.json")
  let content: string
  try {
    content = await readFile(file, "utf8")
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new Error(`Invalid project permissions: ${errorMessage(error)}`)
  }
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Invalid project permissions: expected version 1.")
  }
  if (value.defaultMode !== undefined) {
    throw new Error("Invalid project permissions: project policy may not set defaultMode.")
  }
  const config = parsePermissionConfig({ rules: value.rules }, "project permissions")
  if (config.rules.some((rule) => rule.effect === "allow")) {
    throw new Error("Invalid project permissions: project rules may ask or deny, but may not grant access.")
  }
  return config.rules
}

function isNotFound(error: unknown) {
  return isRecord(error) && error.code === "ENOENT"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
