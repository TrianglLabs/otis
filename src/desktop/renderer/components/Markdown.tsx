import type { Element, ElementContent, Root, Text } from "hast"
import { Check, Copy } from "lucide-react"
import { createContext, isValidElement, memo, useContext, useEffect, useRef, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import rehypeKatex from "rehype-katex"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math-extended"
import { useOpenCanvas } from "../features/canvas/canvas-context.js"
import { MermaidFrame } from "../features/canvas/MermaidFrame.js"
import { useI18n } from "../i18n/index.js"
import { useDesktop } from "../runtime.js"
import { ArtifactCard } from "./ArtifactCard.js"
import { IconButton } from "./Button.js"

/**
 * A Markdown file shown as a Canvas document. It renders TeX math and Mermaid inline and resolves
 * images relative to itself; chat Markdown keeps dollars literal and offers diagrams as cards.
 */
export type DocumentSource = { runtime: number; id: string; revision: number }

/** Assistant-facing Markdown: GFM, external links in the system browser, copyable code blocks. */
const remarkPlugins = [remarkGfm]
// Documents opt into TeX math in dollar and `\(…\)` / `\[…\]` form; chat stays literal so
// prices are not equations.
const documentRemarkPlugins = [remarkGfm, remarkMath]
const rehypePlugins = [trimCodeNewline, rehypeHighlight]
const documentRehypePlugins = [trimCodeNewline, rehypeHighlight, rehypeKatex]
const DocumentContext = createContext<DocumentSource | undefined>(undefined)
const CardsContext = createContext(true)
// Component types must survive text updates, otherwise React remounts code/table subtrees and loses
// selection, horizontal scrolling, and copy-button state.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  img: ({ src, alt, title }) => <Image src={src} alt={alt} title={title} />,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="md-tableWrap">
      <table>{children}</table>
    </div>
  ),
}

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  document,
}: {
  text: string
  streaming?: boolean
  document?: DocumentSource
}) {
  // A streaming message would parse whole on every token. The blocks before its last paragraph
  // break are final, so they keep their tree and only the open tail parses again.
  const settled = streaming ? settledBlocksEnd(text) : 0
  return (
    <DocumentContext.Provider value={document}>
      <CardsContext.Provider value={!streaming}>
        <div className="md">
          {settled > 0 ? <Blocks text={text.slice(0, settled)} document={!!document} /> : null}
          <Blocks text={text.slice(settled)} streaming={streaming} document={!!document} />
        </div>
      </CardsContext.Provider>
    </DocumentContext.Provider>
  )
})

const Blocks = memo(function Blocks({
  text,
  streaming,
  document,
}: {
  text: string
  streaming?: boolean
  document: boolean
}) {
  return (
    <ReactMarkdown
      remarkPlugins={document ? documentRemarkPlugins : remarkPlugins}
      rehypePlugins={
        document ? documentRehypePlugins : streaming ? streamingRehypePlugins : rehypePlugins
      }
      components={components}
    >
      {text}
    </ReactMarkdown>
  )
})

/**
 * Wraps each word of a streaming tail so it fades in as it arrives. Positions stay stable while
 * words append, so React keeps the earlier spans and only the new ones animate. Code stays whole.
 */
const streamingRehypePlugins = [...rehypePlugins, () => (tree: Root) => splitWords(tree)]

function splitWords(node: Root | Element) {
  node.children = (node.children as ElementContent[]).flatMap((child): ElementContent[] => {
    if (child.type === "element") {
      if (child.tagName !== "code") splitWords(child)
      return [child]
    }
    if (child.type !== "text") return [child]
    return child.value
      .split(/(\s+)/)
      .filter(Boolean)
      .map((part): Element | Text =>
        /^\s+$/.test(part)
          ? { type: "text", value: part }
          : {
              type: "element",
              tagName: "span",
              properties: { className: ["streamWord"] },
              children: [{ type: "text", value: part }],
            },
      )
  })
}

