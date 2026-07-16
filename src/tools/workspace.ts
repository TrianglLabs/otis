import { realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import type { ToolContext } from "./types.js"

export async function resolveWorkspacePath(
  path: string,
  context: ToolContext,
  options: { allowMissingLeaf?: boolean } = {},
) {
  const root = await realpath(resolve(context.cwd ?? process.cwd()))
  const requested = resolve(root, path)
  assertInsideWorkspace(root, requested)

  if (!options.allowMissingLeaf) {
    const target = await realpath(requested)
    assertInsideWorkspace(root, target)
    return target
  }

  try {
    const target = await realpath(requested)
    assertInsideWorkspace(root, target)
    return target
  } catch (error) {
    if (!isNotFoundError(error)) throw error
    const parent = await realpath(dirname(requested))
    assertInsideWorkspace(root, parent)
    return resolve(parent, basename(requested))
  }
}

export function isNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function assertInsideWorkspace(root: string, target: string) {
  const nestedPath = relative(root, target)
  if (nestedPath === "" || (!nestedPath.startsWith("..") && !isAbsolute(nestedPath))) return
  throw new Error(`Path is outside the workspace: ${target}`)
}
