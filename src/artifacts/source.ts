import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

/** Resolve both names for permission matching; an external symlink requires external-file approval. */
export async function resolveArtifactSource(path: string, cwd: string) {
  const workspace = resolve(cwd)
  const root = await realpath(workspace)
  const requested = resolve(workspace, path)
  const canonical = await realpath(requested)
  const resource = (absolute: string, base: string) => {
    const local = relative(base, absolute)
    return isOutside(local) ? absolute : local || "."
  }
  return {
    path: canonical,
    external: isOutside(relative(root, canonical)),
    resources: [
      ...new Set(
        [resource(requested, workspace), resource(canonical, root)].map((value) => value.split(sep).join("/")),
      ),
    ],
  }
}

function isOutside(path: string) {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)
}
