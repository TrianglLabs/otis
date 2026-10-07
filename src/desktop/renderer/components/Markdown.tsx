import type { Element, ElementContent, Root, Text } from "hast"
import { Check, Copy } from "lucide-react"
import { factorySpace } from "micromark-factory-space"
import { markdownLineEnding } from "micromark-util-character"
import type {
  Code,
  Construct,
  Effects,
  Extension,
  State,
  TokenizeContext,
} from "micromark-util-types"
import { createContext, isValidElement, memo, useContext, useEffect, useRef, useState } from "react"
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import rehypeKatex from "rehype-katex"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math-extended"
import type { Processor } from "unified"
import { PaneRuntimeContext, useOpenCanvas } from "../features/canvas/canvas-context.js"
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
const documentRemarkPlugins = [remarkGfm, remarkMath, pandocMath]
const rehypePlugins = [trimCodeNewline, rehypeHighlight]
const documentRehypePlugins = [trimCodeNewline, rehypeHighlight, rehypeKatex]
const DocumentContext = createContext<DocumentSource | undefined>(undefined)
const CardsContext = createContext(true)
// Component types must survive text updates, otherwise React remounts code/table subtrees and loses
// selection, horizontal scrolling, and copy-button state.
const components: Components = {
  a: ({ href, children }) =>
    href?.startsWith(ARTIFACT_LINK) ? (
      <ArtifactLink artifactId={href.slice(ARTIFACT_LINK.length)}>{children}</ArtifactLink>
    ) : (
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
      urlTransform={urlTransform}
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

/**
 * Display math fences the way Pandoc and GitHub read them: `$$` may share its line with the
 * formula, opening or closing, and a closer ends the block at the end of any line. The parser's
 * own `$$` construct wants both fences alone on their lines and reads anything after an opener as
 * a label, so a document written the other way became one block running to its end. This
 * construct is registered ahead of it and emits the same tokens, so the math node and its hast
 * hints come from the parser's own builder; what it declines (a bare `$$` at the end of the file,
 * a `$$` line interrupting a paragraph) falls through to the library's.
 */
function pandocMath(this: Processor) {
  const data = this.data() as { micromarkExtensions?: Extension[] }
  data.micromarkExtensions ??= []
  data.micromarkExtensions.push({ flow: { 36: pandocMathFlow } })
}

const pandocMathFlow: Construct = { name: "mathFlow", concrete: true, tokenize: tokenizeMathFlow }

function tokenizeMathFlow(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this
  const tail = self.events[self.events.length - 1]
  const prefix =
    tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0
  const continuation: Construct = { tokenize: tokenizeContinuation, partial: true }
  const closing: Construct = { tokenize: tokenizeClosing, partial: true }
  let opening = true
  return start

  function start(code: Code): State | undefined {
    effects.enter("mathFlow")
    effects.enter("mathFlowFence")
    effects.enter("mathFlowFenceSequence")
    effects.consume(code)
    return open
  }
  function open(code: Code): State | undefined {
    if (code !== 36) return nok(code)
    effects.consume(code)
    effects.exit("mathFlowFenceSequence")
    effects.exit("mathFlowFence")
    return beforeContent
  }
  function beforeContent(code: Code): State | undefined {
    if (code === null) return nok(code)
    if (markdownLineEnding(code)) {
      if (self.interrupt) return ok(code)
      opening = false
      return effects.attempt(continuation, contentStart, nok)(code)
    }
    if (self.interrupt) return nok(code)
    if (code === 36) return effects.attempt(closing, after, valueStart)(code)
    effects.enter("mathFlowValue")
    return value(code)
  }
  function contentStart(code: Code): State | undefined {
    return (
      prefix ? factorySpace(effects, beforeContent, "linePrefix", prefix + 1) : beforeContent
    )(code)
  }
  function valueStart(code: Code): State | undefined {
    // A `$$` on the opening line that closes nothing is inline math in a paragraph, not a block.
    if (opening) return nok(code)
    effects.enter("mathFlowValue")
    effects.consume(code)
    return value
  }
  function value(code: Code): State | undefined {
    if (code === null || code === 36 || markdownLineEnding(code)) {
      effects.exit("mathFlowValue")
      return beforeContent(code)
    }
    effects.consume(code)
    return value
  }
  function after(code: Code): State | undefined {
    effects.exit("mathFlow")
    return ok(code)
  }
  function tokenizeContinuation(effects: Effects, ok: State, nok: State): State {
    return (code: Code) => {
      if (code === null) return ok(code)
      effects.enter("lineEnding")
      effects.consume(code)
      effects.exit("lineEnding")
      return (next: Code) => (self.parser.lazy[self.now().line] ? nok(next) : ok(next))
    }
  }
  function tokenizeClosing(effects: Effects, ok: State, nok: State): State {
    return (code: Code) => {
      effects.enter("mathFlowFence")
      effects.enter("mathFlowFenceSequence")
      effects.consume(code)
      return (second: Code) => {
        if (second !== 36) return nok(second)
        effects.consume(second)
        effects.exit("mathFlowFenceSequence")
        return factorySpace(effects, afterClose, "whitespace")
      }
    }
    function afterClose(code: Code): State | undefined {
      if (code !== null && !markdownLineEnding(code)) return nok(code)
      effects.exit("mathFlowFence")
      return ok(code)
    }
  }
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

/** The link form a publish result hands the model; it opens that publication's latest version. */
const ARTIFACT_LINK = "artifact://"
// react-markdown drops hrefs outside the web schemes; the artifact scheme is ours.
const urlTransform = (url: string) =>
  url.startsWith(ARTIFACT_LINK) ? url : defaultUrlTransform(url)

/**
 * `[title](artifact://<id>)` opens the publication's latest version as a Canvas tab of the pane's
 * session, or of the focused one from inside a document.
 */
function ArtifactLink({
  artifactId,
  children,
}: {
  artifactId: string
  children?: React.ReactNode
}) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const runtime = useContext(PaneRuntimeContext)
  const [error, setError] = useState<string>()
  return (
    <>
      <a
        href={`${ARTIFACT_LINK}${artifactId}`}
        title={t("markdown.openCanvas")}
        onClick={(event) => {
          event.preventDefault()
          void api
            .openPublishedArtifact(artifactId, runtime)
            .then((result) => setError(result.ok ? undefined : result.reason))
        }}
      >
        {children}
      </a>
      {error ? <span className="artifactCard-error"> {error}</span> : null}
    </>
  )
}

/**
 * Absolute and inline sources load as written; a document's relative paths come from its folder.
 */
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
