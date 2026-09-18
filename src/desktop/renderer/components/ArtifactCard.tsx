import { ChevronRight } from "lucide-react"
import { useState } from "react"
import type { SessionOpResult } from "../../contracts.js"
import { useI18n } from "../i18n/index.js"
import { FileTypeIcon, type FileVisualKind } from "./FileTypeIcon.js"
import { Icon } from "./Icon.js"

export function ArtifactCard({
  kind,
  title,
  actionLabel,
  onOpen,
}: {
  kind: FileVisualKind
  title: string
  actionLabel: string
  onOpen: (() => void) | (() => Promise<SessionOpResult>)
}) {
  const { t } = useI18n()
  const [error, setError] = useState<string>()
  const [opening, setOpening] = useState(false)
  const open = async () => {
    setError(undefined)
    setOpening(true)
    try {
      const result = await onOpen()
      if (result && !result.ok) setError(result.reason)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("canvas.previewFailed"))
    } finally {
      setOpening(false)
    }
  }
  return (
    <>
      <button
        type="button"
        className={`artifactCard artifactCard-${kind}`}
        aria-label={`${actionLabel}: ${title}`}
        onClick={() => void open()}
        disabled={opening}
        aria-busy={opening}
      >
        <FileTypeIcon kind={kind} name={kind === "mermaid" ? undefined : title} />
        <span className="artifactCard-copy">
          <strong>{title}</strong>
          <span>{actionLabel}</span>
        </span>
        <Icon icon={ChevronRight} size={15} />
      </button>
      {error ? (
        <p className="artifactCard-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}
