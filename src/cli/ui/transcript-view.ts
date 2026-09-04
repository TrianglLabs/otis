import {
  BoxRenderable,
  DiffRenderable,
  MarkdownRenderable,
  MouseButton,
  type ScrollBoxRenderable,
  TextRenderable,
  type TreeSitterClient,
} from "@opentui/core"
import type { ToolActivityKind } from "../../tools/index.js"
import {
  colors,
  createCodeSyntaxStyle,
  createMarkdownStyle,
  createMarkdownTableOptions,
  createMutedMarkdownStyle,
} from "../theme.js"
import type { TranscriptEntry } from "../transcript.js"
import { formatElapsed } from "./format.js"
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
  agent: "◇",
}
const useRichToolIcons = supportsRichToolIcons()
const REASONING_PREVIEW_HEIGHT = 3

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

type ReasoningCard = {
  kind: "reasoning"
  root: BoxRenderable
  header: TextRenderable
  preview: BoxRenderable
  content: MarkdownRenderable
  entry: TranscriptEntry
  expanded: boolean
}

type TranscriptRenderable = MessageCard | ReasoningCard | ToolCard

export class TranscriptView {
  readonly #renderables = new Map<number, TranscriptRenderable>()
  readonly #expandedReasoningIDs = new Set<string>()
  #entries: readonly TranscriptEntry[] = []

  constructor(
    private readonly renderer: Renderer,
    private readonly messages: ScrollBoxRenderable,
    private readonly treeSitterClient?: TreeSitterClient,
    private thinkingVisible = false,
  ) {}

  render(entries: readonly TranscriptEntry[], options: { scrollToBottom?: boolean } = {}) {
    this.#entries = entries
    const reasoningIDs = new Set(entries.flatMap((entry) => (entry.reasoningId ? [entry.reasoningId] : [])))
    for (const reasoningId of this.#expandedReasoningIDs) {
      if (!reasoningIDs.has(reasoningId)) this.#expandedReasoningIDs.delete(reasoningId)
    }
    const visible = entries.filter((entry) => entry.kind !== "reasoning" || this.thinkingVisible)
    const visibleEntries = [...visible.filter((entry) => !entry.delivery), ...visible.filter((entry) => entry.delivery)]
    const entryIDs = new Set(visibleEntries.map((entry) => entry.id))

    for (const [id, renderable] of this.#renderables) {
      if (entryIDs.has(id)) continue
      this.messages.remove(renderable.root.id)
      this.#renderables.delete(id)
    }

    visibleEntries.forEach((entry, index) => {
      const previousEntry = visibleEntries[index - 1]
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
        this.messages.add(renderable.root, index)
      }
    })
    this.orderRenderables(visibleEntries)

