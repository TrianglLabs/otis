// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopEvent } from "../../../src/desktop/contracts.js"
import { ArtifactCard } from "../../../src/desktop/renderer/components/ArtifactCard.js"
import { FileTypeIcon } from "../../../src/desktop/renderer/components/FileTypeIcon.js"
import { Markdown } from "../../../src/desktop/renderer/components/Markdown.js"
import { createDemoRuntime } from "../../../src/desktop/renderer/demo/demo-runtime.js"
import { AgentTraceOverlay } from "../../../src/desktop/renderer/features/agents/AgentTraceOverlay.js"
import {
  CanvasOpenContext,
  PaneRuntimeContext,
} from "../../../src/desktop/renderer/features/canvas/canvas-context.js"
import { EntryView } from "../../../src/desktop/renderer/features/conversation/entries.js"
import {
  ToolCard,
  ToolRunCard,
} from "../../../src/desktop/renderer/features/conversation/ToolCard.js"
import { DesktopProvider, useDesktopState } from "../../../src/desktop/renderer/runtime.js"
import { DesktopViewStore } from "../../../src/desktop/renderer/state.js"

afterEach(() => cleanup())

const markdown =
  "| Column | Value |\n| --- | --- |\n| test | wide table |\n\n```ts\nconst answer = 42\n```\n\nStreaming"

