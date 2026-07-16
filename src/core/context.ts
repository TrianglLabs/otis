import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { ContextFile } from "../inference/types.js"

const CONTEXT_FILENAME = "AGENTS.md"

/**
 * Load AGENTS.md context files for the given working directory.
 *
 * Walks from the current directory up to the filesystem root, collecting
 * context files at each level.
 *
 * Files are ordered root-first so the most specific (nearest to cwd) file
 * appears last — matching the AGENTS.md format convention where closer
 * files override broader ones.
 *
 * A global context file from the user's home directory is loaded first if
 * present, so it serves as the broadest layer.
 */
export function loadProjectContext(cwd: string): ContextFile[] {
  const resolvedCwd = resolve(cwd)
  const homeDir = getHomeDir()
  const seenPaths = new Set<string>()
  const files: ContextFile[] = []

  if (homeDir) {
    const homeFile = loadContextFileFromDir(homeDir)
    if (homeFile && !seenPaths.has(homeFile.path)) {
      files.push(homeFile)
      seenPaths.add(homeFile.path)
    }
  }

  const ancestorFiles: ContextFile[] = []
  let currentDir = resolvedCwd

  while (true) {
    const contextFile = loadContextFileFromDir(currentDir)
    if (contextFile && !seenPaths.has(contextFile.path)) {
      ancestorFiles.unshift(contextFile)
      seenPaths.add(contextFile.path)
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) break
    currentDir = parentDir
  }

  files.push(...ancestorFiles)

  return files
}

function loadContextFileFromDir(dir: string): ContextFile | null {
  const filePath = join(dir, CONTEXT_FILENAME)
  try {
    const content = readFileSync(filePath, "utf8")
    return content.trim() ? { path: filePath, content } : null
  } catch {
    return null
  }
}

function getHomeDir(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE
  if (!home) return null
  try {
    return resolve(home)
  } catch {
    return null
  }
}
