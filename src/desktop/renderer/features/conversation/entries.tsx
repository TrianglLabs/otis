import { ChevronDown, ChevronRight, ListEnd, ShipWheel } from "lucide-react"
import { memo, useContext } from "react"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import { isCanvasArtifact } from "../../../../artifacts/canvas.js"
import type { ArtifactReference } from "../../../../artifacts/types.js"
import { ArtifactCard } from "../../components/ArtifactCard.js"
import { Icon } from "../../components/Icon.js"
import { Markdown } from "../../components/Markdown.js"
import { OtisMark } from "../../components/OtisMark.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop } from "../../runtime.js"
import { PaneRuntimeContext } from "../canvas/canvas-context.js"
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
  const { t } = useI18n()
  if (entry.kind === "tool") return <ToolCard entry={entry} active={active} />
  if (entry.kind === "debug") return <div className="debugLine">{entry.text}</div>
  if (entry.kind === "reasoning") {
    // Traces off: only live thinking reaches here (finished traces are filtered upstream) — a quiet
    // status line, never the trace content itself.
    if (!thinkingVisible) {
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
    const ms = entry.durationMs
    const label =
      ms === undefined
        ? t("transcript.thought")
        : t("transcript.thoughtFor", {
            duration: ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`,
          })
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
          {expanded ? (
            <ChevronDown size={13} aria-hidden />
          ) : (
            <ChevronRight size={13} aria-hidden />
          )}
        </button>
        {expanded && entry.text ? <div className="reasoning-body">{entry.text}</div> : null}
      </div>
    )
  }
  if (entry.speaker === "You") {
    const steering = entry.delivery === "steering"
    const queued = entry.delivery === "queued"
    const text = entry.messageText ?? entry.text
    const steeringClass = steering ? " userRow-steering" : ""
    const queuedClass = queued ? " userRow-queued" : ""
    return (
      <div className={`userRow${steeringClass}${queuedClass}`}>
        {steering ? (
          <span
            className="steeringIndicator"
            role="img"
            aria-label={t("transcript.steering")}
            title={t("transcript.steeringTitle")}
          >
            <Icon icon={ShipWheel} size={16} />
          </span>
        ) : null}
        {queued ? (
          <span
            className="queuedIndicator"
            role="img"
            aria-label={t("transcript.queued")}
            title={t("transcript.queuedTitle")}
          >
            <Icon icon={ListEnd} size={16} />
          </span>
        ) : null}
        <div className={`userMessage${entry.artifacts?.length ? " userMessage-artifacts" : ""}`}>
          {text ? <span>{text}</span> : null}
          {entry.artifacts?.length ? <MessageArtifacts artifacts={entry.artifacts} /> : null}
        </div>
      </div>
    )
  }
  const isError = entry.text.startsWith("Error:") || entry.text.startsWith("Could not")
  return (
    <div className={`assistantMessage${isError ? " assistantMessage-error" : ""}`}>
      {entry.text ? <Markdown text={entry.text} enableCanvas={!entry.streaming} /> : null}
      {entry.artifacts?.length ? <MessageArtifacts artifacts={entry.artifacts} /> : null}
    </div>
  )
})

function MessageArtifacts({ artifacts }: { artifacts: ArtifactReference[] }) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const runtime = useContext(PaneRuntimeContext)
  return (
    <div className="messageArtifacts">
      {artifacts.map((artifact) => {
        const title =
          artifact.source === "workspace"
            ? (artifact.path.split("/").at(-1) ?? artifact.path)
            : artifact.name
        const key =
          artifact.source === "workspace"
            ? `workspace:${artifact.path}`
            : `attachment:${artifact.sha256}`
        if (!isCanvasArtifact(artifact.kind)) return <span key={key}>📄 {title}</span>
        return (
          <ArtifactCard
            key={key}
            kind={artifact.kind}
            title={title}
            actionLabel={t("markdown.openCanvas")}
            onOpen={() => api.openArtifact(artifact, undefined, runtime)}
          />
        )
      })}
    </div>
  )
}

function ThinkingStatus() {
  const { t } = useI18n()
  return (
    <span className="thinkingStatus" role="status">
      <OtisMark className="reasoning-cube" decorative />
      <span className="thinking-label">{t("transcript.thinking")}</span>
    </span>
  )
}