describe("stable message rendering", () => {
  it("keeps uploaded code in the conversation without a Canvas action", async () => {
    const runtime = await testRuntime()
    render(
      <DesktopProvider value={runtime}>
        <EntryView
          entry={{
            id: 1,
            kind: "message",
            speaker: "You",
            text: "Review this file",
            messageText: "Review this file",
            artifacts: [
              {
                source: "attachment",
                name: "main.py",
                kind: "text",
                mimeType: "text/plain",
                sha256: "a".repeat(64),
              },
            ],
          }}
          active={false}
          thinkingVisible={false}
          expanded={false}
          onExpandedChange={() => {}}
        />
      </DesktopProvider>,
    )
    // A file Canvas cannot open is a chip with its type mark, not a card and not an emoji line.
    const chip = screen.getByText("main.py").closest(".messageAttachment")
    expect(chip?.querySelector(".tabler-icon-brand-python")).toBeTruthy()
    expect(screen.queryByText(/📄/)).toBeNull()
    expect(screen.queryByRole("button", { name: /Open in Canvas/ })).toBeNull()
  })
  it("shows an image as a chip beside the card of a document Canvas opens", async () => {
    const runtime = await testRuntime()
    render(
      <DesktopProvider value={runtime}>
        <EntryView
          entry={{
            id: 1,
            kind: "message",
            speaker: "You",
            text: "Summarize\n📎 ci-run.png\n📄 report.pdf",
            messageText: "Summarize",
            images: ["ci-run.png"],
            artifacts: [
              {
                source: "attachment",
                name: "report.pdf",
                kind: "pdf",
                mimeType: "application/pdf",
                sha256: "c".repeat(64),
              },
            ],
          }}
          active={false}
          thinkingVisible={false}
          expanded={false}
          onExpandedChange={() => {}}
        />
      </DesktopProvider>,
    )
    const chips = document.querySelectorAll(".messageAttachment")
    expect(chips).toHaveLength(1)
    expect(chips[0]?.textContent).toBe("ci-run.png")
    expect(chips[0]?.querySelector(".tabler-icon-file-type-png")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Open in Canvas/ })).toBeTruthy()
    expect(screen.getByText("Summarize")).toBeTruthy()
    expect(screen.queryByText(/📎|📄/)).toBeNull()
  })
  it("renders a published artifact as its own card and opens its saved reference", async () => {
    const runtime = await testRuntime()
    const openArtifact = vi.spyOn(runtime.api, "openArtifact").mockResolvedValue({ ok: true })
    const artifact = {
      source: "published" as const,
      artifactId: "12345678-1234-1234-1234-123456789abc",
      version: 1,
      sourcePath: "/workspace/final.html",
      name: "final.html",
      kind: "html" as const,
      sha256: "a".repeat(64),
    }
    render(
      <DesktopProvider value={runtime}>
        <ToolCard
          entry={{
            id: 1,
            kind: "tool",
            speaker: "Tool",
            text: "Publishing artifact",
            activityKind: "file_read",
            artifact,
          }}
          active={false}
        />
      </DesktopProvider>,
    )
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Open in Canvas: final.html" })),
    )
    expect(openArtifact).toHaveBeenCalledExactlyOnceWith(artifact, undefined, undefined)
  })

  it("reads a path action as verb, file name, and dimmed directory, in the tense of its state", async () => {
    const runtime = await testRuntime()
    const entry = {
      id: 1,
      kind: "tool" as const,
      speaker: "Tool" as const,
      text: "Editing file: src/desktop/renderer/shell/AppShell.tsx",
      activityKind: "file_edit" as const,
      activityAction: "edit" as const,
      activitySubject: "src/desktop/renderer/shell/AppShell.tsx",
    }
    const view = render(
      <DesktopProvider value={runtime}>
        <ToolCard entry={entry} active={true} />
      </DesktopProvider>,
    )
    expect(view.container.querySelector(".toolCard-verb")?.textContent).toBe("Editing")
    expect(view.container.querySelector(".toolCard-subject")?.textContent).toBe("AppShell.tsx")
    expect(view.container.querySelector(".toolCard-dir")?.textContent).toBe(
      "· src/desktop/renderer/shell/",
    )
    // The full label stays on hover.
    expect(view.container.querySelector(".toolCard-header")?.getAttribute("title")).toBe(entry.text)

    view.rerender(
      <DesktopProvider value={runtime}>
        <ToolCard entry={entry} active={false} />
      </DesktopProvider>,
    )
    expect(view.container.querySelector(".toolCard-verb")?.textContent).toBe("Edited")
  })

  it("keeps a command whole and a label-only entry from an old session as it was", async () => {
    const runtime = await testRuntime()
    const view = render(
      <DesktopProvider value={runtime}>
        <ToolCard
          entry={{
            id: 1,
            kind: "tool",
            speaker: "Tool",
            text: "Running command: bun test tests/desktop",
            activityKind: "shell",
            activityAction: "command",
            activitySubject: "bun test tests/desktop",
          }}
          active={false}
        />
        <ToolCard
          entry={{
            id: 2,
            kind: "tool",
            speaker: "Tool",
            text: "Reading files: notes.md",
            activityKind: "file_read",
          }}
          active={false}
        />
      </DesktopProvider>,
    )
    const [command, legacy] = Array.from(view.container.querySelectorAll(".toolCard-label"))
    expect(command?.querySelector(".toolCard-verb")?.textContent).toBe("Ran")
    expect(command?.querySelector(".toolCard-subject")?.textContent).toBe("bun test tests/desktop")
    expect(command?.querySelector(".toolCard-dir")).toBeNull()
    expect(legacy?.textContent).toBe("Reading files: notes.md")
  })

  it("sums up a settled run by what it did and shows the live action while it runs", async () => {
    const runtime = await testRuntime()
    const entry = (
      id: number,
      activityKind: "file_read" | "file_edit" | "shell",
      action: "read" | "edit" | "command",
      subject: string,
    ) => ({
      id,
      kind: "tool" as const,
      speaker: "Tool" as const,
      text: `${action}: ${subject}`,
      activityKind,
      activityAction: action,
      activitySubject: subject,
    })
    const run = {
      kind: "toolRun" as const,
      id: 7,
      entries: [
        entry(1, "file_read", "read", "a.ts"),
        entry(2, "file_read", "read", "b.ts"),
        entry(3, "file_edit", "edit", "a.ts"),
        entry(4, "shell", "command", "bun test"),
      ],
    }
    const card = (active: boolean) => (
      <DesktopProvider value={runtime}>
        <ToolRunCard run={run} active={active} expanded={false} onExpandedChange={() => {}} />
      </DesktopProvider>
    )
    const view = render(card(false))
    expect(view.container.querySelector(".toolCard-label")?.textContent).toBe(
      "2 files read · 1 change · 1 command",
    )
    view.rerender(card(true))
    expect(view.container.querySelector(".toolCard-verb")?.textContent).toBe("Running")
    expect(view.container.querySelector(".toolCard-subject")?.textContent).toBe("bun test")
  })

  it("keeps a pending artifact revision in the ordinary tool activity", async () => {
    const view = render(
      <DesktopProvider value={await testRuntime()}>
        <ToolCard
          entry={{
            id: 1,
            kind: "tool",
            speaker: "Tool",
            text: "Editing final.html",
            activityKind: "file_edit",
            artifact: { source: "workspace", path: "final.html", kind: "html" },
            artifactDisplay: "pending",
          }}
          active={true}
        />
      </DesktopProvider>,
    )

    expect(view.container.querySelector(".artifactCard")).toBeNull()
    expect(view.container.textContent).toContain("Editing final.html")
  })

  it("shows artifact open failures and lets the user retry", async () => {
    const onOpen = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "Document no longer exists." })
      .mockRejectedValueOnce(new Error("Preview unavailable."))
      .mockResolvedValueOnce({ ok: true })
    render(<ArtifactCard kind="pdf" title="report.pdf" actionLabel="Open" onOpen={onOpen} />)
    const button = screen.getByRole("button", { name: "Open: report.pdf" })
    await act(async () => fireEvent.click(button))
    expect(screen.getByRole("alert").textContent).toBe("Document no longer exists.")
    await act(async () => fireEvent.click(button))
    expect(screen.getByRole("alert").textContent).toBe("Preview unavailable.")
    await act(async () => fireEvent.click(button))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("picks the mark for a file's real extension, falling back to the kind's", () => {
    const icon = (view: { container: HTMLElement }) =>
      [...(view.container.querySelector("svg")?.classList ?? [])].find((name) =>
        name.startsWith("tabler-icon-"),
      )
    const view = render(<FileTypeIcon name="data.csv" />)
    expect(icon(view)).toBe("tabler-icon-file-type-csv")
    view.rerender(<FileTypeIcon name="config.json" kind="text" />)
    expect(icon(view)).toBe("tabler-icon-json")
    view.rerender(<FileTypeIcon name="notes.weird" kind="text" />)
    expect(icon(view)).toBe("tabler-icon-file")
    view.rerender(<FileTypeIcon kind="docx" />)
    expect(icon(view)).toBe("tabler-icon-file-type-docx")
  })

  it("opens a publication from an artifact:// link in the pane's session", async () => {
    const runtime = await testRuntime()
    const open = vi
      .spyOn(runtime.api, "openPublishedArtifact")
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, reason: "This artifact is no longer available." })
    render(
      <DesktopProvider value={runtime}>
        <PaneRuntimeContext.Provider value={7}>
          <Markdown text="Done. [Open the walkthrough](artifact://abc-123) covers the math." />
        </PaneRuntimeContext.Provider>
      </DesktopProvider>,
    )

    const link = screen.getByRole("link", { name: "Open the walkthrough" })
    fireEvent.click(link)
    expect(open).toHaveBeenCalledExactlyOnceWith("abc-123", 7)
    // A publication this session no longer has says so next to the link instead of doing nothing.
    fireEvent.click(link)
    await waitFor(() =>
      expect(screen.getByText("This artifact is no longer available.")).toBeTruthy(),
    )
    expect(document.querySelector('a[target="_blank"]')).toBeNull()
  })

  it("offers completed Mermaid source to Canvas without rendering other code blocks", () => {
    const openCanvas = vi.fn()
    render(
      <CanvasOpenContext.Provider value={openCanvas}>
        <Markdown
          text={"```mermaid\nflowchart LR\n  A --> B\n```\n\n```ts\nconst answer = 42\n```"}
        />
      </CanvasOpenContext.Provider>,
    )

    expect(document.querySelectorAll(".codeBlock")).toHaveLength(1)
    expect(screen.getByText("Mermaid diagram")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Open in Canvas: Mermaid diagram" }))
    expect(openCanvas).toHaveBeenCalledExactlyOnceWith("flowchart LR\n  A --> B")
  })

  it("renders TeX math only for documents, leaving chat dollar signs literal", () => {
    const text =
      "Costs $5.\n\nInline $E = mc^2$ or \\(a^2\\) and display\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n\\[\\sum_i i\\]"
    const chat = render(<Markdown text={text} />)
    expect(chat.container.querySelector(".katex")).toBeNull()
    expect(chat.container.textContent).toContain("Costs $5.")
    expect(chat.container.textContent).toContain("$E = mc^2$")
    // CommonMark reads `\(` as an escaped parenthesis in chat.
    expect(chat.container.textContent).toContain("or (a^2) and")
    chat.unmount()

    const doc = render(
      <Markdown text={text} document={{ runtime: 1, id: "doc.md", revision: 1 }} />,
    )
    expect(doc.container.querySelectorAll(".katex")).toHaveLength(4)
    expect(doc.container.querySelectorAll(".katex-display")).toHaveLength(2)
    expect(doc.container.textContent).toContain("Costs $5.")
    expect(doc.container.textContent).not.toContain("$E = mc^2$")
    expect(doc.container.querySelector(".katex-error")).toBeNull()
  })

  it("colors fenced code by language and drops the fence's trailing newline", () => {
    const { container } = render(
      <Markdown text={"```ts\nconst answer = 42\n```\n\n- item\n\n  ```\n  plain\n  ```"} />,
    )
    const [typed, plain] = Array.from(container.querySelectorAll("pre code"))
    expect(typed?.querySelector(".hljs-keyword")?.textContent).toBe("const")
    expect(typed?.textContent).toBe("const answer = 42")
    expect(plain?.querySelector("[class^=hljs-]")).toBeNull()
    expect(plain?.textContent).toBe("plain")
  })

  it("reads a paragraph that is only $$…$$ as display math, even inside a quote", () => {
    const text = "$$\\frac{a}{b}$$\n\n> $$c$$\n\nInline $$x$$ in text.\n\n$$\n\\frac{d}{e}\n$$"
    const { container } = render(
      <Markdown text={text} document={{ runtime: 1, id: "doc.md", revision: 1 }} />,
    )
    expect(container.querySelectorAll(".katex-display")).toHaveLength(3)
    expect(container.querySelector("blockquote .katex-display")).toBeTruthy()
    expect(container.querySelectorAll(".katex")).toHaveLength(4)
    expect(container.querySelector("p .katex:not(.katex-display .katex)")?.textContent).toContain(
      "x",
    )
  })

  it("reads display math whose fence shares a line with the formula, as Pandoc does", () => {
    const tail = "- **Case II:** paired, $d_i$\n\n## Lesson 4\n\nText $x$ here."
    const formulas = (container: HTMLElement) =>
      [...container.querySelectorAll(".katex-display annotation")].map((e) => e.textContent)
    for (const [text, formula] of [
      [`Welch df:\n\n$$\n\\nu = \\frac{a}{b}$$\n${tail}`, "\\nu = \\frac{a}{b}"],
      [`Welch df:\n\n$$\\nu = \\frac{a}\n{b}$$\n${tail}`, "\\nu = \\frac{a}\n{b}"],
      [`Welch df:\n\n$$\\nu = \\frac{a}{b}\n+ c$$\n${tail}`, "\\nu = \\frac{a}{b}\n+ c"],
      [`Welch df:\n\n$$\\nu = \\frac{a}\n{b}\n$$\n${tail}`, "\\nu = \\frac{a}\n{b}"],
    ]) {
      const { container, unmount } = render(
        <Markdown text={text} document={{ runtime: 1, id: "doc.md", revision: 1 }} />,
      )
      expect(container.querySelector(".katex-error")).toBeNull()
      expect(formulas(container)).toEqual([formula])
      // Everything after the closer is Markdown: the list, the heading, the inline math.
      expect(container.querySelector("li strong")?.textContent).toBe("Case II:")
      expect(container.querySelector("h2")?.textContent).toBe("Lesson 4")
      expect(container.querySelectorAll(".katex")).toHaveLength(3)
      unmount()
    }
    // Several such blocks: each keeps its own fences, and an escaped dollar before a closer is
    // part of the formula. A block may end the document; a line that opens inline math and goes
    // on in prose stays a paragraph.
    const many = render(
      <Markdown
        text={"$$\n\\nu = 1$$\nmid\n\n$$\ns_p = 2$$\nend\n\n$$\nx = 5\\$$$\nAfter.\n\n$$\na$$"}
        document={{ runtime: 1, id: "doc.md", revision: 1 }}
      />,
    )
    expect(many.container.querySelector(".katex-error")).toBeNull()
    expect(formulas(many.container)).toEqual(["\\nu = 1", "s_p = 2", "x = 5\\$", "a"])
    expect(many.container.textContent).not.toContain("$$")
    many.unmount()
    const prose = render(
      <Markdown
        text={"$$E$$ is the energy.\nNext line."}
        document={{ runtime: 1, id: "d", revision: 1 }}
      />,
    )
    expect(prose.container.querySelectorAll(".katex-display")).toHaveLength(0)
    expect(prose.container.querySelector("p .katex")).toBeTruthy()
    expect(prose.container.textContent).toContain("is the energy.")
  })

  it("renders a document's Mermaid inline and its relative images from the workspace", async () => {
    const runtime = await testRuntime()
    const asset = vi.spyOn(runtime.api, "getArtifactAsset").mockResolvedValue({
      ok: true,
      asset: { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
    })
    const objectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:otis/logo")
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    const text =
      "```mermaid\nflowchart LR\n  A --> B\n```\n\n![Logo](img/logo.png) ![Remote](https://x.test/a.png)"
    const view = render(
      <DesktopProvider value={runtime}>
        <Markdown text={text} document={{ runtime: 1, id: "workspace:doc.md", revision: 4 }} />
      </DesktopProvider>,
    )
    await act(async () => {})
    const frame = view.container.querySelector("iframe.canvas-frame-inline") as HTMLIFrameElement
    expect(frame.getAttribute("src")).toMatch(/canvas\.html$/)
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
    expect(view.container.querySelector(".codeBlock")).toBeNull()

    // The drawing opens larger over the window, with the tab's controls, and closes on Escape.
    const dialog = () => screen.queryByRole("dialog", { name: "Mermaid diagram" })
    fireEvent.click(screen.getByRole("button", { name: "Open larger" }))
    const large = dialog()?.querySelector("iframe.canvas-frame") as HTMLIFrameElement
    expect(large.classList.contains("canvas-frame-inline")).toBe(false)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(dialog()).toBeNull()
    // The dialog carries the zoom pill, without an enlarge button; the backdrop closes it too.
    fireEvent.click(screen.getByRole("button", { name: "Open larger" }))
    expect(dialog()?.querySelector(".viewControls")).toBeTruthy()
    expect(
      within(dialog() as HTMLElement).queryByRole("button", { name: "Open larger" }),
    ).toBeNull()
    fireEvent.click(document.querySelector(".overlayBackdrop") as HTMLElement)
    expect(dialog()).toBeNull()
    expect(asset).toHaveBeenCalledExactlyOnceWith(1, "workspace:doc.md", 4, "img/logo.png")
    expect(objectUrl).toHaveBeenCalledOnce()
    expect((screen.getByAltText("Logo") as HTMLImageElement).getAttribute("src")).toBe(
      "blob:otis/logo",
    )
    expect((screen.getByAltText("Remote") as HTMLImageElement).getAttribute("src")).toBe(
      "https://x.test/a.png",
    )
    view.unmount()
    expect(revoke).toHaveBeenCalledWith("blob:otis/logo")
  })

  it("names an image the workspace refuses instead of leaving a broken picture", async () => {
    const runtime = await testRuntime()
    vi.spyOn(runtime.api, "getArtifactAsset").mockResolvedValue({
      ok: false,
      reason: "Image is outside the workspace: ../secret.png",
    })
    render(
      <DesktopProvider value={runtime}>
        <Markdown
          text="![Secret](../secret.png)"
          document={{ runtime: 1, id: "workspace:doc.md", revision: 1 }}
        />
      </DesktopProvider>,
    )
    const missing = await waitFor(() => {
      const element = document.querySelector(".md-imageMissing")
      if (!element) throw new Error("still loading")
      return element
    })
    expect(missing.getAttribute("aria-label")).toBe("Secret")
    expect(missing.getAttribute("title")).toContain("outside the workspace")
  })

  it("keeps settled paragraphs' elements while a message streams, then renders it whole", () => {
    const view = render(<Markdown text={"First **bold** paragraph.\n\nSecond"} streaming />)
    const first = view.container.querySelector("p")
    view.rerender(<Markdown text={"First **bold** paragraph.\n\nSecond one grows"} streaming />)
    expect(view.container.querySelector("p")).toBe(first)
    expect(view.container.querySelectorAll("p")).toHaveLength(2)

    const fenced = "```ts\nconst a = 1\n\nconst b = 2\n```\n\nAfter"
    view.rerender(<Markdown text={fenced} streaming />)
    expect(view.container.querySelectorAll(".codeBlock")).toHaveLength(1)
    expect(view.container.querySelector("code")?.textContent).toBe("const a = 1\n\nconst b = 2")

    view.rerender(<Markdown text={"- one\n\n- two"} streaming />)
    expect(view.container.querySelectorAll("ul")).toHaveLength(2)
    view.rerender(<Markdown text={"- one\n\n- two"} />)
    expect(view.container.querySelectorAll("ul")).toHaveLength(1)
  })

  it("preserves code/table elements, selection, horizontal scroll, and copy state while text grows", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
    const view = render(<Markdown text={markdown} />)
    const table = view.container.querySelector(".md-tableWrap") as HTMLElement
    const code = view.container.querySelector(".codeBlock") as HTMLElement
    table.scrollLeft = 70
    // Highlighting nests the first token in a span; select the text inside it.
    const textNode = document
      .createTreeWalker(code.querySelector("code") as Node, NodeFilter.SHOW_TEXT)
      .nextNode()
    if (!textNode) throw new Error("Code text is missing")
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 5)
    const selection = window.getSelection()
    if (!selection) throw new Error("Selection is unavailable")
    selection.removeAllRanges()
    selection.addRange(range)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy code" })))
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy()

    view.rerender(<Markdown text={`${markdown} answer continues`} />)
    expect(view.container.querySelector(".md-tableWrap")).toBe(table)
    expect(view.container.querySelector(".codeBlock")).toBe(code)
    expect(table.scrollLeft).toBe(70)
    expect(selection.toString()).toBe("const")
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("const answer = 42")
  })

  it("does not reparse a completed diff when the tool's activity status changes", async () => {
    const runtime = await testRuntime()
    const entry = {
      id: 1,
      kind: "tool" as const,
      speaker: "Tool" as const,
      text: "Edit",
      diff: "@@ -1 +1 @@\n-old\n+new",
    }
    const card = (props: Partial<typeof entry>, active: boolean) => (
      <DesktopProvider value={runtime}>
        <ToolCard entry={{ ...entry, ...props }} active={active} />
      </DesktopProvider>
    )
    const view = render(card({}, true))
    const line = view.container.querySelector(".diffLine")
    expect(line).toBeTruthy()
    view.rerender(card({ text: "Edited file" }, false))
    // A status-only change keeps the parsed diff rows; the same DOM nodes stay mounted.
    expect(view.container.querySelector(".diffLine")).toBe(line)
    view.rerender(card({ diff: "@@ -1 +1 @@\n-old\n+changed" }, false))
    expect(view.container.textContent).toContain("changed")
  })
})

