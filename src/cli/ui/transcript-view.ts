import {
  BoxRenderable,
  DiffRenderable,
  MarkdownRenderable,
  type ScrollBoxRenderable,
  TextRenderable,
  type TreeSitterClient,
} from "@opentui/core"
import type { ToolActivityKind } from "../../tools/index.js"
import { codeSyntaxStyle, colors, markdownStyle } from "../theme.js"
import type { TranscriptEntry } from "../transcript.js"
import type { Renderer } from "./types.js"

const FALLBACK_TOOL_ICON = "›"
const TOOL_ICONS: Record<ToolActivityKind, string> = {
  web_search: "⌕",
  web_read: "→",
  file_read: "→",
  file_search: "⌕",
  file_write: "✎",
  file_edit: "✎",
  file_inspect: "→",
  git: "⚙",
  shell: "⚙",
}
const useRichToolIcons = supportsRichToolIcons()

type MessageCard = {
  kind: "message"
  root: BoxRenderable
  speaker: TextRenderable
  content: MarkdownRenderable
}

type ToolCard = {
  kind: "tool"
  root: BoxRenderable
  icon: TextRenderable
  label: TextRenderable
  diff?: DiffRenderable
}

type TranscriptRenderable = MessageCard | ToolCard

export class TranscriptView {
  readonly #renderables = new Map<number, TranscriptRenderable>()

  constructor(
    private readonly renderer: Renderer,
    private readonly messages: ScrollBoxRenderable,
    private readonly treeSitterClient?: TreeSitterClient,
  ) {}

  render(entries: readonly TranscriptEntry[], options: { scrollToBottom?: boolean } = {}) {
    const entryIDs = new Set(entries.map((entry) => entry.id))

    for (const [id, renderable] of this.#renderables) {
      if (entryIDs.has(id)) continue
      this.messages.remove(renderable.root.id)
      this.#renderables.delete(id)
    }

    entries.forEach((entry, index) => {
      const previousEntry = entries[index - 1]
      let existing = this.#renderables.get(entry.id)

      if (existing && !canReuse(existing, entry)) {
        this.messages.remove(existing.root.id)
        this.#renderables.delete(entry.id)
        existing = undefined
      }

      if (existing) {
        this.update(existing, entry, previousEntry)
      } else {
        const renderable = this.create(entry, previousEntry)
        this.#renderables.set(entry.id, renderable)
        this.messages.add(renderable.root)
      }
    })

    if (options.scrollToBottom) this.messages.scrollTo(this.messages.scrollHeight)
    this.renderer.requestRender()
  }

  private create(entry: TranscriptEntry, previousEntry?: TranscriptEntry): TranscriptRenderable {
    return entry.kind === "tool"
      ? this.createToolCard(entry, previousEntry)
      : this.createMessageCard(entry, previousEntry)
  }

  private update(renderable: TranscriptRenderable, entry: TranscriptEntry, previousEntry?: TranscriptEntry) {
    if (renderable.kind === "tool") {
      renderable.root.marginTop = entryMarginTop(entry, previousEntry)
      renderable.icon.content = toolIcon(entry)
      renderable.label.content = entry.text || " "
      if (entry.diff) this.addDiff(renderable, entry)
      return
    }

    renderable.root.backgroundColor = entryBackground(entry)
    renderable.root.paddingY = entry.kind === "message" ? 1 : 0
    renderable.root.marginTop = entryMarginTop(entry, previousEntry)
    renderable.root.gap = entry.kind === "message" ? 1 : 0
    renderable.speaker.content = entry.speaker
    renderable.speaker.fg = speakerColor(entry)
    renderable.content.streaming = entry.streaming === true
    renderable.content.internalBlockMode = "top-level"
    renderable.content.content = messageContent(entry)
  }

  private createToolCard(entry: TranscriptEntry, previousEntry?: TranscriptEntry): ToolCard {
    const card = new BoxRenderable(this.renderer, {
      id: `message-${entry.id}`,
      flexDirection: "column",
      backgroundColor: entryBackground(entry),
      paddingX: 1,
      paddingY: 0,
      marginTop: entryMarginTop(entry, previousEntry),
      gap: 1,
    })
    const header = new BoxRenderable(this.renderer, {
      id: `message-${entry.id}-header`,
      flexDirection: "row",
      gap: 1,
    })
    const icon = new TextRenderable(this.renderer, {
      id: `message-${entry.id}-tool-icon`,
      content: toolIcon(entry),
      fg: colors.accent,
    })
    const label = new TextRenderable(this.renderer, {
      id: `message-${entry.id}-tool-label`,
      content: entry.text || " ",
      fg: colors.text,
    })
    header.add(icon)
    header.add(label)
    card.add(header)

    const toolCard: ToolCard = { kind: "tool", root: card, icon, label }
    if (entry.diff) this.addDiff(toolCard, entry)
    return toolCard
  }