    if (options.scrollToBottom) this.messages.scrollTo(this.messages.scrollHeight)
    this.renderer.requestRender()
  }

  refreshTheme() {
    const scrollTop = this.messages.scrollTop
    for (const renderable of this.#renderables.values()) this.messages.remove(renderable.root.id)
    this.#renderables.clear()
    this.render(this.#entries)
    this.messages.scrollTo(scrollTop)
  }

  setThinkingVisible(visible: boolean) {
    if (visible === this.thinkingVisible) return
    this.thinkingVisible = visible
    this.render(this.#entries)
  }

  private orderRenderables(entries: readonly TranscriptEntry[]) {
    const desired = entries.flatMap((entry) => {
      const renderable = this.#renderables.get(entry.id)
      return renderable ? [renderable.root] : []
    })
    const current = this.messages.getChildren()
    if (current.length === desired.length && current.every((child, index) => child.id === desired[index]?.id)) return
    for (const root of desired) this.messages.remove(root.id)
    for (const root of desired) this.messages.add(root)
  }

  private create(entry: TranscriptEntry, previousEntry?: TranscriptEntry): TranscriptRenderable {
    if (entry.kind === "tool") return this.createToolCard(entry, previousEntry)
    if (entry.kind === "reasoning") return this.createReasoningCard(entry, previousEntry)
    return this.createMessageCard(entry, previousEntry)
  }

  private update(renderable: TranscriptRenderable, entry: TranscriptEntry, previousEntry?: TranscriptEntry) {
    if (renderable.kind === "tool") {
      renderable.root.marginTop = entryMarginTop(entry, previousEntry)
      renderable.icon.content = toolIcon(entry)
      renderable.label.content = entry.text || " "
      if (entry.diff) this.addDiff(renderable, entry)
      return
    }

    if (renderable.kind === "reasoning") {
      renderable.root.marginTop = entryMarginTop(entry, previousEntry)
      renderable.entry = entry
      renderable.header.content = reasoningHeader(
        entry,
        renderable.expanded,
        reasoningExceedsPreview(entry.text, this.renderer.terminalWidth - 2),
      )
      renderable.content.streaming = entry.streaming === true
      renderable.content.content = entry.text || " "
      this.applyReasoningPreview(renderable)
      this.orderReasoningCard(renderable, entry.streaming === true)
      return
    }

    renderable.root.backgroundColor = entryBackground(entry)
    renderable.root.paddingY = entry.kind === "message" ? 1 : 0
    renderable.root.marginTop = entryMarginTop(entry, previousEntry)
    renderable.root.gap = entry.kind === "message" ? 1 : 0
    renderable.speaker.content = speakerLabel(entry)
    renderable.speaker.fg = speakerColor(entry)
    renderable.content.streaming = entry.streaming === true
    renderable.content.internalBlockMode = "top-level"
    renderable.content.content = messageContent(entry)
  }

  private createReasoningCard(entry: TranscriptEntry, previousEntry?: TranscriptEntry): ReasoningCard {
    const root = new BoxRenderable(this.renderer, {
      id: `message-${entry.id}`,
      flexDirection: "column",
      backgroundColor: colors.background,
      paddingX: 1,
      paddingY: 0,
      marginTop: entryMarginTop(entry, previousEntry),
      gap: 1,
    })
    const header = new TextRenderable(this.renderer, {
      id: `message-${entry.id}-reasoning-header`,
      content: reasoningHeader(entry),
      fg: colors.muted,
    })
    const preview = new BoxRenderable(this.renderer, {
      id: `message-${entry.id}-reasoning-preview`,
      flexDirection: "column",
      flexShrink: 0,
      overflow: "hidden",
      justifyContent: "flex-end",
      maxHeight: REASONING_PREVIEW_HEIGHT,
    })
    const content = this.createReasoningContent(entry)
    preview.add(content)
    const card: ReasoningCard = {
      kind: "reasoning",
      root,
      header,
      preview,
      content,
      entry,
      expanded: entry.reasoningId ? this.#expandedReasoningIDs.has(entry.reasoningId) : false,
    }
    header.onMouseDown = (event) => {
      if (event.button !== MouseButton.LEFT) return
      if (!reasoningExceedsPreview(card.entry.text, this.renderer.terminalWidth - 2)) return
      event.preventDefault()
      event.stopPropagation()
      card.expanded = !card.expanded
      if (card.entry.reasoningId) {
        if (card.expanded) this.#expandedReasoningIDs.add(card.entry.reasoningId)
        else this.#expandedReasoningIDs.delete(card.entry.reasoningId)
      }
      this.update(card, card.entry)
      this.renderer.requestRender()
    }
    this.update(card, entry, previousEntry)
    return card
  }

  private createReasoningContent(entry: TranscriptEntry) {
    return new MarkdownRenderable(this.renderer, {
      id: `message-${entry.id}-reasoning-content`,
      content: entry.text || " ",
      fg: colors.muted,
      syntaxStyle: createMutedMarkdownStyle(),
      treeSitterClient: this.treeSitterClient,
      streaming: entry.streaming === true,
      internalBlockMode: "top-level",
      tableOptions: createMarkdownTableOptions(),
      flexShrink: 0,
    })
  }

  private applyReasoningPreview(card: ReasoningCard) {
    // Keep the full markdown document so streaming can append. Clip the tail
    // instead of rewriting a sliding window, which wiped the first preview line.
    if (card.expanded) {
      card.preview.maxHeight = undefined
      card.preview.overflow = "visible"
      card.preview.justifyContent = "flex-start"
      return
    }
    card.preview.maxHeight = REASONING_PREVIEW_HEIGHT
    card.preview.overflow = "hidden"
    card.preview.justifyContent = "flex-end"
  }

  private orderReasoningCard(card: ReasoningCard, streaming: boolean) {
    const desired = streaming ? [card.header, card.preview] : [card.preview, card.header]
    const current = card.root.getChildren()
    if (current.length === desired.length && current.every((child, index) => child.id === desired[index].id)) return
    for (const child of current) card.root.remove(child.id)
    for (const child of desired) card.root.add(child)
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
      syntaxStyle: createCodeSyntaxStyle(),
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
      content: speakerLabel(entry),
      fg: speakerColor(entry),
    })
    const content = new MarkdownRenderable(this.renderer, {
      id: `message-${entry.id}-content`,
      content: messageContent(entry),
      fg: colors.text,
      syntaxStyle: createMarkdownStyle(),
      treeSitterClient: this.treeSitterClient,
      streaming: entry.streaming === true,
      internalBlockMode: "top-level",
      tableOptions: createMarkdownTableOptions(),
    })
    card.add(speaker)
    card.add(content)

    const messageCard: MessageCard = { kind: "message", root: card, speaker, content }
    this.update(messageCard, entry, previousEntry)
    return messageCard
  }
}

function canReuse(renderable: TranscriptRenderable, entry: TranscriptEntry) {
  const kind = entry.kind === "tool" ? "tool" : entry.kind === "reasoning" ? "reasoning" : "message"
  if (renderable.kind !== kind) return false
  return renderable.kind !== "reasoning" || renderable.entry.reasoningId === entry.reasoningId
}

function entryBackground(entry: TranscriptEntry) {
  if (entry.kind !== "message") return colors.background
  return entry.speaker === "You" ? colors.userSurface : colors.surface
}

function entryMarginTop(entry: TranscriptEntry, previousEntry?: TranscriptEntry) {
  if (entry.kind === "tool") return previousEntry?.kind === "tool" ? 0 : 1
  return entry.kind === "message" || entry.kind === "reasoning" ? 1 : 0
}

function reasoningHeader(entry: TranscriptEntry, expanded = false, truncated = false) {
  const label = entry.streaming
    ? "Thinking…"
    : entry.durationMs === undefined
      ? "Thought"
      : `Thought for ${formatElapsed(entry.durationMs)}`
  return truncated ? `${label} · click to ${expanded ? "collapse" : "expand"}` : label
}

function reasoningExceedsPreview(text: string, width: number) {
  const lines = text.replace(/\n+$/, "").split("\n")
  if (lines.length > REASONING_PREVIEW_HEIGHT) return true
  const columns = Math.max(1, width)
  let rows = 0
  for (const line of lines) {
    rows += Math.max(1, Math.ceil(Array.from(line).length / columns))
    if (rows > REASONING_PREVIEW_HEIGHT) return true
  }
  return false
}

function speakerColor(entry: TranscriptEntry) {
  return entry.speaker === "You" ? colors.accent : colors.muted
}

function speakerLabel(entry: TranscriptEntry) {
  return entry.delivery ? `${entry.speaker} · ${entry.delivery}` : entry.speaker
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