describe("user delivery markers", () => {
  it("marks a queued prompt with a list-end icon instead of a text badge", () => {
    const entry = {
      id: 1,
      kind: "message" as const,
      speaker: "You" as const,
      text: "Follow up",
      delivery: "queued" as const,
    }
    const view = render(
      <EntryView
        entry={entry}
        active={false}
        thinkingVisible={false}
        expanded={false}
        onExpandedChange={() => {}}
      />,
    )
    expect(view.container.querySelector(".userRow-queued")).toBeTruthy()
    expect(screen.getByRole("img", { name: "Queued" })).toBeTruthy()
    expect(view.container.querySelector(".deliveryTag")).toBeNull()
    const row = view.container.querySelector(".userRow") as HTMLElement
    expect(row.firstElementChild?.className).toContain("queuedIndicator")
    expect(row.querySelector(".userMessage")?.textContent).toBe("Follow up")
  })

  it("keeps the steering wheel in front of the message", () => {
    const entry = {
      id: 2,
      kind: "message" as const,
      speaker: "You" as const,
      text: "Steer this",
      delivery: "steering" as const,
    }
    const view = render(
      <EntryView
        entry={entry}
        active={false}
        thinkingVisible={false}
        expanded={false}
        onExpandedChange={() => {}}
      />,
    )
    expect(view.container.querySelector(".userRow-steering")).toBeTruthy()
    expect(screen.getByRole("img", { name: "Steering" })).toBeTruthy()
    const row = view.container.querySelector(".userRow") as HTMLElement
    expect(row.firstElementChild?.className).toContain("steeringIndicator")
    expect(row.querySelector(".userMessage")?.textContent).toBe("Steer this")
  })
})