  private addDiff(card: ToolCard, entry: TranscriptEntry) {
    if (!entry.diff) return
    if (card.diff) {
      card.diff.diff = entry.diff
      return
    }

    const diff = new DiffRenderable(this.renderer, {
      id: `message-${entry.id}-diff`,
      width: "100%",
      marginBottom: 1,
      diff: entry.diff,
      view: "split",
      filetype: filetypeFromPath(entry.text),
      syntaxStyle: codeSyntaxStyle,
      treeSitterClient: this.treeSitterClient,
      showLineNumbers: true,
      syncScroll: true,
      wrapMode: "word",
      conceal: true,
      addedBg: colors.diffAddedBg,
      removedBg: colors.diffRemovedBg,
      contextBg: colors.diffContextBg,
      addedContentBg: colors.diffAddedContentBg,
      removedContentBg: colors.diffRemovedContentBg,
      contextContentBg: colors.diffContextContentBg,
      lineNumberFg: colors.diffLineNumberFg,
      addedLineNumberBg: colors.diffAddedBg,
      removedLineNumberBg: colors.diffRemovedBg,
      addedSignColor: colors.green,
      removedSignColor: colors.pink,
    })
    card.root.add(diff)
    card.diff = diff
  }

  private createMessageCard(entry: TranscriptEntry, previousEntry?: TranscriptEntry): MessageCard {
    const card = new BoxRenderable(this.renderer, {
      id: `message-${entry.id}`,
      flexDirection: "column",
      backgroundColor: entryBackground(entry),
      paddingX: 1,
      paddingY: entry.kind === "message" ? 1 : 0,
      marginTop: entryMarginTop(entry, previousEntry),
      gap: entry.kind === "message" ? 1 : 0,
    })
    const speaker = new TextRenderable(this.renderer, {
      id: `message-${entry.id}-speaker`,
      content: entry.speaker,
      fg: speakerColor(entry),
    })
    const content = new MarkdownRenderable(this.renderer, {
      id: `message-${entry.id}-content`,
      content: messageContent(entry),
      syntaxStyle: markdownStyle,
      treeSitterClient: this.treeSitterClient,
      streaming: entry.streaming === true,
      internalBlockMode: "top-level",
      tableOptions: { style: "grid" },
    })
    card.add(speaker)
    card.add(content)

    const messageCard: MessageCard = { kind: "message", root: card, speaker, content }
    this.update(messageCard, entry, previousEntry)
    return messageCard
  }
}

function canReuse(renderable: TranscriptRenderable, entry: TranscriptEntry) {
  return renderable.kind === (entry.kind === "tool" ? "tool" : "message")
}

function entryBackground(entry: TranscriptEntry) {
  if (entry.kind !== "message") return colors.background
  return entry.speaker === "You" ? colors.userSurface : colors.surface
}

function entryMarginTop(entry: TranscriptEntry, previousEntry?: TranscriptEntry) {
  if (entry.kind === "tool") return previousEntry?.kind === "tool" ? 0 : 1
  return entry.kind === "message" ? 1 : 0
}

function speakerColor(entry: TranscriptEntry) {
  return entry.speaker === "You" ? colors.accent : colors.muted
}

function toolIcon(entry: TranscriptEntry) {
  if (!useRichToolIcons) return FALLBACK_TOOL_ICON
  return entry.activityKind ? TOOL_ICONS[entry.activityKind] : FALLBACK_TOOL_ICON
}

function supportsRichToolIcons() {
  if (process.env.OTIS_SAFE_ICONS === "1" || process.env.OTIS_RICH_ICONS === "0") return false
  if (process.env.OTIS_RICH_ICONS === "1") return true
  if (process.env.TERM === "dumb") return false

  const locale = [process.env.LC_ALL, process.env.LC_CTYPE, process.env.LANG].filter(Boolean).join(" ").toLowerCase()
  if (locale.includes("utf")) return true
  return process.platform !== "win32" || Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM)
}

function messageContent(entry: TranscriptEntry) {
  if (entry.kind === "debug") return `> debug: \`${entry.text.replace(/`/g, "'")}\``
  return entry.text || " "
}

const FILETYPE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  py: "python",
  rs: "rust",
  go: "go",
  md: "markdown",
  mdx: "markdown",
  sh: "bash",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  html: "html",
  toml: "toml",
  xml: "xml",
  sql: "sql",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  lua: "lua",
}

const BASENAME_MAP: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
}

function filetypeFromPath(label: string) {
  const filename = label.split(/[/\s]/).pop() ?? label
  const lower = filename.toLowerCase()
  if (BASENAME_MAP[lower]) return BASENAME_MAP[lower]
  const extension = lower.match(/\.(\w+)$/)?.[1]
  return extension ? FILETYPE_MAP[extension] : undefined
}
