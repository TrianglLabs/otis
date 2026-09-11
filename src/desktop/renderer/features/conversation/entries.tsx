import { ChevronDown, ChevronRight, ShipWheel } from "lucide-react"
import { memo } from "react"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import { Icon } from "../../components/Icon.js"
import { Markdown } from "../../components/Markdown.js"
import { OtisMark } from "../../components/OtisMark.js"
import { formatDuration } from "../../format.js"
import { ToolCard } from "./ToolCard.js"

/** Renders one transcript entry. The same components render live turns and replayed sessions. */
export const EntryView = memo(function EntryView({
  entry,
  active,
  thinkingVisible,
  expanded,
  onExpandedChange,
}: {
  entry: TranscriptEntry
  active: boolean
  thinkingVisible: boolean
  expanded: boolean
  onExpandedChange: (id: number, expanded: boolean) => void
}) {
  if (entry.kind === "reasoning")
    return (
      <ReasoningCard
        entry={entry}
        thinkingVisible={thinkingVisible}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
      />
    )
  if (entry.kind === "tool") return <ToolCard entry={entry} active={active} />
  if (entry.kind === "debug") return <DebugLine entry={entry} />
  if (entry.speaker === "You") return <UserMessage entry={entry} />
  return <AssistantMessage entry={entry} />
})

function UserMessage({ entry }: { entry: TranscriptEntry }) {
  const steering = entry.delivery === "steering"
  return (
    <div className={`userRow${steering ? " userRow-steering" : ""}`}>
      {steering ? (
        <span className="steeringIndicator" role="img" aria-label="Steering" title="Steering the active turn">
          <Icon icon={ShipWheel} size={16} />
        </span>
      ) : null}
      {entry.delivery === "queued" ? <span className="deliveryTag">Queued</span> : null}
      <div className="userMessage">{entry.text}</div>
    </div>
  )
}

function AssistantMessage({ entry }: { entry: TranscriptEntry }) {
  const isError = entry.text.startsWith("Error:") || entry.text.startsWith("Could not")
  return (
    <div className={`assistantMessage${isError ? " assistantMessage-error" : ""}`}>
      <Markdown text={entry.text} />
    </div>
  )
}

function ThinkingStatus() {
  return (
    <span className="thinkingStatus" role="status">
      <OtisMark className="reasoning-cube" decorative />
      <span className="thinking-label">Thinking…</span>
    </span>
  )
}

function ReasoningCard({
  entry,
  thinkingVisible,
  expanded,
  onExpandedChange,
}: {
  entry: TranscriptEntry
  thinkingVisible: boolean
  expanded: boolean
  onExpandedChange: (id: number, expanded: boolean) => void
}) {
  if (!thinkingVisible) {
    // Traces off: only live thinking reaches here (finished traces are filtered upstream) — a quiet status
    // line, never the trace content itself.
    return (
      <div className="reasoning-text">
        <ThinkingStatus />
      </div>
    )
  }

  if (entry.streaming) {
    // Live thinking streams openly: a muted preview of the freshest lines, not interactive.
    const preview = entry.text.trimEnd().split("\n").slice(-3).join("\n")
    return (
      <div className="reasoning">
        <div className="reasoning-header reasoning-headerLive">
          <ThinkingStatus />
        </div>
        {preview ? <div className="reasoning-body reasoning-preview">{preview}</div> : null}
      </div>
    )
  }

  // Finished thinking is collapsed behind a quiet summary row.
  const label = entry.durationMs !== undefined ? `Thought for ${formatDuration(entry.durationMs)}` : "Thought"
  return (
    <div className="reasoning">
      <button
        type="button"
        className="reasoning-header"
        onClick={() => onExpandedChange(entry.id, !expanded)}
        aria-expanded={expanded}
      >
        <OtisMark className="reasoning-cube" decorative />
        <span className="reasoning-label">{label}</span>
        {expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
      </button>
      {expanded && entry.text ? <div className="reasoning-body">{entry.text}</div> : null}
    </div>
  )
}

function DebugLine({ entry }: { entry: TranscriptEntry }) {
  return <div className="debugLine">{entry.text}</div>
}
