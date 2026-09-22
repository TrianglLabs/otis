import { readdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, relative, resolve } from "node:path"
import { isBinary, truncateLine } from "./files.js"
import type { ToolContext, ToolResult } from "./types.js"
import { resolveWorkspacePath } from "./workspace.js"

const DEFAULT_GREP_MAX_RESULTS = 200
const DEFAULT_GLOB_MAX_RESULTS = 500
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".svelte-kit",
  ".output",
  ".nuxt",
  ".vite",
])

export async function grepLocalFiles(
  pattern: string,
  searchPath: string,
  include: string | undefined,
  maxResults: number | undefined,
  context: ToolContext,
): Promise<ToolResult> {
  const root = await resolveWorkspacePath(searchPath, context)
  const isFile = (await stat(root)).isFile()
  const base = isFile ? dirname(root) : root
  const regex = new RegExp(pattern)
  const max = maxResults ?? DEFAULT_GREP_MAX_RESULTS
  const includeGlob = include ? compileGlob(include) : undefined
  const matches: string[] = []
  const done = () => Boolean(context.signal?.aborted) || matches.length >= max
  const search = async (filePath: string) => {
    const relativePath = relative(base, filePath)
    // A bare include pattern matches file names at any depth; a path pattern matches the whole
    // path.
    if (
      includeGlob &&
      !includeGlob.regex.test(includeGlob.hasPath ? relativePath : basename(filePath))
    )
      return
    const buffer = await readFile(filePath).catch(() => undefined)
    if (!buffer || isBinary(buffer)) return
    for (const [index, line] of buffer.toString("utf8").split(/\r?\n/).entries()) {
      if (done()) return
      if (regex.test(line)) matches.push(`${relativePath}:${index + 1}:${truncateLine(line)}`)
    }
  }
  if (isFile) await search(root)
  else await walk(root, search, done)
  return {
    title: `Grep: ${pattern}${searchPath !== "." ? ` in ${searchPath}` : ""}`,
    output: matches.length > 0 ? matches.join("\n") : "No matches found.",
  }
}

export async function globLocalFiles(
  pattern: string,
  searchPath: string,
  maxResults: number | undefined,
  context: ToolContext,
): Promise<ToolResult> {
  const root = await resolveWorkspacePath(searchPath, context)
  const glob = compileGlob(pattern)
  const max = maxResults ?? DEFAULT_GLOB_MAX_RESULTS
  const results: string[] = []
  const collect = (filePath: string) => {
    const relativePath = relative(root, filePath) || basename(filePath)
    if (glob.regex.test(relativePath)) results.push(relativePath)
  }
  if ((await stat(root)).isFile()) collect(root)
  else await walk(root, collect, () => Boolean(context.signal?.aborted) || results.length >= max)
  return {
    title: `Glob: ${pattern}${searchPath !== "." ? ` in ${searchPath}` : ""}`,
    output: results.length > 0 ? results.join("\n") : "No files matched.",
  }
}

/** Depth-first, name-ordered walk that skips build output and stops once `done` reports enough. */
async function walk(
  directory: string,
  visit: (filePath: string) => Promise<void> | void,
  done: () => boolean,
): Promise<void> {
  if (done()) return
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )
  for (const entry of entries) {
    if (done()) return
    const fullPath = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(fullPath, visit, done)
    } else if (entry.isFile()) await visit(fullPath)
  }
}

function compileGlob(pattern: string) {
  const source = pattern.replace(/\*\*\/|\*\*|\*|\?|[.\\^$|+()[\]{}]/g, (token) => {
    if (token === "**/") return "(?:.*/)?"
    if (token === "**") return ".*"
    if (token === "*") return "[^/]*"
    if (token === "?") return "[^/]"
    return `\\${token}`
  })
  return { regex: new RegExp(`^${source}$`), hasPath: pattern.includes("/") }
}
