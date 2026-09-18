import { extname } from "node:path"
import { fileURLToPath } from "node:url"

/** Parses shell-escaped paths emitted when files are dropped into common macOS and Linux terminals. */
export function parsePastedFilePaths(value: string, allowedExtensions: ReadonlySet<string>): string[] | undefined {
  const tokens = tokenizePastedPaths(value.trim())
  if (!tokens || tokens.length === 0) return undefined

  const paths = tokens.map(normalizePastedPath)
  if (paths.some((path) => !path || !allowedExtensions.has(extname(path).toLowerCase()))) return undefined
  return paths
}

function tokenizePastedPaths(value: string): string[] | undefined {
  if (!value) return []
  const tokens: string[] = []
  let token = ""
  let quote: "single" | "double" | undefined
  let escaped = false

  for (const character of value) {
    if (escaped) {
      token += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "single") {
      escaped = true
      continue
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single"
      continue
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double"
      continue
    }
    if (!quote && isShellWhitespace(character)) {
      if (token) tokens.push(token)
      token = ""
      continue
    }
    token += character
  }

  if (escaped || quote) return undefined
  if (token) tokens.push(token)
  return tokens
}

function isShellWhitespace(character: string) {
  return character === " " || character === "\t" || character === "\r" || character === "\n"
}

function normalizePastedPath(value: string) {
  if (!value.startsWith("file://")) return value
  try {
    return fileURLToPath(value)
  } catch {
    return ""
  }
}
