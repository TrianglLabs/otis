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
          {artifact.source === "workspace" ? <small>{t("canvas.workingFile")}</small> : null}
          {artifact.publication ? (
            <small>{t("canvas.savedVersion", { version: artifact.publication.reference.version })}</small>
          ) : null}
        </span>
        {artifact.publication && artifact.publication.versions.length > 1 ? (
          <ArtifactVersions key={artifact.id} publication={artifact.publication} />
        ) : null}
      </header>
      <div className="canvas-artifactBody">
        {error ? <CanvasNotice>{error}</CanvasNotice> : null}
        {!error && !payload ? <CanvasNotice>{t("canvas.loading")}</CanvasNotice> : null}
        {payload ? <ArtifactPreview payload={payload} /> : null}
      </div>
    </section>
  )
}

function ArtifactVersions({ publication }: { publication: NonNullable<ArtifactMetadata["publication"]> }) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const [error, setError] = useState<string>()
  const [opening, setOpening] = useState(false)
  const select = async (value: string) => {
    setError(undefined)
    setOpening(true)
    try {
      const result = await api.openArtifact(publication.reference, value === "latest" ? undefined : Number(value))
      if (!result.ok) setError(result.reason)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("canvas.previewFailed"))
    } finally {
      setOpening(false)
    }
  }
  return (
    <div className="canvas-artifactVersions">
      <select
        aria-label={t("canvas.versionHistory")}
        disabled={opening}
        value={publication.followingLatest ? "latest" : String(publication.reference.version)}
        onChange={(event) => void select(event.target.value)}
      >
        <option value="latest">{t("canvas.latestVersion", { version: publication.versions.at(-1) ?? 1 })}</option>
        {publication.versions.map((version) => (
          <option key={version} value={version}>
            {t("canvas.savedVersion", { version })}
          </option>
        ))}
      </select>
      {error ? <span role="alert">{error}</span> : null}
    </div>
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
