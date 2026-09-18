import { extname } from "node:path"

/** Deterministic default lets permission checks describe the file before the tool executes. */
export function editedDocumentPath(path: string) {
  const extension = extname(path)
  return `${path.slice(0, path.length - extension.length)}-edited${extension}`
}
