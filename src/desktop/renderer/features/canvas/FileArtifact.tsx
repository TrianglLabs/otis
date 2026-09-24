import { Download } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { ArtifactMetadata, ArtifactPayload } from "../../../../artifacts/types.js"
import { IconButton } from "../../components/Button.js"
import { FileTypeIcon } from "../../components/FileTypeIcon.js"
import { Markdown } from "../../components/Markdown.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop } from "../../runtime.js"
import { PdfPreview } from "./PdfPreview.js"

const WORD_PREVIEW_CSS = `
  :root { color-scheme: light; font: 16px/1.6 ui-serif, Georgia, serif; color: #242321; background: #e9e7e2; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 48px; }
  main { width: min(720px, 100%); min-height: calc(100vh - 48px); margin: 0 auto; padding: 48px clamp(28px, 7vw, 72px); background: #fff; box-shadow: 0 4px 24px #0002; overflow-wrap: anywhere; }
  img, svg, video, canvas, table { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  h1, h2, h3 { line-height: 1.2; letter-spacing: -.02em; }
  h1 { margin-bottom: .4em; font-size: 2.2em; }
  h2 { margin-top: 1.8em; padding-bottom: .25em; border-bottom: 1px solid #ddd9d0; font-size: 1.35em; }
  table { width: 100%; border-collapse: collapse; font-size: .88em; }
  th, td { padding: 9px 10px; border: 1px solid #ddd9d0; text-align: left; vertical-align: top; }
  th { background: #f4f2ed; font-family: ui-sans-serif, system-ui, sans-serif; font-size: .82em; letter-spacing: .04em; text-transform: uppercase; }
  li + li { margin-top: .35em; }
  p:first-child, h1:first-child, h2:first-child { margin-top: 0; }
  @media (max-width: 520px) { body { padding: 0; } main { min-height: 100vh; padding: 28px 22px; box-shadow: none; } }
`

/** A session's open document; `runtime` names the session whose tab it is. */
export function FileArtifact({
  runtime,
  artifact,
}: {
  runtime: number
  artifact: ArtifactMetadata
}) {
  const { api } = useDesktop()
  const { t } = useI18n()
  // The previous payload stays on screen while a new revision of the same artifact loads; a
  // different artifact starts from the loading state.
  const [loaded, setLoaded] = useState<{ id: string; payload?: ArtifactPayload; error?: string }>()
  const payload = loaded?.id === artifact.id ? loaded.payload : undefined
  const error = loaded?.id === artifact.id ? loaded.error : undefined

  useEffect(() => {
    let current = true
    const id = artifact.id
    void api.getArtifact(runtime, artifact.id, artifact.revision).then(
      (result) => {
        if (!current) return
        if (result.ok) setLoaded({ id, payload: result.payload })
        else if (!result.stale) setLoaded({ id, error: result.reason })
      },
      (reason: unknown) => {
        if (!current) return
        setLoaded({
          id,
          error: reason instanceof Error ? reason.message : t("canvas.previewFailed"),
        })
      },
    )
    return () => {
      current = false
    }
  }, [api, runtime, artifact.id, artifact.revision])

  return (
    <section className="canvas-artifact" aria-label={artifact.title}>
      <header className="canvas-artifactHeader">
        <FileTypeIcon kind={artifact.kind} name={artifact.title} size="sm" />
        <span className="canvas-artifactIdentity">
          <strong title={artifact.path ?? artifact.title}>{artifact.title}</strong>
          {artifact.source === "workspace" ? <small>{t("canvas.workingFile")}</small> : null}
          {artifact.publication ? (
            <small>
              {t("canvas.savedVersion", { version: artifact.publication.reference.version })}
            </small>
          ) : null}
        </span>
        {artifact.publication && artifact.publication.versions.length > 1 ? (
          <ArtifactVersions
            key={artifact.id}
            runtime={runtime}
            publication={artifact.publication}
          />
        ) : null}
        <ArtifactSave
          key={`${artifact.id}:${artifact.revision}`}
          runtime={runtime}
          id={artifact.id}
          revision={artifact.revision}
        />
      </header>
      <div className="canvas-artifactBody">
        {error ? <div className="canvas-empty">{error}</div> : null}
        {!error && !payload ? <div className="canvas-empty">{t("canvas.loading")}</div> : null}
        {payload?.kind === "markdown" ? (
          <article className="canvas-document canvas-document-markdown">
            <Markdown text={payload.content} enableCanvas={false} />
          </article>
        ) : null}
        {payload?.kind === "pdf" ? <PdfPreview key={artifact.id} data={payload.content} /> : null}
        {payload?.kind === "docx" ? (
          <iframe
            className="canvas-frame"
            title={payload.title}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:"><title>${payload.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</title><style>${WORD_PREVIEW_CSS}</style></head><body><main>${payload.content}</main></body></html>`}
          />
        ) : null}
        {payload?.kind === "html" ? (
          <WebpagePreview key={artifact.id} source={payload.content} title={payload.title} />
        ) : null}
      </div>
    </section>
  )
}

/** Export reads the original bytes of the selected reference, so it does not wait on the preview. */
function ArtifactSave({
  runtime,
  id,
  revision,
}: {
  runtime: number
  id: string
  revision: number
}) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const save = async () => {
    setSaving(true)
    setError(undefined)
    try {
      const result = await api.saveArtifact(runtime, id, revision)
      if (!result.ok) setError(result.reason)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("canvas.saveFailed"))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="canvas-artifactSave">
      <IconButton
        icon={Download}
        label={t("canvas.saveCopy")}
        disabled={saving}
        onClick={() => void save()}
      />
      {error ? <span role="alert">{error}</span> : null}
    </div>
  )
}

function ArtifactVersions({
  runtime,
  publication,
}: {
  runtime: number
  publication: NonNullable<ArtifactMetadata["publication"]>
}) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const [error, setError] = useState<string>()
  const [opening, setOpening] = useState(false)
  const select = async (value: string) => {
    setError(undefined)
    setOpening(true)
    try {
      const result = await api.openArtifact(
        publication.reference,
        value === "latest" ? undefined : Number(value),
        runtime,
      )
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
        <option value="latest">
          {t("canvas.latestVersion", { version: publication.versions.at(-1) ?? 1 })}
        </option>
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

function WebpagePreview({ source, title }: { source: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const sendSource = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ type: "otis-webpage-source", source, title }, "*")
  }, [source, title])
  useEffect(sendSource, [sendSource])
  // The sandboxed preview relays link clicks; only its own window may ask, and only for http(s).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      if (event.data?.type !== "otis-webpage-link" || typeof event.data.url !== "string") return
      if (/^https?:\/\//i.test(event.data.url)) window.open(event.data.url, "_blank", "noopener")
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])
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