/** Markdown gives fenced code a trailing newline, which would render as a blank last line. */
function trimCodeNewline() {
  const visit = (node: Root | Element) => {
    for (const child of node.children) {
      if (child.type !== "element") continue
      if (child.tagName !== "pre") {
        visit(child)
        continue
      }
      const code = child.children[0]
      const last = code?.type === "element" ? code.children.at(-1) : undefined
      if (last?.type === "text") last.value = last.value.replace(/\n+$/, "")
    }
  }
  return visit
}

/** The end of the last paragraph break outside a fenced code block, or 0. */
function settledBlocksEnd(text: string) {
  for (let end = text.lastIndexOf("\n\n"); end > 0; end = text.lastIndexOf("\n\n", end - 1)) {
    const fences = text.slice(0, end).match(/^ {0,3}(```|~~~)/gm)?.length ?? 0
    if (fences % 2 === 0) return end + 2
  }
  return 0
}

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const { t } = useI18n()
  // react-markdown renders fenced code as <pre><code className="language-x">…</code></pre>, with
  // highlight tokens nested inside once the language is known.
  const codeProps = isValidElement<{ className?: string; children?: React.ReactNode }>(children)
    ? children.props
    : undefined
  const language = /language-(\w+)/.exec(codeProps?.className ?? "")?.[1]
  const text = extractText(codeProps?.children)
  const openCanvas = useOpenCanvas()
  const document = useContext(DocumentContext)
  const cards = useContext(CardsContext)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard can be unavailable (e.g. permissions); leave the button in its idle state.
    }
  }

  if (language?.toLowerCase() === "mermaid") {
    if (document)
      return (
        <figure className="md-diagram">
          <MermaidFrame source={text} inline />
        </figure>
      )
    if (openCanvas && cards)
      return (
        <ArtifactCard
          kind="mermaid"
          title={t("canvas.diagram")}
          actionLabel={t("markdown.openCanvas")}
          onOpen={() => openCanvas(text)}
        />
      )
  }

  return (
    <figure className="codeBlock">
      <figcaption>
        <span className="codeBlock-lang">{language ?? t("markdown.code")}</span>
        <span className="codeBlock-actions">
          <IconButton
            icon={copied ? Check : Copy}
            label={copied ? t("markdown.copied") : t("markdown.copyCode")}
            onClick={copy}
            size={22}
          />
        </span>
      </figcaption>
      <pre>
        <code className={codeProps?.className}>{codeProps?.children}</code>
      </pre>
    </figure>
  )
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node
  if (typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(extractText).join("")
  if (isValidElement<{ children?: React.ReactNode }>(node)) return extractText(node.props.children)
  return ""
}

/** Absolute and inline sources load as written; a document's relative paths come from its folder. */
function Image({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const document = useContext(DocumentContext)
  if (!src || !document || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(src))
    return <img src={src} alt={alt} title={title} />
  return <WorkspaceImage document={document} src={src} alt={alt ?? ""} title={title} />
}

function WorkspaceImage({
  document,
  src,
  alt,
  title,
}: {
  document: DocumentSource
  src: string
  alt: string
  title?: string
}) {
  const { api } = useDesktop()
  const [state, setState] = useState<{ url?: string; error?: string }>({})
  useEffect(() => {
    let url: string | undefined
    let current = true
    setState({})
    void api.getArtifactAsset(document.runtime, document.id, document.revision, src).then(
      (result) => {
        if (!current) return
        if (!result.ok) {
          if (!result.stale) setState({ error: result.reason })
          return
        }
        const { bytes, mimeType } = result.asset
        url = URL.createObjectURL(new Blob([bytes.slice()], { type: mimeType }))
        setState({ url })
      },
      (reason: unknown) => {
        if (current) setState({ error: reason instanceof Error ? reason.message : String(reason) })
      },
    )
    return () => {
      current = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [api, document.runtime, document.id, document.revision, src])
  if (state.error)
    return (
      <span className="md-imageMissing" role="img" aria-label={alt || src} title={state.error}>
        {alt || src}
      </span>
    )
  return <img src={state.url} alt={alt} title={title} />
}
