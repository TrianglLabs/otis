import { Brain, ChevronDown, ChevronRight, ShipWheel } from "lucide-react"
import { useState } from "react"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import { Icon } from "../../components/Icon.js"
import { Markdown } from "../../components/Markdown.js"
import { formatDuration } from "../../format.js"
import { ToolCard } from "./ToolCard.js"

/** Renders one transcript entry. The same components render live turns and replayed sessions. */
export function EntryView({
  entry,
  active,
  thinkingVisible,
}: {
  entry: TranscriptEntry
  active: boolean
  thinkingVisible: boolean
}) {
  if (entry.kind === "reasoning") return <ReasoningCard entry={entry} thinkingVisible={thinkingVisible} />
  if (entry.kind === "tool") return <ToolCard entry={entry} active={active} />
  if (entry.kind === "debug") return <DebugLine entry={entry} />
  if (entry.speaker === "You") return <UserMessage entry={entry} />
  return <AssistantMessage entry={entry} />
}

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

function ReasoningCard({ entry, thinkingVisible }: { entry: TranscriptEntry; thinkingVisible: boolean }) {
  const [expanded, setExpanded] = useState(false)

  if (!thinkingVisible) {
    // Traces off: only live thinking reaches here (finished traces are filtered upstream) — a quiet status
    // line, never the trace content itself.
    return <div className="reasoning-text">Thinking…</div>
  }

  if (entry.streaming) {
    // Live thinking streams openly: a muted preview of the freshest lines, not interactive.
    const preview = entry.text.trimEnd().split("\n").slice(-3).join("\n")
    return (
      <div className="reasoning">
        <div className="reasoning-header reasoning-headerLive">
          <Brain size={13} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden />
          <span className="reasoning-label reasoning-live">Thinking…</span>
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
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <Brain size={13} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden />
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
