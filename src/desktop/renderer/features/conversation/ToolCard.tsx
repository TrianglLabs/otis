import {
  Box,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderSearch,
  GitBranch,
  Globe,
  type LucideIcon,
  Pencil,
  Search,
  SquareTerminal,
} from "lucide-react"
import { memo, useContext, useMemo } from "react"
import { Virtuoso } from "react-virtuoso"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import { isCanvasArtifact } from "../../../../artifacts/canvas.js"
import type { ToolActivityKind } from "../../../../tools/activity.js"
import { ArtifactCard } from "../../components/ArtifactCard.js"
import { Icon } from "../../components/Icon.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop } from "../../runtime.js"
import { PaneRuntimeContext } from "../canvas/canvas-context.js"
import type { ToolRun } from "./TranscriptList.js"

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
 * One tool activity row: icon, label, status. When the tool produced a diff it is rendered inline,
 * always expanded — edited code is content, not a disclosure. A ready Canvas artifact replaces the
 * row with its card.
 */
export function ToolCard({ entry, active }: { entry: TranscriptEntry; active: boolean }) {
  const { api } = useDesktop()
  const runtime = useContext(PaneRuntimeContext)
  const { t } = useI18n()
  const artifact =
    entry.artifact &&
    isCanvasArtifact(entry.artifact.kind) &&
    entry.artifactDisplay !== "pending" &&
    entry.artifactDisplay !== "superseded"
      ? entry.artifact
      : undefined
  const artifactClass = artifact ? " toolCard-artifact" : ""
  const activeClass = active ? " toolCard-active" : ""
  return (
    <div className={`toolCard${artifactClass}${activeClass}`}>
      {artifact ? (
        <ArtifactCard
          kind={artifact.kind}
          title={
            artifact.source === "published"
              ? artifact.name
              : (artifact.path.split("/").at(-1) ?? artifact.path)
          }
          actionLabel={t("markdown.openCanvas")}
          description={t(
            artifact.source === "published" ? "canvas.savedArtifact" : "canvas.workingFile",
          )}
          onOpen={() => api.openArtifact(artifact, undefined, runtime)}
        />
      ) : (
        <div className="toolCard-header" title={entry.text}>
          <span className="toolCard-icon">
            <Icon icon={KIND_ICONS[entry.activityKind ?? "shell"]} size={13} />
          </span>
          <span className="toolCard-label">{entry.text}</span>
        </div>
      )}
      {entry.diff ? <DiffView diff={entry.diff} /> : null}
    </div>
  )
}

/**
 * The row for a run of consecutive tool activity. The label is keyed by the latest action, so each
 * new action replaces it with a short rise-and-fade (see activity-status-in) — a live burst reads
 * as one status line in motion instead of a stack of cards. The row never renders its actions
 * itself: expanding flattens them into the virtualized transcript (see flattenExpandedRuns),
 * keeping long runs windowed.
 */
export function ToolRunCard({
  run,
  active,
  expanded,
  onExpandedChange,
}: {
  run: ToolRun
  active: boolean
  expanded: boolean
  onExpandedChange: (id: number, expanded: boolean) => void
}) {
  const { t } = useI18n()
  const latest = run.entries[run.entries.length - 1]
  return (
    <div className={`toolCard toolRun${active ? " toolCard-active" : ""}`}>
      <button
        type="button"
        className="toolCard-header toolRun-header"
        onClick={() => onExpandedChange(run.id, !expanded)}
        aria-expanded={expanded}
        aria-label={t("transcript.toolActions", { count: run.entries.length, latest: latest.text })}
      >
        <span className="toolCard-icon toolRun-icon" key={`icon-${latest.id}`}>
          <Icon icon={KIND_ICONS[latest.activityKind ?? "shell"]} size={13} />
        </span>
        <span className="toolCard-label toolRun-label" key={latest.id}>
          {latest.text}
        </span>
        <span className="toolRun-chevron">
          {expanded ? (
            <ChevronDown size={13} aria-hidden />
          ) : (
            <ChevronRight size={13} aria-hidden />
          )}
        </span>
      </button>
    </div>
  )
}

/** Unified diff rendered as a proper view: line-number gutter, sign column, hunk separators. */
const DiffView = memo(function DiffView({ diff }: { diff: string }) {
  const { t } = useI18n()
  const rows = useMemo(() => parseDiffDisplay(diff), [diff])
  if (rows.length > 200) {
    return (
      <Virtuoso<DiffDisplayRow>
        className="diffView diffView-windowed"
        aria-label={t("transcript.codeChanges")}
        tabIndex={0}
        style={{ height: 384 }}
        data={rows}
        defaultItemHeight={19.2}
        increaseViewportBy={100}
        itemContent={renderDiffRow}
      />
    )
  }
  return (
    <div className="diffView">
      <div className="diffView-inner">
        {rows.map((row, index) => (
          <DiffRow key={index} row={row} />
        ))}
      </div>
    </div>
  )
})
const renderDiffRow = (_index: number, row: DiffDisplayRow) => <DiffRow row={row} />

function DiffRow({ row }: { row: DiffDisplayRow }) {
  return row.kind === "gap" ? (
    <div className="diffGap" aria-hidden="true" />
  ) : (
    <div className={`diffLine diffLine-${row.kind}`}>
      <span className="diffLine-no">{row.oldLine ?? ""}</span>
      <span className="diffLine-no">{row.newLine ?? ""}</span>
      <span className="diffLine-sign">
        {row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}
      </span>
      <span className="diffLine-text">{row.text}</span>
    </div>
  )
}

/**
 * Presentation cleanup for stored unified diffs. New diffs are generated without the decorative
 * jsdiff header (see PATCH_OPTIONS in src/tools/files.ts); sessions recorded earlier still carry
 * it. The file path is already shown by the tool label, and hunk headers (`@@ -a,b +c,d @@`) become
 * line numbers in the gutter, so none of the raw patch scaffolding is shown to the user.
 */
type DiffDisplayRow =
  | { kind: "add" | "remove" | "context"; text: string; oldLine?: number; newLine?: number }
  | { kind: "gap" }

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function parseDiffDisplay(diff: string): DiffDisplayRow[] {
  const rows: DiffDisplayRow[] = []
  let oldLine = 0
  let newLine = 0
  // Remaining lines in the active hunk; a `--- `/`+++ ` line is a file header only outside an
  // unfinished hunk, so content like a removed SQL comment (`-- note` → `--- note`) is never
  // mistaken for scaffolding.
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
    // Patch scaffolding: Index/underline/file headers, or trailing-newline noise.
    if (!inHunk()) continue
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
