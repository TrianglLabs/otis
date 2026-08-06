import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { createPatch } from "diff"
import { detectImageMimeType } from "../inference/images.js"
import type { ToolContext, ToolResult } from "./types.js"
import { isNotFoundError, resolveWorkspacePath } from "./workspace.js"

const DEFAULT_READ_LIMIT = 2_000
const MAX_LINE_LENGTH = 2_000
const BINARY_CHECK_BYTES = 8_000

export async function readLocalFile(
  path: string,
  offset = 1,
  limit = DEFAULT_READ_LIMIT,
  context: ToolContext,
): Promise<ToolResult> {
  const filePath = await resolveWorkspacePath(path, context)
  const fileStat = await stat(filePath)

  if (fileStat.isDirectory()) {
    const entries = await readdir(filePath, { withFileTypes: true })
    const output = entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .join("\n")
    return { title: `Read directory: ${filePath}`, output: output || "Directory is empty." }
  }

  const content = await readFile(filePath)
  if (detectImageMimeType(content)) {
    throw new Error("read supports text files only. Attach the image to an Otis prompt instead.")
  }
  if (isBinary(content)) throw new Error("read supports text files only.")
  const lines = content.toString("utf8").split(/\r?\n/)
  const start = Math.max(1, Math.floor(offset))
  const count = Math.max(1, Math.min(DEFAULT_READ_LIMIT, Math.floor(limit)))
  const output = lines
    .slice(start - 1, start - 1 + count)
    .map((line, index) => `${start + index}: ${truncateLine(line)}`)
    .join("\n")
  return { title: `Read: ${filePath}`, output: output || "File is empty." }
}

export async function writeLocalFile(path: string, content: string, context: ToolContext): Promise<ToolResult> {
  const filePath = await resolveWorkspacePath(path, context, { allowMissingLeaf: true })
  let diff: string

  try {
    const existing = await readFile(filePath, "utf8")
    diff = existing === content ? "" : createPatch(filePath, existing, content, "", "", { context: 3 })
  } catch (error) {
    if (!isNotFoundError(error)) throw error
    diff = createPatch(filePath, "", content, "", "", { context: 3 })
  }

  await writeFile(filePath, content, "utf8")
  return {
    title: `Write: ${filePath}`,
    output: `Wrote ${content.length} characters.`,
    ...(diff ? { diff } : {}),
  }
}

export async function editLocalFile(
  path: string,
  oldText: string,
  newText: string,
  context: ToolContext,
): Promise<ToolResult> {
  if (!oldText) throw new Error("edit requires a non-empty old string")

  const filePath = await resolveWorkspacePath(path, context)
  const content = await readFile(filePath, "utf8")
  const first = content.indexOf(oldText)
  if (first === -1) throw new Error("old string was not found")
  if (content.indexOf(oldText, first + oldText.length) !== -1) {
    throw new Error("old string appears multiple times; provide a more specific old string")
  }

  const updated = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`
  await writeFile(filePath, updated, "utf8")
  return {
    title: `Edit: ${filePath}`,
    output: `Replaced ${oldText.length} characters with ${newText.length} characters.`,
    diff: createPatch(filePath, content, updated, "", "", { context: 3 }),
  }
}

export function truncateLine(line: string) {
  return line.length <= MAX_LINE_LENGTH ? line : `${line.slice(0, MAX_LINE_LENGTH)} [line truncated]`
}

export function isBinary(buffer: Buffer) {
  return buffer.subarray(0, Math.min(buffer.length, BINARY_CHECK_BYTES)).includes(0)
}
