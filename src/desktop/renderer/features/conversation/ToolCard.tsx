import type { LucideIcon } from "lucide-react"
import { Bot, FileText, FolderSearch, GitBranch, Globe, Pencil, Search, SquareTerminal } from "lucide-react"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import type { ToolActivityKind } from "../../../../tools/activity.js"
import { Icon } from "../../components/Icon.js"
import { parseDiffDisplay } from "./diff.js"

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
  agent: Bot,
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
        <span className="toolCard-status">
          {active ? (
            <span className="toolCard-running">
              <span className="pulseDot" aria-hidden /> Running
            </span>
          ) : null}
        </span>
      </div>
      {entry.diff ? <DiffView diff={entry.diff} /> : null}
    </div>
  )
}

/** Unified diff rendered as a proper view: line-number gutter, sign column, hunk separators. */
export function DiffView({ diff }: { diff: string }) {
  const rows = parseDiffDisplay(diff)
  return (
    <div className="diffView">
      {rows.map((row, index) =>
        row.kind === "gap" ? (
          <div key={index} className="diffGap" aria-hidden="true" />
        ) : (
          <div key={index} className={`diffLine diffLine-${row.kind}`}>
            <span className="diffLine-no">{row.oldLine ?? ""}</span>
            <span className="diffLine-no">{row.newLine ?? ""}</span>
            <span className="diffLine-sign">{row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}</span>
            <span className="diffLine-text">{row.text}</span>
          </div>
        ),
      )}
    </div>
  )
}
