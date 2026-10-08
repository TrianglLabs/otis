import { ChevronRight, ListEnd, ShipWheel } from "lucide-react"
import { memo, useContext, useLayoutEffect, useRef } from "react"
import { ThinkingOrb } from "thinking-orbs"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import { isCanvasArtifact } from "../../../../artifacts/canvas.js"
import type { ArtifactReference } from "../../../../artifacts/types.js"
import { ArtifactCard } from "../../components/ArtifactCard.js"
import { FileTypeIcon } from "../../components/FileTypeIcon.js"
import { Icon } from "../../components/Icon.js"
import { Markdown } from "../../components/Markdown.js"
import { formatElapsed } from "../../format.js"
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
      const preview = entry.text.trimEnd()
      return (
        <div className="reasoning">
          <div className="reasoning-header reasoning-headerLive">
            <ThinkingStatus />
          </div>
          {preview ? <ReasoningPreview text={preview} /> : null}
        </div>
      )
    }
    // Finished thinking is collapsed behind a quiet summary row.
    const label =
      entry.durationMs === undefined
        ? t("transcript.thought")
        : t("transcript.thoughtFor", { duration: formatElapsed(entry.durationMs) })
    return (
      <div className="reasoning">
        <button
          type="button"
          className="reasoning-header"
          onClick={() => onExpandedChange(entry.id, !expanded)}
          aria-expanded={expanded}
        >
          <span className="reasoning-label">{label}</span>
          <span className="chevron">
            <ChevronRight size={13} aria-hidden />
          </span>
        </button>
        {expanded && entry.text ? <div className="reasoning-body">{entry.text}</div> : null}
      </div>
    )
  }
  if (entry.speaker === "You") {
    const steering = entry.delivery === "steering"
    const queued = entry.delivery === "queued"
    const text = entry.messageText ?? entry.text
    const attached = Boolean(entry.images?.length || entry.artifacts?.length)
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
        <div className={`userMessage${attached ? " userMessage-artifacts" : ""}`}>
          {text ? <span>{text}</span> : null}
          {attached ? (
            <MessageArtifacts artifacts={entry.artifacts ?? []} images={entry.images ?? []} />
          ) : null}
        </div>
      </div>
    )
  }
  const isError = entry.text.startsWith("Error:") || entry.text.startsWith("Could not")
  return (
    <div className={`assistantMessage${isError ? " assistantMessage-error" : ""}`}>
      {entry.text ? <Markdown text={entry.text} streaming={entry.streaming} /> : null}
      {entry.artifacts?.length ? <MessageArtifacts artifacts={entry.artifacts} /> : null}
    </div>
  )
})

/** The name a message shows for what it carries: the file's own, or the last path segment. */
export const artifactTitle = (artifact: ArtifactReference) =>
  artifact.source === "workspace"
    ? (artifact.path.split("/").at(-1) ?? artifact.path)
    : artifact.name

/**
 * What a message carried besides its words: documents Canvas can open get a card; images and
 * other files get a chip with their type mark, the same material as the composer's previews.
 */
function MessageArtifacts({
  artifacts,
  images = [],
}: {
  artifacts: ArtifactReference[]
  images?: string[]
}) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const runtime = useContext(PaneRuntimeContext)
  const key = (artifact: ArtifactReference) =>
    artifact.source === "workspace" ? `workspace:${artifact.path}` : `attachment:${artifact.sha256}`
  const chips = [
    ...images.map((name) => [`image:${name}`, name] as const),
    ...artifacts
      .filter((artifact) => !isCanvasArtifact(artifact.kind))
      .map((artifact) => [key(artifact), artifactTitle(artifact)] as const),
  ]
  return (
    <div className="messageArtifacts">
      {chips.length > 0 ? (
        <div className="messageAttachments">
          {chips.map(([id, name]) => (
            <span key={id} className="messageAttachment" title={name}>
              <FileTypeIcon name={name} size="xs" />
              <span>{name}</span>
            </span>
          ))}
        </div>
      ) : null}
      {artifacts
        .filter((artifact) => isCanvasArtifact(artifact.kind))
        .map((artifact) => (
          <ArtifactCard
            key={key(artifact)}
            kind={artifact.kind}
            title={artifactTitle(artifact)}
            actionLabel={t("markdown.openCanvas")}
            onOpen={() => api.openArtifact(artifact, undefined, runtime)}
          />
        ))}
    </div>
  )
}

/** How much of a live trace the preview holds: a few lines beyond the three in view. */
const PREVIEW_CHARS = 600

/**
 * The tail of the live trace in a three-line viewport that glides up as lines arrive, so the
 * freshest ones stay in view and each new word condenses into place. Only the tail is rendered:
 * a long trace streams thousands of words, and one span per word for all of them would make every
 * token reconcile the whole trace. Keys are offsets into the full text, so the spans that stay in
 * the tail keep their identity as it slides; the cut lands above the viewport, so a split word is
 * never seen.
 */
function ReasoningPreview({ text }: { text: string }) {
  const viewport = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  })
  let offset = Math.max(0, text.length - PREVIEW_CHARS)
  return (
    <div className="reasoning-body reasoning-preview" ref={viewport}>
      {text
        .slice(offset)
        .split(/(\s+)/)
        .map((part) => {
          const key = offset
          offset += part.length
          return /\S/.test(part) ? (
            <span key={key} className="streamWord">
              {part}
            </span>
          ) : (
            part
          )
        })}
    </div>
  )
}

function ThinkingStatus() {
  const { t } = useI18n()
  // The orb picks its ink from the document's light or dark class, which AppShell keeps current.
  return (
    <span className="thinkingStatus" role="status">
      <ThinkingOrb state="composing" size={20} className="thinkingOrb" aria-hidden />
      <span className="thinking-label" data-text={t("transcript.thinking")}>
        {t("transcript.thinking")}
      </span>
    </span>
  )
}
