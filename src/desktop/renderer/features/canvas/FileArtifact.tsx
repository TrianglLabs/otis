import { useCallback, useEffect, useRef, useState } from "react"
import type { ArtifactMetadata, ArtifactPayload } from "../../../../artifacts/types.js"
import { FileTypeIcon } from "../../components/FileTypeIcon.js"
import { Markdown } from "../../components/Markdown.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop } from "../../runtime.js"
import { PdfPreview } from "./PdfPreview.js"
import { wordPreviewDocument } from "./preview-html.js"

export function FileArtifact({ artifact }: { artifact: ArtifactMetadata }) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const [payload, setPayload] = useState<ArtifactPayload>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let current = true
    setPayload(undefined)
    setError(undefined)
    void api.getArtifact(artifact.revision).then(
      (value) => {
        if (!current) return
        if (value) setPayload(value)
        else setError(t("canvas.previewFailed"))
      },
      (reason: unknown) => {
        if (!current) return
        setError(reason instanceof Error ? reason.message : t("canvas.previewFailed"))
      },
    )
    return () => {
      current = false
    }
  }, [api, artifact.id, artifact.revision, t])

  return (
    <section className="canvas-artifact" aria-label={artifact.title}>
      <header className="canvas-artifactHeader">
        <FileTypeIcon kind={artifact.kind} name={artifact.title} size="sm" />
        <span className="canvas-artifactIdentity">
          <strong title={artifact.path ?? artifact.title}>{artifact.title}</strong>
        </span>
      </header>
      <div className="canvas-artifactBody">
        {error ? <CanvasNotice>{error}</CanvasNotice> : null}
        {!error && !payload ? <CanvasNotice>{t("canvas.loading")}</CanvasNotice> : null}
        {payload ? <ArtifactPreview payload={payload} /> : null}
      </div>
    </section>
  )
}

function ArtifactPreview({ payload }: { payload: ArtifactPayload }) {
  if (payload.kind === "markdown") {
    return (
      <article className="canvas-document canvas-document-markdown">
        <Markdown text={payload.content} enableCanvas={false} />
      </article>
    )
  }
  if (payload.kind === "text") return <pre className="canvas-document canvas-document-text">{payload.content}</pre>
  if (payload.kind === "pdf") return <PdfPreview source={payload.content} />
  if (payload.kind === "docx") {
    return (
      <iframe
        className="canvas-frame"
        title={payload.title}
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        srcDoc={wordPreviewDocument(payload.content, payload.title)}
      />
    )
  }
  return <WebpagePreview source={payload.content} title={payload.title} />
}

function WebpagePreview({ source, title }: { source: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const sendSource = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ type: "otis-webpage-source", source, title }, "*")
  }, [source, title])
  useEffect(sendSource, [sendSource])
  return (
    <iframe
      ref={frame}
      className="canvas-frame"
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={new URL("webpage.html", location.href).href}
      onLoad={sendSource}
    />
  )
}

function CanvasNotice({ children }: { children: React.ReactNode }) {
  return <div className="canvas-empty">{children}</div>
}
