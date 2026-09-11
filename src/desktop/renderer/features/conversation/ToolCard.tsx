import type { LucideIcon } from "lucide-react"
import { Box, FileText, FolderSearch, GitBranch, Globe, Pencil, Search, SquareTerminal } from "lucide-react"
import { type ComponentProps, forwardRef, memo, useMemo } from "react"
import { Virtuoso } from "react-virtuoso"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import type { ToolActivityKind } from "../../../../tools/activity.js"
import { Icon } from "../../components/Icon.js"
import { type DiffDisplayRow, parseDiffDisplay } from "./diff.js"

const KIND_ICONS: Record<ToolActivityKind, LucideIcon> = {
  web_search: Globe,
  web_read: Globe,
  file_read: FileText,
  file_search: Search,
  file_write: Pencil,
  file_edit: Pencil,
  file_inspect: FolderSearch,
  git: GitBranch,
  shell: SquareTerminal,
  agent: Box,
}

/**
 * One tool activity row: icon, label, status. When the tool produced a diff it is rendered inline, always
 * expanded — edited code is content, not a disclosure.
 */
export function ToolCard({ entry, active }: { entry: TranscriptEntry; active: boolean }) {
  const icon = KIND_ICONS[entry.activityKind ?? "shell"]

  return (
    <div className={`toolCard${active ? " toolCard-active" : ""}`}>
      <div className="toolCard-header" title={entry.text}>
        <span className="toolCard-icon">
          <Icon icon={icon} size={13} />
        </span>
        <span className="toolCard-label">{entry.text}</span>
      </div>
      {entry.diff ? <DiffView diff={entry.diff} /> : null}
    </div>
  )
}

/** Unified diff rendered as a proper view: line-number gutter, sign column, hunk separators. */
export const DiffView = memo(function DiffView({ diff }: { diff: string }) {
  const rows = useMemo(() => parseDiffDisplay(diff), [diff])
  const context = useMemo(
    () => ({
      // Reserve horizontal space even when the longest line is outside the vertical viewport. max-content still
      // accommodates wider glyphs; this is a minimum, never a clipping width.
      columns: rows.reduce(
        (max, row) => (row.kind === "gap" ? max : Math.max(max, row.text.replace(/\t/g, "    ").length)),
        0,
      ),
    }),
    [rows],
  )
  if (rows.length > 200) {
    return (
      <Virtuoso<DiffDisplayRow, { columns: number }>
        className="diffView diffView-windowed"
        aria-label="Code changes"
        tabIndex={0}
        style={{ height: 384 }}
        data={rows}
        context={context}
        components={diffComponents}
        defaultItemHeight={19.2}
        increaseViewportBy={100}
        itemContent={renderDiffRow}
      />
    )
  }
  return (
    <div className="diffView">
      {/* Shrink-fits the widest line so every row's background spans the full scroll width. */}
      <div className="diffView-inner">
        {rows.map((row, index) => (
          <DiffRow key={index} row={row} />
        ))}
      </div>
    </div>
  )
})

const DiffList = forwardRef<HTMLDivElement, ComponentProps<"div"> & { context?: { columns: number } }>(
  function DiffList({ context, style, ...props }, ref) {
    return (
      <div
        {...props}
        ref={ref}
        className="diffView-inner"
        style={{ ...style, minWidth: `max(100%, calc(${context?.columns ?? 0}ch + 96px))` }}
      />
    )
  },
)
const diffComponents = { List: DiffList }
const renderDiffRow = (_index: number, row: DiffDisplayRow) => <DiffRow row={row} />

function DiffRow({ row }: { row: DiffDisplayRow }) {
  return row.kind === "gap" ? (
    <div className="diffGap" aria-hidden="true" />
  ) : (
    <div className={`diffLine diffLine-${row.kind}`}>
      <span className="diffLine-no">{row.oldLine ?? ""}</span>
      <span className="diffLine-no">{row.newLine ?? ""}</span>
      <span className="diffLine-sign">{row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}</span>
      <span className="diffLine-text">{row.text}</span>
    </div>
  )
}
