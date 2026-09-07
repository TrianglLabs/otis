import { Check, Copy } from "lucide-react"
import { isValidElement, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { IconButton } from "./Button.js"

/** Assistant-facing Markdown: GFM, external links in the system browser, copyable code blocks. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function CodeBlock({ children }: { children?: React.ReactNode }) {
  // react-markdown renders fenced code as <pre><code className="language-x">…</code></pre>.
  const codeProps = isValidElement<{ className?: string; children?: React.ReactNode }>(children)
    ? children.props
    : undefined
  const language = /language-(\w+)/.exec(codeProps?.className ?? "")?.[1]
  const text = extractText(codeProps?.children)
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard can be unavailable (e.g. permissions); leave the button in its idle state.
    }
  }

  return (
    <figure className="codeBlock">
      <figcaption>
        <span className="codeBlock-lang">{language ?? "code"}</span>
        <IconButton icon={copied ? Check : Copy} label={copied ? "Copied" : "Copy code"} onClick={copy} size={22} />
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
