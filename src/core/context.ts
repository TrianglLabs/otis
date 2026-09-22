import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { ContextFile } from "../inference/types.js"

/**
 * Loads AGENTS.md files from the working directory up to the filesystem root, ordered root-first
 * so the nearest file appears last and overrides broader ones. A global file in the user's home
 * directory is the broadest layer.
 */
export function loadProjectContext(cwd: string): ContextFile[] {
  const files: ContextFile[] = []
  let directory = resolve(cwd)
  while (true) {
    const file = loadContextFile(directory)
    if (file) files.unshift(file)
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const home = process.env.HOME || process.env.USERPROFILE
  const homeFile = home ? loadContextFile(resolve(home)) : undefined
  if (homeFile && !files.some((file) => file.path === homeFile.path)) files.unshift(homeFile)
  return files
}

function loadContextFile(directory: string): ContextFile | undefined {
  const path = join(directory, "AGENTS.md")
  try {
    const content = readFileSync(path, "utf8")
    return content.trim() ? { path, content } : undefined
  } catch {
    return undefined
  }
}
