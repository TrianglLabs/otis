import { homedir } from "node:os"
import { isAbsolute, parse, relative, resolve, sep } from "node:path"

const MAX_VISIBLE_SEGMENTS = 3

export function formatWorkspaceLabel(cwd: string, userHome = homedir()) {
  const absoluteCwd = resolve(cwd)
  const absoluteHome = resolve(userHome)
  const fromHome = relative(absoluteHome, absoluteCwd)

  if (isWithin(fromHome)) return compactPath("~", segments(fromHome))

  const root = parse(absoluteCwd).root
  return compactPath(root, segments(relative(root, absoluteCwd)))
}

function isWithin(relativePath: string) {
  return (
    relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  )
}

function segments(path: string) {
  return path.split(sep).filter(Boolean)
}

function compactPath(root: string, parts: string[]) {
  if (parts.length === 0) return root
  const visible = parts.length <= MAX_VISIBLE_SEGMENTS ? parts : ["…", ...parts.slice(-2)]
  return root === "~" ? `~${sep}${visible.join(sep)}` : `${root}${visible.join(sep)}`
}
