import {
  Box,
  CalendarClock,
  ChevronRight,
  FileText,
  FolderSearch,
  GitBranch,
  Globe,
  ListChecks,
  type LucideIcon,
  NotebookPen,
  Pencil,
  Search,
  SquareTerminal,
} from "lucide-react"
import { memo, useContext, useMemo } from "react"
import { Virtuoso } from "react-virtuoso"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import { isCanvasArtifact } from "../../../../artifacts/canvas.js"
import { splitSubject, type ToolAction, type ToolActivityKind } from "../../../../tools/activity.js"
import { ArtifactCard } from "../../components/ArtifactCard.js"
import { Icon } from "../../components/Icon.js"
import { useI18n } from "../../i18n/index.js"
import type { MessageKey, Translate } from "../../i18n/messages/en.js"
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
  memory: NotebookPen,
  routine: CalendarClock,
}

/** Subjects that are sentences rather than code: a delegation's brief, a web query, a fact. */
const PROSE_ACTIONS = new Set<ToolAction>([
  "agent",
  "web_search",
  "recall",
  "remember",
  "forget",
  "routines_list",
  "routines_save",
  "routines_remove",
])

/** What a finished run did, counted by what each kind of action amounts to for the reader. */
const RUN_COUNTS: Record<ToolActivityKind, MessageKey> = {
  file_read: "toolRun.filesRead",
  web_read: "toolRun.pagesRead",
  file_search: "toolRun.searches",
  web_search: "toolRun.searches",
  file_write: "toolRun.changes",
  file_edit: "toolRun.changes",
  file_inspect: "toolRun.checks",
  git: "toolRun.checks",
  shell: "toolRun.commands",
  agent: "toolRun.delegations",
  memory: "toolRun.memories",
  routine: "toolRun.routines",
}

/**
 * The verb and subject of one action, present tense while it runs and past once done. Entries from
 * sessions recorded before actions were noted fall back to their label.
 */
function ActivityText({
  entry,
  done,
  className = "toolCard-label",
}: {
  entry: TranscriptEntry
  done: boolean
  className?: string
}) {
  const { t } = useI18n()
  const { activityAction: action, activitySubject: subject } = entry
  if (!action || subject === undefined) return <span className={className}>{entry.text}</span>
  const [name, folder] = splitSubject(action, subject)
  return (
    <span className={className}>
      <span className="toolCard-verb">{t(`tool.${action}.${done ? "done" : "doing"}`)}</span>
      <span className={PROSE_ACTIONS.has(action) ? "toolCard-prose" : "toolCard-subject"}>
        {name}
      </span>
      {folder === undefined ? null : <span className="toolCard-dir">· {folder}/</span>}
    </span>
  )
}

function runSummary(run: ToolRun, t: Translate) {
  const counts = new Map<MessageKey, number>()
  for (const entry of run.entries) {
    const key = RUN_COUNTS[entry.activityKind ?? "shell"]
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].map(([key, count]) => t(key, { count })).join(" · ")
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
          <ActivityText entry={entry} done={!active} />
        </div>
      )}
      {entry.diff ? <DiffView diff={entry.diff} /> : null}
    </div>
  )
}

/**
 * The row for a run of consecutive tool activity. While the run is live the label is keyed by the
 * latest action, so each new action replaces it with a short rise-and-fade (see
 * activity-status-in) — a burst reads as one status line in motion instead of a stack of cards.
 * Once settled the row sums up what the run did. It never renders its actions itself: expanding
 * flattens them into the virtualized transcript (see flattenExpandedRuns), keeping long runs
 * windowed.
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
        <span className="toolCard-icon toolRun-icon" key={active ? `icon-${latest.id}` : "settled"}>
          <Icon icon={active ? KIND_ICONS[latest.activityKind ?? "shell"] : ListChecks} size={13} />
        </span>
        {active ? (
          <ActivityText
            key={latest.id}
            entry={latest}
            done={false}
            className="toolCard-label toolRun-label"
          />
        ) : (
          <span className="toolCard-label">{runSummary(run, t)}</span>
        )}
        <span className="chevron">
          <ChevronRight size={13} aria-hidden />
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
