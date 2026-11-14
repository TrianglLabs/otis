import { Download, Search } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ArtifactMetadata, ArtifactPayload, Sheet } from "../../../../artifacts/types.js"
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
import { ViewControls, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from "./ViewControls.js"

/**
 * A Word document as docx-preview lays it out: its own page sizes, margins and styles, on the
 * desk the decks sit on. `body` outranks docx-preview's wrapper rules, which follow these in the
 * page.
 */
const WORD_PREVIEW_CSS = `
  :root { color-scheme: light; background: #e9e7e2; }
  body { margin: 0; }
  body .docx-wrapper {
    min-height: 100vh; padding: 24px 16px 0; background: none; align-items: safe center;
  }
  body .docx-wrapper > section.docx { margin-bottom: 28px; box-shadow: 0 4px 24px #0002; }
`

/**
 * Lays a Word document out as pages and fits each page's width to the frame, as PDF pages fit the
 * panel; the view's zoom scales the whole document on top.
 *
 * docx-preview has no layout engine: a page holds everything up to the next page break. A page
 * whose content outgrows its height moves the first block that crosses its bottom margin, and
 * everything after it, to a new page of the same size, margins, header and footer. A table that
 * crosses splits between rows; a multi-column block moves whole; a block taller than a page stays,
 * as it would fit no better on the next. Text wraps differently at each zoom, so pages are
 * measured as shown and laid out again from the document once the fonts are in, and whenever the
 * frame or the view's zoom changes. Styles and offsets are in the page's own units; boxes are on
 * screen.
 */
const WORD_LAYOUT_SCRIPT = `<script>(() => {
  const wrapper = document.querySelector(".docx-wrapper")
  const source = wrapper.innerHTML
  const pages = () => wrapper.querySelectorAll(":scope > section.docx")
  const fit = () => {
    for (const page of pages())
      page.style.zoom = String((innerWidth - 32) / parseFloat(getComputedStyle(page).width))
  }
  const layout = () => {
    wrapper.innerHTML = source
    fit()
    for (let page = pages()[0]; page; page = page.nextElementSibling) {
      const style = getComputedStyle(page)
      const height = parseFloat(style.minHeight)
      if (page.offsetHeight <= height + 1) continue
      const box = page.getBoundingClientRect()
      const footer = page.querySelector(":scope > footer")
      const floor =
        height - parseFloat(style.paddingBottom) -
        (footer ? footer.offsetHeight + parseFloat(getComputedStyle(footer).marginBottom) : 0)
      const bottom = box.top + (floor * box.width) / parseFloat(style.width)
      const articles = [...page.querySelectorAll(":scope > article")]
      let split
      let placed = false
      for (const article of articles) {
        const columns = Number(getComputedStyle(article).columnCount)
        const blocks = columns > 1 ? [article] : [...article.children]
        for (const block of blocks) {
          const crosses = block.getBoundingClientRect().bottom > bottom
          const rows = crosses && block.tagName === "TABLE" ? [...block.rows] : []
          const row = rows.findIndex((row) => row.getBoundingClientRect().bottom > bottom)
          if (row > 0) {
            const rest = block.cloneNode(false)
            const colgroup = block.querySelector(":scope > colgroup")
            if (colgroup) rest.append(colgroup.cloneNode(true))
            rest.append(document.createElement("tbody"))
            rest.lastChild.append(...rows.slice(row))
            block.after(rest)
            split = { article, block: rest }
            break
          }
          if (crosses && placed) {
            split = { article, block }
            break
          }
          placed = true
        }
        if (split) break
      }
      if (!split) continue
      const next = page.cloneNode(false)
      const header = page.querySelector(":scope > header")
      if (header) next.append(header.cloneNode(true))
      const { article, block } = split
      const whole = block === article || block === article.firstElementChild
      const moved = whole ? article : article.cloneNode(false)
      if (!whole) {
        const blocks = [...article.children]
        moved.append(...blocks.slice(blocks.indexOf(block)))
      }
      next.append(moved, ...articles.slice(articles.indexOf(article) + 1))
      if (footer) next.append(footer.cloneNode(true))
      page.after(next)
    }
  }
  let timer
  const relayout = () => {
    clearTimeout(timer)
    timer = setTimeout(layout, 150)
  }
  fit()
  document.fonts.ready.then(layout)
  addEventListener("resize", () => {
    fit()
    relayout()
  })
  new MutationObserver(relayout).observe(document.documentElement, { attributeFilter: ["style"] })
})()</script>`

/**
 * A deck: each slide a box of the deck's aspect ratio, every shape placed by percentage and
 * sized in container units, so the slide scales with the panel and the zoom.
 */
const SLIDES_PREVIEW_CSS = `
  :root { color-scheme: light; font: 16px/1.2 ui-sans-serif, system-ui, sans-serif; color: #000; background: #e9e7e2; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 48px; }
  .slide { width: min(960px, 100%); margin: 0 auto 28px; }
  .frame { position: relative; overflow: hidden; container-type: inline-size; box-shadow: 0 4px 24px #0002; }
  .n { display: block; margin-top: 6px; color: #0008; font-size: 11px; text-align: center; }
  .shape { position: absolute; overflow: hidden; }
  .shape img { display: block; width: 100%; height: 100%; object-fit: fill; }
  .text { display: flex; flex-direction: column; width: 100%; height: 100%; overflow-wrap: anywhere; }
  .text p { margin: 0; }
  .bullet { display: inline-block; text-indent: 0; }
  .shape table { width: 100%; height: 100%; border-collapse: collapse; table-layout: fixed; }
  .shape td { padding: 0; border: 1px solid #0002; vertical-align: top; }
  .shape td .text { height: auto; }
  .chart { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; border: 1px dashed #0004; color: #0008; font-size: 2.4cqw; }
  a { color: inherit; }
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
  const [loaded, setLoaded] = useState<{
    id: string
    payload?: ArtifactPayload
    /** A Word document's pages as HTML. */
    word?: string
    error?: string
  }>()
  const payload = loaded?.id === artifact.id ? loaded.payload : undefined
  const word = loaded?.id === artifact.id ? loaded.word : undefined
  const error = loaded?.id === artifact.id ? loaded.error : undefined
  const [zoom, setZoom] = useState(1)
  /** Which sheet of a workbook shows; the view is keyed per document, so it starts over. */
  const [sheet, setSheet] = useState(0)
  const finder = useFind()
  // Previews receive the current match's document-order index.
  const find = finder.request
  const body = useRef<HTMLDivElement>(null)
  const article = useRef<HTMLElement>(null)

  useEffect(() => {
    let current = true
    const id = artifact.id
    void api
      .getArtifact(runtime, artifact.id, artifact.revision)
      .then(async (result) => {
        if (!current) return
        if (!result.ok) {
          if (!result.stale) setLoaded({ id, error: result.reason })
          return
        }
        const { payload } = result
        let word: string | undefined
        if (payload.kind === "docx") {
          // Loaded on first use. Images and fonts inline as data URLs, the only kind the
          // preview frame loads; the laid-out nodes reach the frame as their markup.
          const { parseAsync, renderDocument } = await import("docx-preview")
          const options = { useBase64URL: true, ignoreLastRenderedPageBreak: false }
          const parsed = await parseAsync(payload.content, options)
          // Pages come from measuring in the frame, not from Word's saved page-break hints,
          // which follow Word's fonts rather than these. Honoring no hints, docx-preview groups
          // sections onto pages only as page breaks say, so each section break gets the one its
          // next section asks for: a new page unless that section is continuous.
          const { body } = parsed.documentPart
          const paragraphs = body.children.filter(
            (block: { type: string }) => block.type === "paragraph",
          )
          for (const run of paragraphs.flatMap(
            (paragraph: { children: object[] }) => paragraph.children,
          ))
            run.children = run.children?.filter(
              (child: { break?: string }) => child.break !== "lastRenderedPageBreak",
            )
          const ends = paragraphs.filter(
            (paragraph: { sectionProps?: object }) => paragraph.sectionProps,
          )
          ends.forEach((paragraph: { children: object[] }, index: number) => {
            if ((ends[index + 1]?.sectionProps ?? body.props).type !== "continuous")
              paragraph.children.push({ type: "run", children: [{ type: "break", break: "page" }] })
          })
          const pages = document.createElement("div")
          pages.append(...(await renderDocument(parsed, options)))
          word = pages.innerHTML
        }
        if (current) setLoaded({ id, payload, word })
      })
      .catch((reason: unknown) => {
        if (!current) return
        setLoaded({
          id,
          error: reason instanceof Error ? reason.message : t("canvas.previewFailed"),
        })
      })
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

  // Markdown and sheets render into this window, so their matches are found and painted here.
  useEffect(() => {
    const root = article.current
    if (!root) return
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
  // Source HTML as it is; a converted Office document inside a page styled for its kind.
  const office = word ?? (payload?.encoding === "html" ? payload.content : undefined)
  const framed =
    payload && office !== undefined
      ? `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${payload.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</title><style>${payload.kind === "docx" ? WORD_PREVIEW_CSS : SLIDES_PREVIEW_CSS}</style></head><body>${office}${payload.kind === "docx" ? WORD_LAYOUT_SCRIPT : ""}</body></html>`
      : payload?.kind === "html"
        ? payload.content
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
        {payload?.encoding === "sheets" && payload.content.sheets.length > 1 ? (
          <div className="canvas-artifactVersions">
            <select
              aria-label={t("canvas.sheets")}
              value={sheet}
              onChange={(event) => setSheet(Number(event.target.value))}
            >
              {payload.content.sheets.map((entry, index) => (
                <option key={String(index)} value={index}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="canvas-artifactActions">
          <IconButton icon={Search} label={t("canvas.find")} onClick={openFind} />
          <ArtifactSave
            key={`${artifact.id}:${artifact.revision}`}
            runtime={runtime}
            id={artifact.id}
            revision={artifact.revision}
          />
        </div>
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
        {payload?.encoding === "sheets" ? (
          <article ref={article} className="canvas-document canvas-document-sheet">
            <SheetPreview
              sheet={payload.content.sheets[sheet] ?? payload.content.sheets[0]}
              truncated={payload.content.truncated}
              zoom={zoom}
            />
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
        {framed ? (
          <WebpagePreview
            key={artifact.id}
            source={framed}
            title={payload?.title ?? artifact.title}
            zoom={zoom}
            find={find}
            onMatches={finder.setMatchCount}
            onShortcut={shortcut}
          />
        ) : null}
        {payload ? (
          <ViewControls
            label={t("canvas.viewControls")}
            zoom={zoom}
            onZoom={scaleZoom}
            onReset={() => scaleZoom(0)}
          />
        ) : null}
      </div>
    </section>
  )
}

/**
 * One sheet as a grid with lettered columns and numbered rows. Cells that read as numbers sit
 * to the right, as a spreadsheet shows them.
 */
function SheetPreview({
  sheet,
  truncated,
  zoom,
}: {
  sheet: Sheet
  truncated: boolean
  zoom: number
}) {
  const { t } = useI18n()
  const columns = Math.max(1, ...sheet.rows.map((row) => row.length))
  return (
    <div className="canvas-sheet" style={{ zoom }}>
      <table className="canvas-sheetGrid" aria-label={sheet.name}>
        <thead>
          <tr>
            <th scope="col" aria-label={t("canvas.sheetRow")} />
            {Array.from({ length: columns }, (_, index) => (
              <th key={index} scope="col">
                {columnName(index)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row, index) => (
            <tr key={index}>
              <th scope="row">{index + 1}</th>
              {Array.from({ length: columns }, (_, column) => {
                const cell = row[column] ?? ""
                return (
                  <td
                    key={column}
                    className={NUMERIC.test(cell) ? "canvas-sheetNumber" : undefined}
                  >
                    {cell}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated ? <p className="canvas-sheetNote">{t("canvas.sheetTruncated")}</p> : null}
    </div>
  )
}

const NUMERIC = /^[-+(]?[\d\s,.']*\d[\d\s,.']*%?\)?$/

/** Spreadsheet column names: A to Z, then AA onwards. */
function columnName(index: number) {
  let name = ""
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
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
