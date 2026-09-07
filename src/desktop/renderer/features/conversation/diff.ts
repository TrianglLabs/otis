/**
 * Presentation cleanup for stored unified diffs. New diffs are generated without the decorative jsdiff header
 * (see PATCH_OPTIONS in src/tools/files.ts); sessions recorded earlier still carry it. The file path is already
 * shown by the tool label, and hunk headers (`@@ -a,b +c,d @@`) become line numbers in the gutter, so none of
 * the raw patch scaffolding is shown to the user.
 */
export type DiffDisplayRow =
  | { kind: "add" | "remove" | "context"; text: string; oldLine?: number; newLine?: number }
  | { kind: "gap" }

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseDiffDisplay(diff: string): DiffDisplayRow[] {
  const rows: DiffDisplayRow[] = []
  let oldLine = 0
  let newLine = 0
  // Remaining lines in the active hunk; a `--- `/`+++ ` line is a file header only outside an unfinished hunk,
  // so content like a removed SQL comment (`-- note` → `--- note`) is never mistaken for scaffolding.
  let oldLeft = 0
  let newLeft = 0

  const inHunk = () => oldLeft > 0 || newLeft > 0

  for (const line of diff.split("\n")) {
    const hunk = HUNK_HEADER.exec(line)
    if (hunk && !inHunk()) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[3])
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
      if (rows.length > 0) rows.push({ kind: "gap" })
      continue
    }
    if (line.startsWith("\\")) continue // "\ No newline at end of file"
    if (!inHunk()) continue // patch scaffolding: Index/underline/file headers, or trailing-newline noise
    if (line === "") continue

    if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), newLine: newLine++ })
      newLeft--
    } else if (line.startsWith("-")) {
      rows.push({ kind: "remove", text: line.slice(1), oldLine: oldLine++ })
      oldLeft--
    } else {
      rows.push({ kind: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ })
      oldLeft--
      newLeft--
    }
  }
  return rows
}
