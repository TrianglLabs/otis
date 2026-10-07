import { Download, Minus, Plus, Search } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ArtifactMetadata, ArtifactPayload } from "../../../../artifacts/types.js"
import { IconButton } from "../../components/Button.js"
import { FileTypeIcon } from "../../components/FileTypeIcon.js"
import { Markdown } from "../../components/Markdown.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop } from "../../runtime.js"
import {
  clearHighlights,
  FindBar,
  type FindRequest,
  setHighlights,
  textRanges,
  useFind,
} from "./find.js"
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
const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEP = 1.2

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
  const [zoom, setZoom] = useState(1)
  const finder = useFind()
  // Previews receive the current match's document-order index.
  const find = finder.request
  const body = useRef<HTMLDivElement>(null)
  const article = useRef<HTMLElement>(null)

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

  const scaleZoom = useCallback((factor: number) => {
    setZoom((current) =>
      factor === 0 ? 1 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current * factor)),
    )
  }, [])
  const openFind = finder.open
  const closeFind = () => {
    finder.close()
    body.current?.focus()
  }
  /** Ctrl/Cmd shortcuts, from this window or relayed by a framed preview. */
  const shortcut = useCallback(
    (key: string) => {
      if (key === "f") openFind()
      else if (key === "=" || key === "+") scaleZoom(ZOOM_STEP)
      else if (key === "-") scaleZoom(1 / ZOOM_STEP)
      else if (key === "0") scaleZoom(0)
      else return false
      return true
    },
    [openFind, scaleZoom],
  )
  useEffect(() => {
    const target = body.current
    if (!target) return
    // Ctrl+wheel zooms the document instead of the page; React's wheel listeners are passive.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      scaleZoom(Math.exp(-event.deltaY * 0.002))
    }
    target.addEventListener("wheel", onWheel, { passive: false })
    return () => target.removeEventListener("wheel", onWheel)
  }, [scaleZoom])

  // Markdown renders into this window, so its matches are found and painted here.
  useEffect(() => {
    const root = article.current
    if (!root || payload?.kind !== "markdown") return
    const ranges = textRanges(root, find.query)
    finder.setMatchCount(ranges.length)
    const current = ranges[find.index]
    setHighlights(root, ranges, current ? [current] : [])
    current?.startContainer.parentElement?.scrollIntoView({ block: "center" })
    return () => clearHighlights(root)
  }, [payload, find.query, find.index])

  // Stable per revision, so find and zoom state changes do not re-parse the document.
  const documentSource = useMemo(
    () => ({ runtime, id: artifact.id, revision: artifact.revision }),
    [runtime, artifact.id, artifact.revision],
  )
  const wordSource =
    payload?.kind === "docx"
      ? `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${payload.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</title><style>${WORD_PREVIEW_CSS}</style></head><body><main>${payload.content}</main></body></html>`
      : undefined
  return (
    <section
      className="canvas-artifact"
      aria-label={artifact.title}
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return
        if (shortcut(event.key)) event.preventDefault()
      }}
    >
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
        <div className="canvas-viewControls" role="toolbar" aria-label={t("canvas.viewControls")}>
          <IconButton icon={Search} label={t("canvas.find")} onClick={openFind} />
          <IconButton
            icon={Minus}
            label={t("canvas.zoomOut")}
            disabled={zoom <= ZOOM_MIN}
            onClick={() => scaleZoom(1 / ZOOM_STEP)}
          />
          <button
            type="button"
            className="canvas-zoomLevel"
            aria-label={t("canvas.resetView")}
            title={t("canvas.resetView")}
            onClick={() => scaleZoom(0)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <IconButton
            icon={Plus}
            label={t("canvas.zoomIn")}
            disabled={zoom >= ZOOM_MAX}
            onClick={() => scaleZoom(ZOOM_STEP)}
          />
        </div>
        <ArtifactSave
          key={`${artifact.id}:${artifact.revision}`}
          runtime={runtime}
          id={artifact.id}
          revision={artifact.revision}
        />
      </header>
      {finder.finding ? (
        <FindBar
          find={finder}
          label={t("canvas.find")}
          placeholder={t("canvas.findPlaceholder")}
          onClose={closeFind}
        />
      ) : null}
      {/* Focusable by click, not by tab, so a document's shortcuts work once it is clicked into. */}
      <div ref={body} className="canvas-artifactBody" tabIndex={-1}>
        {error ? <div className="canvas-empty">{error}</div> : null}
        {!error && !payload ? (
          <div className="canvas-empty" role="status">
            {t("canvas.loading")}
          </div>
        ) : null}
        {payload?.kind === "markdown" ? (
          <article ref={article} className="canvas-document canvas-document-markdown">
            <div style={{ zoom }}>
              <Markdown text={payload.content} document={documentSource} />
            </div>
          </article>
        ) : null}
        {payload?.kind === "pdf" ? (
          <PdfPreview
            key={artifact.id}
            data={payload.content}
            zoom={zoom}
            find={find}
            onMatches={finder.setMatchCount}
          />
        ) : null}
        {payload?.kind === "html" || wordSource ? (
          <WebpagePreview
            key={artifact.id}
            source={wordSource ?? (payload?.content as string)}
            title={payload?.title ?? artifact.title}
            zoom={zoom}
            find={find}
            onMatches={finder.setMatchCount}
            onShortcut={shortcut}
          />
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

/**
 * Source HTML, or a Word document converted to it, in the sandboxed preview frame. The frame's
 * agent finds and zooms inside the page and relays link clicks and shortcuts back out.
 */
function WebpagePreview({
  source,
  title,
  zoom,
  find,
  onMatches,
  onShortcut,
}: {
  source: string
  title: string
  zoom: number
  find: FindRequest
  onMatches: (count: number) => void
  onShortcut: (key: string) => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  // Counts the page's agent announcing itself: view requests wait for it and resend on reload.
  const [ready, setReady] = useState(0)
  const post = (message: object) => frame.current?.contentWindow?.postMessage(message, "*")
  const sendSource = useCallback(() => {
    post({ type: "otis-webpage-source", source, title })
  }, [source, title])
  useEffect(sendSource, [sendSource])
  useEffect(() => {
    if (ready > 0) post({ type: "otis-frame-zoom", zoom })
  }, [zoom, ready])
  useEffect(() => {
    if (ready > 0) post({ type: "otis-frame-find", query: find.query, index: find.index })
  }, [find.query, find.index, ready])
  // Only the preview's own window may ask, and links open only for http(s).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const data = event.data
      if (data?.type === "otis-frame-ready") setReady((count) => count + 1)
      else if (data?.type === "otis-frame-link" && /^https?:\/\//i.test(String(data.url)))
        window.open(data.url, "_blank", "noopener")
      else if (data?.type === "otis-frame-matches" && typeof data.count === "number")
        onMatches(data.count)
      else if (data?.type === "otis-frame-key" && typeof data.key === "string") onShortcut(data.key)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [onMatches, onShortcut])
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
