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
  const rootStat = await stat(root)
  const regex = new RegExp(pattern)
  const max = maxResults ?? DEFAULT_GREP_MAX_RESULTS
  const includeGlob = include ? compileGlob(include) : undefined
  const matches: string[] = []

  if (rootStat.isFile()) {
    await searchFile(dirname(root), root, regex, includeGlob, matches, max, context.signal)
  } else {
    await walkForMatches(root, root, regex, includeGlob, matches, max, context.signal)
  }

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
  const rootStat = await stat(root)
  const glob = compileGlob(pattern)
  const max = maxResults ?? DEFAULT_GLOB_MAX_RESULTS
  const results: string[] = []

  if (rootStat.isFile()) {
    const relativePath = relative(root, root) || basename(root)
    if (matchesGlob(relativePath, glob)) results.push(relativePath)
  } else {
    await walkForGlob(root, root, glob, results, max, context.signal)
  }

  return {
    title: `Glob: ${pattern}${searchPath !== "." ? ` in ${searchPath}` : ""}`,
    output: results.length > 0 ? results.join("\n") : "No files matched.",
  }
}

async function walkForMatches(
  root: string,
  currentDirectory: string,
  regex: RegExp,
  include: CompiledGlob | undefined,
  matches: string[],
  max: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted || matches.length >= max) return

  const entries = (await readdir(currentDirectory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )
  for (const entry of entries) {
    if (signal?.aborted || matches.length >= max) return
    const fullPath = resolve(currentDirectory, entry.name)

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue
      await walkForMatches(root, fullPath, regex, include, matches, max, signal)
    } else if (entry.isFile()) {
      await searchFile(root, fullPath, regex, include, matches, max, signal)
    }
  }
}

async function searchFile(
  root: string,
  filePath: string,
  regex: RegExp,
  include: CompiledGlob | undefined,
  matches: string[],
  max: number,
  signal?: AbortSignal,
) {
  if (matches.length >= max) return

  const relativePath = relative(root, filePath)
  if (include && !matchesIncludeGlob(relativePath, include)) return

  let content: string
  try {
    const buffer = await readFile(filePath)
    if (isBinary(buffer)) return
    content = buffer.toString("utf8")
  } catch {
    return
  }

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (signal?.aborted || matches.length >= max) return
    if (regex.test(line)) matches.push(`${relativePath}:${index + 1}:${truncateLine(line)}`)
  }
}

async function walkForGlob(
  root: string,
  currentDirectory: string,
  glob: CompiledGlob,
  results: string[],
  max: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted || results.length >= max) return

  const entries = (await readdir(currentDirectory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )
  for (const entry of entries) {
    if (signal?.aborted || results.length >= max) return
    const fullPath = resolve(currentDirectory, entry.name)

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue
      await walkForGlob(root, fullPath, glob, results, max, signal)
    } else if (entry.isFile()) {
      const relativePath = relative(root, fullPath)
      if (matchesGlob(relativePath, glob)) results.push(relativePath)
    }
  }
}

type CompiledGlob = {
  regex: RegExp
  hasPathSeparator: boolean
}

function compileGlob(pattern: string): CompiledGlob {
  let source = "^"
  let index = 0
  let hasPathSeparator = false

  while (index < pattern.length) {
    const character = pattern[index]
    if (character === "*" && pattern[index + 1] === "*") {
      index += 2
      if (pattern[index] === "/") {
        source += "(?:.*/)?"
        hasPathSeparator = true
        index += 1
      } else {
        source += ".*"
      }
    } else if (character === "*") {
      source += "[^/]*"
      index += 1
    } else if (character === "?") {
      source += "[^/]"
      index += 1
    } else if (character === ".") {
      source += "\\."
      index += 1
    } else if ("\\^$|+()[]{}".includes(character)) {
      source += `\\${character}`
      index += 1
    } else {
      if (character === "/") hasPathSeparator = true
      source += character
      index += 1
    }
  }

  return { regex: new RegExp(`${source}$`), hasPathSeparator }
}

function matchesGlob(relativePath: string, glob: CompiledGlob) {
  return glob.regex.test(relativePath)
}

function matchesIncludeGlob(relativePath: string, glob: CompiledGlob) {
  return glob.regex.test(glob.hasPathSeparator ? relativePath : basename(relativePath))
}
