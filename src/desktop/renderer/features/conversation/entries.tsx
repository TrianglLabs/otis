import { Brain, ChevronDown, ChevronRight } from "lucide-react"
import { useState } from "react"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import { Markdown } from "../../components/Markdown.js"
import { formatDuration } from "../../format.js"
import { ToolCard } from "./ToolCard.js"

/** Renders one transcript entry. The same components render live turns and replayed sessions. */
export function EntryView({ entry, active }: { entry: TranscriptEntry; active: boolean }) {
  if (entry.kind === "reasoning") return <ReasoningCard entry={entry} />
  if (entry.kind === "tool") return <ToolCard entry={entry} active={active} />
  if (entry.kind === "debug") return <DebugLine entry={entry} />
  if (entry.speaker === "You") return <UserMessage entry={entry} />
  return <AssistantMessage entry={entry} />
}

function UserMessage({ entry }: { entry: TranscriptEntry }) {
  return (
    <div className="userRow">
      {entry.delivery ? (
        <span className="deliveryTag">{entry.delivery === "queued" ? "Queued" : "Steering"}</span>
      ) : null}
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

function ReasoningCard({ entry }: { entry: TranscriptEntry }) {
  // Collapsed by default, including while streaming; the header still shows the live "Thinking…" label.
  const [expanded, setExpanded] = useState(false)
  const label = entry.streaming
    ? "Thinking…"
    : entry.durationMs !== undefined
      ? `Thought for ${formatDuration(entry.durationMs)}`
      : "Thought"
  return (
    <div className="reasoning">
      <button
        type="button"
        className="reasoning-header"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <Brain size={13} strokeWidth={1.5} strokeLinecap="butt" strokeLinejoin="miter" aria-hidden />
        <span className={entry.streaming ? "reasoning-label reasoning-live" : "reasoning-label"}>{label}</span>
        {expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
      </button>
      {expanded && entry.text ? <div className="reasoning-body">{entry.text}</div> : null}
    </div>
  )
}

function DebugLine({ entry }: { entry: TranscriptEntry }) {
  return <div className="debugLine">{entry.text}</div>
}
