import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { ToolResult } from "../tools/types.js"
import type { SkillCatalog } from "./types.js"

const DEFAULT_RESOURCE = "SKILL.md"

export async function readSkillResource(
  catalog: SkillCatalog,
  name: string,
  path = DEFAULT_RESOURCE,
): Promise<ToolResult> {
  const skill = catalog.byName.get(name)
  if (!skill) throw new Error(`Unknown skill: ${name}`)
  if (!path.trim() || isAbsolute(path)) throw new Error("Skill resource path must be relative to the skill root.")

  const requested = resolve(skill.root, path)
  assertInside(skill.root, requested)
  const canonical = await realpath(requested)
  assertInside(skill.root, canonical)
  const resourceStat = await stat(canonical)

  if (resourceStat.isDirectory()) {
    const entries = await readdir(canonical, { withFileTypes: true })
    return {
      title: `Read skill directory: ${canonical}`,
      output:
        entries
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
          .join("\n") || "Directory is empty.",
    }
  }
  if (!resourceStat.isFile()) throw new Error(`Skill resource is not a regular file: ${canonical}`)

  const contents = await readFile(canonical)
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(contents)
  } catch {
    throw new Error("skill supports UTF-8 text resources only.")
  }
  return {
    title: `Read skill resource: ${canonical}`,
    output: path === DEFAULT_RESOURCE ? `Skill root: ${skill.root}\n\n${text}` : text,
  }
}

function assertInside(root: string, target: string) {
  const nested = relative(root, target)
  if (nested === "" || (!nested.startsWith("..") && !isAbsolute(nested))) return
  throw new Error(`Skill resource is outside the skill root: ${target}`)
}