async function testRuntime() {
  const api = createDemoRuntime()
  const snapshot = await api.getSnapshot()
  const listeners = new Set<(event: DesktopEvent) => void>()
  api.subscribe = (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const store = new DesktopViewStore(api)
  await store.start()
  return {
    api,
    store,
    snapshot,
    emit: (event: DesktopEvent) => {
      for (const listener of listeners) listener(event)
    },
  }
}

describe("scoped desktop subscriptions", () => {
  it("keeps status consumers idle during transcript updates, but delivers their selected changes", async () => {
    const runtime = await testRuntime()
    let renders = 0
    function Status() {
      const state = useDesktopState("busy", "theme")
      renders++
      return (
        <span>
          {state?.busy ? "Working" : "Idle"} {state?.theme}
        </span>
      )
    }
    render(
      <DesktopProvider value={runtime}>
        <Status />
      </DesktopProvider>,
    )
    const initial = renders
    for (let index = 1; index <= 20; index++) {
      await act(async () =>
        runtime.emit({
          type: "transcript",
          revision: runtime.snapshot.revision + index,
          ops: [
            {
              op: "upsert",
              entry: { id: 99, kind: "message", speaker: "Otis", text: `Token ${index}` },
            },
          ],
        }),
      )
    }
    expect(renders).toBe(initial)
    await act(async () =>
      runtime.emit({
        type: "status",
        revision: runtime.snapshot.revision + 21,
        status: { ...runtime.snapshot, busy: true },
      }),
    )
    expect(screen.getByText(/Working/)).toBeTruthy()
    expect(renders).toBe(initial + 1)
    runtime.store.dispose()
  })

  it("polls a running trace, and stops fetching once it finishes", async () => {
    vi.useFakeTimers()
    const runtime = await testRuntime()
    let revision = runtime.snapshot.revision
    const run = { toolCallId: "trace", title: "Test trace", status: "running" as const, tools: 0 }
    runtime.emit({
      type: "status",
      revision: ++revision,
      status: { ...runtime.snapshot, subagents: [run] },
    })
    const getTrace = vi.fn(async () => ({ revision: 0, entries: [] }))
    runtime.api.getSubagentTrace = getTrace
    render(
      <DesktopProvider value={runtime}>
        <AgentTraceOverlay toolCallId="trace" onClose={() => {}} />
      </DesktopProvider>,
    )
    await act(async () => {})
    expect(getTrace).toHaveBeenCalledTimes(1)
    await act(async () => runtime.emit({ type: "transcript", revision: ++revision, ops: [] }))
    expect(getTrace).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTime(250))
    expect(getTrace).toHaveBeenCalledTimes(2)
    await act(async () =>
      runtime.emit({
        type: "status",
        revision: ++revision,
        status: { ...runtime.snapshot, subagents: [{ ...run, status: "complete" }] },
      }),
    )
    const afterCompletion = getTrace.mock.calls.length
    expect(afterCompletion).toBeGreaterThan(2)
    await act(async () => vi.advanceTimersByTime(1000))
    expect(getTrace).toHaveBeenCalledTimes(afterCompletion)
    vi.useRealTimers()
    runtime.store.dispose()
  })
})
