import {
  BoxRenderable,
  DiffRenderable,
  MarkdownRenderable,
  MouseButton,
  RenderableEvents,
  type ScrollBoxRenderable,
  TextRenderable,
  type TreeSitterClient,
} from "@opentui/core"
import type { TranscriptEntry } from "../../app/transcript.js"
import type { ToolActivityKind } from "../../tools/index.js"
import {
  colors,
  createCodeSyntaxStyle,
  createMarkdownStyle,
  createMarkdownTableOptions,
  createMutedMarkdownStyle,
} from "../theme.js"
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

type TranscriptRenderable = (MessageCard | ReasoningCard | ToolCard) & {
  entry?: TranscriptEntry
  previousKind?: TranscriptEntry["kind"]
  width?: number
}

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
    const reasoningIDs = new Set(
      entries.flatMap((entry) => (entry.reasoningId ? [entry.reasoningId] : [])),
    )
    for (const reasoningId of this.#expandedReasoningIDs) {
      if (!reasoningIDs.has(reasoningId)) this.#expandedReasoningIDs.delete(reasoningId)
    }
    const visible = entries.filter((entry) => entry.kind !== "reasoning" || this.thinkingVisible)
    const visibleEntries = [
      ...visible.filter((entry) => !entry.delivery),
      ...visible.filter((entry) => entry.delivery),
    ]
    const entryIDs = new Set(visibleEntries.map((entry) => entry.id))

    for (const [id, renderable] of this.#renderables) {
      if (entryIDs.has(id)) continue
      renderable.root.destroyRecursively()
      this.#renderables.delete(id)
    }

    visibleEntries.forEach((entry, index) => {
      const previousEntry = visibleEntries[index - 1]
      const kind = entry.kind === "tool" || entry.kind === "reasoning" ? entry.kind : "message"
      let existing = this.#renderables.get(entry.id)
      const reusable =
        existing?.kind === kind &&
        (existing.kind !== "reasoning" || existing.entry.reasoningId === entry.reasoningId)
      if (existing && !reusable) {
        existing.root.destroyRecursively()
        this.#renderables.delete(entry.id)
        existing = undefined
      }
      if (!existing) {
        const renderable =
          kind === "tool"
            ? this.createToolCard(entry)
            : kind === "reasoning"
              ? this.createReasoningCard(entry)
              : this.createMessageCard(entry)
        this.update(renderable, entry, previousEntry)
        this.#renderables.set(entry.id, renderable)
        this.messages.add(renderable.root, index)
      } else if (
        existing.entry !== entry ||
        existing.previousKind !== previousEntry?.kind ||
        existing.width !== this.renderer.terminalWidth
      ) {
        this.update(existing, entry, previousEntry)
      }
    })

    const desired = visibleEntries.map(
      (entry) => (this.#renderables.get(entry.id) as TranscriptRenderable).root,
    )
    const current = this.messages.getChildren()
    if (
      current.length !== desired.length ||
      current.some((child, index) => child.id !== desired[index]?.id)
    ) {
      for (const root of desired) this.messages.remove(root.id)
      for (const root of desired) this.messages.add(root)
    }

    if (options.scrollToBottom) this.messages.scrollTo(this.messages.scrollHeight)
    this.renderer.requestRender()
  }

  refreshTheme() {
    const scrollTop = this.messages.scrollTop
    for (const renderable of this.#renderables.values()) renderable.root.destroyRecursively()
    this.#renderables.clear()
    this.render(this.#entries)
    this.messages.scrollTo(scrollTop)
  }

  setThinkingVisible(visible: boolean) {
    if (visible === this.thinkingVisible) return
    this.thinkingVisible = visible
    this.render(this.#entries)
  }

  private update(
    renderable: TranscriptRenderable,
    entry: TranscriptEntry,
    previousEntry?: TranscriptEntry,
  ) {
    renderable.entry = entry
    renderable.previousKind = previousEntry?.kind
    renderable.width = this.renderer.terminalWidth
    // Consecutive tool cards pack together; every other card gets a blank line above it.
    if (entry.kind === "tool") renderable.root.marginTop = previousEntry?.kind === "tool" ? 0 : 1
    else renderable.root.marginTop = entry.kind === "message" || entry.kind === "reasoning" ? 1 : 0

    if (renderable.kind === "tool") {
      renderable.icon.content =
        useRichToolIcons && entry.activityKind ? TOOL_ICONS[entry.activityKind] : FALLBACK_TOOL_ICON
      renderable.label.content = entry.text || " "
      if (entry.diff) this.addDiff(renderable, entry, entry.diff)
      return
    }

    if (renderable.kind === "reasoning") {
      const label = entry.streaming
        ? "Thinking…"
        : entry.durationMs === undefined
          ? "Thought"
          : `Thought for ${formatElapsed(entry.durationMs)}`
      const truncated = reasoningExceedsPreview(entry.text, this.renderer.terminalWidth - 2)
      renderable.header.content = truncated
        ? `${label} · click to ${renderable.expanded ? "collapse" : "expand"}`
        : label
      renderable.content.streaming = entry.streaming === true
      renderable.content.content = entry.text || " "
      // Keep the full markdown document so streaming can append. Clip the tail
      // instead of rewriting a sliding window, which wiped the first preview line.
      const { preview, header, expanded } = renderable
      preview.maxHeight = expanded ? undefined : REASONING_PREVIEW_HEIGHT
      preview.overflow = expanded ? "visible" : "hidden"
      preview.justifyContent = expanded ? "flex-start" : "flex-end"
      // The header leads a streaming thought and trails a finished one.
      const desired = entry.streaming ? [header, preview] : [preview, header]
      const current = renderable.root.getChildren()
      if (
        current.length !== desired.length ||
        current.some((child, index) => child.id !== desired[index].id)
      ) {
        for (const child of current) renderable.root.remove(child.id)
        for (const child of desired) renderable.root.add(child)
      }
      return
    }

    const message = entry.kind === "message"
    renderable.root.backgroundColor = message
      ? entry.speaker === "You"
        ? colors.userSurface
        : colors.surface
      : colors.background
    renderable.root.paddingY = message ? 1 : 0
    renderable.root.gap = message ? 1 : 0
    renderable.speaker.content = entry.delivery
      ? `${entry.speaker} · ${entry.delivery}`
      : entry.speaker
    renderable.speaker.fg = entry.speaker === "You" ? colors.accent : colors.muted
    renderable.content.streaming = entry.streaming === true
    renderable.content.internalBlockMode = "top-level"
    renderable.content.content =
      entry.kind === "debug" ? `> debug: \`${entry.text.replace(/`/g, "'")}\`` : entry.text || " "
  }

  private createReasoningCard(entry: TranscriptEntry): ReasoningCard {
    const root = new BoxRenderable(this.renderer, {
      id: `message-${entry.id}`,
      flexDirection: "column",
      backgroundColor: colors.background,
      paddingX: 1,
      paddingY: 0,
      gap: 1,
    })
    const header = new TextRenderable(this.renderer, {
      id: `message-${entry.id}-reasoning-header`,
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
    const content = new MarkdownRenderable(this.renderer, {
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
    // The card owns this style; release it after recursive child destruction.
    root.once(RenderableEvents.DESTROYED, () => content.syntaxStyle.destroy())
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
    return card
  }

  private createToolCard(entry: TranscriptEntry): ToolCard {
    const root = new BoxRenderable(this.renderer, {
      id: `message-${entry.id}`,
      flexDirection: "column",
      backgroundColor: colors.background,
      paddingX: 1,
      paddingY: 0,
      gap: 1,
    })
    const header = new BoxRenderable(this.renderer, {
      id: `message-${entry.id}-header`,
      flexDirection: "row",
      gap: 1,
    })
    const icon = new TextRenderable(this.renderer, {
      id: `message-${entry.id}-tool-icon`,
      fg: colors.accent,
    })
    const label = new TextRenderable(this.renderer, {
      id: `message-${entry.id}-tool-label`,
      fg: colors.text,
    })
    header.add(icon)
    header.add(label)
    root.add(header)
    return { kind: "tool", root, icon, label }
  }

  private addDiff(card: ToolCard, entry: TranscriptEntry, diff: string) {
    if (card.diff) {
      card.diff.diff = diff
      return
    }
    const syntaxStyle = createCodeSyntaxStyle()
    card.diff = new DiffRenderable(this.renderer, {
      id: `message-${entry.id}-diff`,
      width: "100%",
      marginBottom: 1,
      diff,
      view: "split",
      filetype: filetypeFromPath(entry.text),
      syntaxStyle,
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
    card.root.once(RenderableEvents.DESTROYED, () => syntaxStyle.destroy())
    card.root.add(card.diff)
  }

  private createMessageCard(entry: TranscriptEntry): MessageCard {
    const root = new BoxRenderable(this.renderer, {
      id: `message-${entry.id}`,
      flexDirection: "column",
      paddingX: 1,
    })
    const speaker = new TextRenderable(this.renderer, { id: `message-${entry.id}-speaker` })
    const content = new MarkdownRenderable(this.renderer, {
      id: `message-${entry.id}-content`,
      content: entry.text || " ",
      fg: colors.text,
      syntaxStyle: createMarkdownStyle(),
      treeSitterClient: this.treeSitterClient,
      streaming: entry.streaming === true,
      internalBlockMode: "top-level",
      tableOptions: createMarkdownTableOptions(),
    })
    root.once(RenderableEvents.DESTROYED, () => content.syntaxStyle.destroy())
    root.add(speaker)
    root.add(content)
    return { kind: "message", root, speaker, content }
  }
}

function reasoningExceedsPreview(text: string, width: number) {
  let end = text.length
  while (end > 0 && text[end - 1] === "\n") end -= 1
  const columns = Math.max(1, width)
  let rows = 1
  let column = 0
  let offset = 0
  // Inspect only the preview, even when the reasoning trace is hundreds of thousands of characters.
  for (const character of text) {
    if (offset >= end) break
    offset += character.length
    if (character === "\n") {
      rows += 1
      column = 0
    } else {
      if (column === columns) {
        rows += 1
        column = 0
      }
      column += 1
    }
    if (rows > REASONING_PREVIEW_HEIGHT) return true
  }
  return false
}

function supportsRichToolIcons() {
  if (process.env.OTIS_SAFE_ICONS === "1" || process.env.OTIS_RICH_ICONS === "0") return false
  if (process.env.OTIS_RICH_ICONS === "1") return true
  if (process.env.TERM === "dumb") return false

  const locale = [process.env.LC_ALL, process.env.LC_CTYPE, process.env.LANG]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  if (locale.includes("utf")) return true
  return process.platform !== "win32" || Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM)
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
