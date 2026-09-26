import type { Element, ElementContent, Root, Text } from "hast"
import { Check, Copy } from "lucide-react"
import { createContext, isValidElement, memo, useContext, useEffect, useRef, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { useOpenCanvas } from "../features/canvas/canvas-context.js"
import { useI18n } from "../i18n/index.js"
import { ArtifactCard } from "./ArtifactCard.js"
import { IconButton } from "./Button.js"

/** Assistant-facing Markdown: GFM, external links in the system browser, copyable code blocks. */
const remarkPlugins = [remarkGfm]
const CanvasBlockEnabledContext = createContext(true)
// Component types must survive text updates, otherwise React remounts code/table subtrees and loses
// selection, horizontal scrolling, and copy-button state.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="md-tableWrap">
      <table>{children}</table>
    </div>
  ),
}

export const Markdown = memo(function Markdown({
  text,
  enableCanvas = true,
  streaming = false,
}: {
  text: string
  enableCanvas?: boolean
  streaming?: boolean
}) {
  // A streaming message would parse whole on every token. The blocks before its last paragraph
  // break are final, so they keep their tree and only the open tail parses again.
  const settled = streaming ? settledBlocksEnd(text) : 0
  return (
    <CanvasBlockEnabledContext.Provider value={enableCanvas}>
      <div className="md">
        {settled > 0 ? <Blocks text={text.slice(0, settled)} /> : null}
        <Blocks text={text.slice(settled)} streaming={streaming} />
      </div>
    </CanvasBlockEnabledContext.Provider>
  )
})

const Blocks = memo(function Blocks({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={streaming ? streamPlugins : undefined}
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
const streamPlugins = [() => (tree: Root) => splitWords(tree)]

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
  // react-markdown renders fenced code as <pre><code className="language-x">…</code></pre>.
  const codeProps = isValidElement<{ className?: string; children?: React.ReactNode }>(children)
    ? children.props
    : undefined
  const language = /language-(\w+)/.exec(codeProps?.className ?? "")?.[1]
  // react-markdown appends a trailing newline to fenced code; it renders as a blank last line.
  const text = extractText(codeProps?.children).replace(/\n+$/, "")
  const openCanvas = useOpenCanvas()
  const canvasEnabled = useContext(CanvasBlockEnabledContext)
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

  if (language?.toLowerCase() === "mermaid" && openCanvas && canvasEnabled) {
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
        <code>{text}</code>
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
