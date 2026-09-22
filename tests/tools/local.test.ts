import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PDFDocument, rgb, StandardFonts } from "pdf-lib"
import { afterEach, describe, expect, it } from "vitest"
import { executeToolCall } from "../../src/tools/index.js"
import type { ToolContext } from "../../src/tools/types.js"
import { minimalDocx, minimalPdf } from "../inference/support/document-fixtures.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("executeToolCall", () => {
  it("rejects binary and invalid UTF-8 writes and edits without changing source bytes", async () => {
    const context = await testContext()
    const fixtures: [string, Uint8Array][] = [
      ["brief.docx", await minimalDocx("Keep original")],
      ["report.pdf", minimalPdf("Keep original")],
      ["renamed.txt", minimalPdf("Keep original")],
      ["binary.bin", new Uint8Array([65, 0, 66])],
      ["invalid.txt", new Uint8Array([65, 255, 66])],
    ]
    for (const [name, bytes] of fixtures) {
      const path = join(context.cwd, name)
      await writeFile(path, bytes)
      await expect(
        executeToolCall({ name: "write", input: { path: name, content: "replacement" } }, context),
      ).rejects.toThrow()
      await expect(
        executeToolCall({ name: "edit", input: { path: name, old: "A", new: "B" } }, context),
      ).rejects.toThrow()
      expect(new Uint8Array(await readFile(path))).toEqual(bytes)
    }
    await expect(
      executeToolCall(
        { name: "write", input: { path: "new.docx", content: "fake Word" } },
        context,
      ),
    ).rejects.toThrow("format-aware editor")
    await expect(readFile(join(context.cwd, "new.docx"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("preserves UTF-8 BOMs when editing text", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "bom.txt"), "\uFEFFFirst draft")
    await executeToolCall(
      { name: "edit", input: { path: "bom.txt", old: "First", new: "Final" } },
      context,
    )
    expect(await readFile(join(context.cwd, "bom.txt"), "utf8")).toBe("\uFEFFFinal draft")
    await writeFile(join(context.cwd, "format.txt"), "A PDF starts with %PDF-1.7.")
    await executeToolCall(
      { name: "edit", input: { path: "format.txt", old: "1.7", new: "2.0" } },
      context,
    )
    expect(await readFile(join(context.cwd, "format.txt"), "utf8")).toBe(
      "A PDF starts with %PDF-2.0.",
    )
  })

  it("reports document extraction limits even when offsets exceed the extracted range", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "long.docx"), await minimalDocx("A".repeat(160_001)))
    for (const offset of [1, 5000]) {
      const result = await executeToolCall(
        { name: "read", input: { path: "long.docx", offset } },
        context,
      )
      expect(result.output).toContain("Document extraction stopped at 160000 characters")
      expect(result.output).toContain("later offsets cannot retrieve it")
      expect(result.output).not.toContain("File is empty")
    }
  })

  it("writes files and reads a requested line range", async () => {
    const context = await testContext()

    const write = await executeToolCall(
      { name: "write", input: { path: "notes.txt", content: "one\ntwo\nthree" } },
      context,
    )
    expect(write.output).toBe("Wrote 13 characters.")

    const read = await executeToolCall(
      { name: "read", input: { path: "notes.txt", offset: 2, limit: 1 } },
      context,
    )
    expect(read.output).toBe("2: two")
  })

  it("lists directories deterministically and marks nested directories", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, "src"))
    await writeFile(join(context.cwd, "README.md"), "hello", "utf8")

    const result = await executeToolCall({ name: "read", input: { path: "." } }, context)

    expect(result.output).toBe("README.md\nsrc/")
  })

  it("rejects image and binary files instead of decoding them as text", async () => {
    const context = await testContext()
    await writeFile(
      join(context.cwd, "screen.png"),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    await writeFile(join(context.cwd, "data.bin"), new Uint8Array([0x01, 0x00, 0x02]))

    await expect(
      executeToolCall({ name: "read", input: { path: "screen.png" } }, context),
    ).rejects.toThrow("Attach the image to an Otis prompt instead")
    await expect(
      executeToolCall({ name: "read", input: { path: "data.bin" } }, context),
    ).rejects.toThrow("read supports UTF-8 text, PDF, and DOCX files only")
  })

  it("reads PDF and DOCX text while returning their native Canvas artifacts", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "report.pdf"), minimalPdf("PDF tool text"))
    await writeFile(join(context.cwd, "brief.docx"), await minimalDocx("Word tool text"))

    const pdf = await executeToolCall({ name: "read", input: { path: "report.pdf" } }, context)
    const docx = await executeToolCall({ name: "read", input: { path: "brief.docx" } }, context)

    expect(pdf.output).toContain("PDF tool text")
    expect(pdf.artifact).toEqual({ source: "workspace", path: "report.pdf", kind: "pdf" })
    expect(docx.output).toContain("Word tool text")
    expect(docx.artifact).toEqual({ source: "workspace", path: "brief.docx", kind: "docx" })
  })

  it("marks only document and webpage writes as Canvas artifacts", async () => {
    const context = await testContext()
    const markdown = await executeToolCall(
      { name: "write", input: { path: "draft.md", content: "# Draft" } },
      context,
    )
    const webpage = await executeToolCall(
      { name: "write", input: { path: "page.html", content: "<h1>Page</h1>" } },
      context,
    )
    const code = await executeToolCall(
      { name: "write", input: { path: "app.ts", content: "export {}" } },
      context,
    )

    expect(markdown.artifact).toEqual({ source: "workspace", path: "draft.md", kind: "markdown" })
    expect(webpage.artifact).toEqual({ source: "workspace", path: "page.html", kind: "html" })
    expect(code.artifact).toBeUndefined()
  })

  it("edits exactly one occurrence and rejects ambiguous replacements", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "message.txt"), "alpha beta beta", "utf8")

    await expect(
      executeToolCall(
        { name: "edit", input: { path: "message.txt", old: "beta", new: "gamma" } },
        context,
      ),
    ).rejects.toThrow("old string appears multiple times")

    await executeToolCall(
      { name: "edit", input: { path: "message.txt", old: "alpha", new: "omega" } },
      context,
    )
    await expect(readFile(join(context.cwd, "message.txt"), "utf8")).resolves.toBe(
      "omega beta beta",
    )
  })

  it("edits DOCX text across formatting runs into a validated sibling copy", async () => {
    const context = await testContext()
    const source = await splitRunDocx("Senior ", "Engineer")
    await writeFile(join(context.cwd, "resume.docx"), source)

    const result = await executeToolCall(
      {
        name: "edit_document",
        input: {
          path: "resume.docx",
          replaceOriginal: false,
          operation: {
            kind: "replace_text",
            replacements: [{ old: "Senior Engineer", new: "Staff Engineer" }],
          },
        },
      },
      context,
    )

    expect(new Uint8Array(await readFile(join(context.cwd, "resume.docx")))).toEqual(source)
    const edited = await executeToolCall(
      { name: "read", input: { path: "resume-edited.docx" } },
      context,
    )
    const editedArchive = await (await import("jszip")).default.loadAsync(
      await readFile(join(context.cwd, "resume-edited.docx")),
    )
    const documentXml = await editedArchive.file("word/document.xml")?.async("string")
    expect(edited.output).toContain("Staff Engineer")
    expect(documentXml).toContain("<w:b/>")
    expect(documentXml).toContain("<w:i/>")
    expect(documentXml).toContain("<w:t>Engineer</w:t>")
    expect(result.output).toContain("The original file was not changed")
    expect(result.diff).toContain("-Senior Engineer")
    expect(result.diff).toContain("+Staff Engineer")
    expect(result.artifact).toEqual({
      source: "workspace",
      path: "resume-edited.docx",
      kind: "docx",
    })
  })

  it("does not publish partial DOCX edits when a replacement is missing or ambiguous", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "resume.docx"), await minimalDocx("Engineer Engineer"))

    await expect(
      executeToolCall(
        {
          name: "edit_document",
          input: {
            path: "resume.docx",
            replaceOriginal: false,
            operation: {
              kind: "replace_text",
              replacements: [{ old: "Engineer", new: "Developer" }],
            },
          },
        },
        context,
      ),
    ).rejects.toThrow("appears 2 times")
    await expect(readFile(join(context.cwd, "resume-edited.docx"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("backs up a DOCX before explicitly replacing the original", async () => {
    const context = await testContext()
    const source = await minimalDocx("First draft")
    await writeFile(join(context.cwd, "resume.docx"), source)

    const result = await executeToolCall(
      {
        name: "edit_document",
        input: {
          path: "resume.docx",
          replaceOriginal: true,
          operation: { kind: "replace_text", replacements: [{ old: "First", new: "Final" }] },
        },
      },
      context,
    )

    expect(
      (await executeToolCall({ name: "read", input: { path: "resume.docx" } }, context)).output,
    ).toContain("Final draft")
    const backup = result.output.match(/backed up at (.+)\.\n/)?.[1]
    expect(backup).toBeDefined()
    expect(new Uint8Array(await readFile(backup as string))).toEqual(source)
  })

  it("fills an interactive PDF into a validated copy and keeps it editable", async () => {
    const context = await testContext()
    const source = await fillablePdf()
    await writeFile(join(context.cwd, "application.pdf"), source)

    const before = await executeToolCall(
      { name: "read", input: { path: "application.pdf" } },
      context,
    )
    expect(before.output).toContain("Name (TextField)")
    expect(before.output).toContain('Confirmed (CheckBox): value="false"')

    const result = await executeToolCall(
      {
        name: "edit_document",
        input: {
          path: "application.pdf",
          replaceOriginal: false,
          operation: {
            kind: "fill_pdf_form",
            fields: { Name: "Ada Lovelace", Confirmed: "true", Role: "Engineer" },
          },
        },
      },
      context,
    )

    const original = await PDFDocument.load(await readFile(join(context.cwd, "application.pdf")))
    expect(original.getForm().getTextField("Name").getText()).toBeUndefined()
    const edited = await PDFDocument.load(
      await readFile(join(context.cwd, "application-edited.pdf")),
    )
    expect(edited.getForm().getTextField("Name").getText()).toBe("Ada Lovelace")
    expect(edited.getForm().getCheckBox("Confirmed").isChecked()).toBe(true)
    expect(edited.getForm().getDropdown("Role").getSelected()).toEqual(["Engineer"])
    expect(result.output).toContain("result remains fillable")
    expect(result.artifact).toEqual({
      source: "workspace",
      path: "application-edited.pdf",
      kind: "pdf",
    })
  })

  it("directs PDF text edits to the bundled workflow and refuses to overwrite a copy", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "report.pdf"), minimalPdf("Original report"))
    await writeFile(join(context.cwd, "report-edited.pdf"), minimalPdf("Existing copy"))

    await expect(
      executeToolCall(
        {
          name: "edit_document",
          input: {
            path: "report.pdf",
            outputPath: "rewrite.pdf",
            replaceOriginal: false,
            operation: { kind: "replace_text", replacements: [{ old: "Original", new: "Final" }] },
          },
        },
        context,
      ),
    ).rejects.toThrow("inspect-pdf/edit-pdf")
    await expect(
      executeToolCall(
        {
          name: "edit_document",
          input: {
            path: "report.pdf",
            replaceOriginal: false,
            operation: { kind: "fill_pdf_form", fields: { Name: "Ada" } },
          },
        },
        context,
      ),
    ).rejects.toThrow("output file already exists")
  })

  it("generates a unified diff for edits", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "app.ts"), "const a = 1\nconst b = 2\n", "utf8")

    const result = await executeToolCall(
      { name: "edit", input: { path: "app.ts", old: "const a = 1", new: "const a = 2" } },
      context,
    )

    expect(result.diff).toBeDefined()
    expect(result.diff).toContain("---")
    expect(result.diff).toContain("+++")
    expect(result.diff).toContain("@@")
    expect(result.diff).toContain("-const a = 1")
    expect(result.diff).toContain("+const a = 2")
  })

  it("generates a unified diff when overwriting an existing file via write", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "config.json"), '{"v": 1}', "utf8")

    const result = await executeToolCall(
      { name: "write", input: { path: "config.json", content: '{"v": 2}' } },
      context,
    )

    expect(result.diff).toBeDefined()
    expect(result.diff).toContain('-{"v": 1}')
    expect(result.diff).toContain('+{"v": 2}')
  })

  it("generates an all-additions diff when writing a new file", async () => {
    const context = await testContext()

    const result = await executeToolCall(
      { name: "write", input: { path: "new.ts", content: "const x = 1\n" } },
      context,
    )

    expect(result.diff).toBeDefined()
    expect(result.diff).toContain("+++")
    expect(result.diff).toContain("+const x = 1")
    expect(result.diff).not.toContain("-const")
  })

  it("refuses path traversal and symlinks that escape the workspace", async () => {
    const context = await testContext()
    const outsideDir = await trackedTempDir()
    const outsideFile = join(outsideDir, "secret.txt")
    await writeFile(outsideFile, "secret", "utf8")
    await symlink(outsideFile, join(context.cwd, "secret-link.txt"))

    await expect(
      executeToolCall({ name: "read", input: { path: "../secret.txt" } }, context),
    ).rejects.toThrow("Path is outside the workspace")
    await expect(
      executeToolCall({ name: "read", input: { path: "secret-link.txt" } }, context),
    ).rejects.toThrow("Path is outside the workspace")
  })

  it("runs shell commands through the configured workspace", async () => {
    const context = await testContext()
    const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.cwd())"`

    const result = await executeToolCall(
      { name: "bash", input: { command, timeoutMs: 1_000 } },
      context,
    )

    expect(result.output).toContain("Exit code: 0.")
    expect(result.output).toContain(context.cwd)
  })
})

describe("grep", () => {
  it("finds matching lines across nested files with relative paths and line numbers", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, "src"), { recursive: true })
    await writeFile(join(context.cwd, "src", "a.ts"), "const TODO = 1\nconst done = 2\n", "utf8")
    await writeFile(join(context.cwd, "src", "b.ts"), "const TODO = 3\n", "utf8")
    await writeFile(join(context.cwd, "README.md"), "# TODO list\n", "utf8")

    const result = await executeToolCall(
      { name: "grep", input: { pattern: "TODO", path: "." } },
      context,
    )

    expect(result.output.split("\n")).toEqual([
      "README.md:1:# TODO list",
      "src/a.ts:1:const TODO = 1",
      "src/b.ts:1:const TODO = 3",
    ])
  })

  it("supports regex patterns", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "f.ts"), "const a = 1\nconst bb = 2\nconst ccc = 3\n", "utf8")

    const result = await executeToolCall(
      { name: "grep", input: { pattern: "const \\w{2,} =", path: "." } },
      context,
    )

    const lines = result.output.split("\n")
    expect(lines).toContain("f.ts:2:const bb = 2")
    expect(lines).toContain("f.ts:3:const ccc = 3")
    expect(lines).not.toContain("f.ts:1:const a = 1")
  })

  it("filters files by include glob pattern", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "a.ts"), "TODO\n", "utf8")
    await writeFile(join(context.cwd, "b.md"), "TODO\n", "utf8")

    const result = await executeToolCall(
      { name: "grep", input: { pattern: "TODO", path: ".", include: "*.ts" } },
      context,
    )

    expect(result.output).toContain("a.ts:1:TODO")
    expect(result.output).not.toContain("b.md")
  })

  it("include filter matches files at any depth by basename", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, "src", "utils"), { recursive: true })
    await writeFile(join(context.cwd, "src", "utils", "helper.ts"), "TODO\n", "utf8")
    await writeFile(join(context.cwd, "src", "index.ts"), "TODO\n", "utf8")
    await writeFile(join(context.cwd, "src", "notes.md"), "TODO\n", "utf8")

    const result = await executeToolCall(
      { name: "grep", input: { pattern: "TODO", path: ".", include: "*.ts" } },
      context,
    )

    expect(result.output).toContain("src/utils/helper.ts:1:TODO")
    expect(result.output).toContain("src/index.ts:1:TODO")
    expect(result.output).not.toContain("notes.md")
  })

  it("searches a single file when path points to a file", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "target.ts"), "line one\nline two\n", "utf8")

    const result = await executeToolCall(
      { name: "grep", input: { pattern: "two", path: "target.ts" } },
      context,
    )

    expect(result.output).toBe("target.ts:2:line two")
  })

  it("returns a no-matches message when nothing matches", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "f.ts"), "nothing here\n", "utf8")

    const result = await executeToolCall(
      { name: "grep", input: { pattern: "MISSING", path: "." } },
      context,
    )

    expect(result.output).toBe("No matches found.")
  })

  it("respects maxResults and stops early", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "f.ts"), "TODO\nTODO\nTODO\nTODO\nTODO\n", "utf8")

    const result = await executeToolCall(
      { name: "grep", input: { pattern: "TODO", path: ".", maxResults: 2 } },
      context,
    )

    const lines = result.output.split("\n")
    expect(lines).toHaveLength(2)
  })

  it("skips ignored directories like node_modules", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, "node_modules"), { recursive: true })
    await writeFile(join(context.cwd, "node_modules", "dep.ts"), "TODO in deps\n", "utf8")
    await writeFile(join(context.cwd, "app.ts"), "TODO in app\n", "utf8")

    const result = await executeToolCall(
      { name: "grep", input: { pattern: "TODO", path: "." } },
      context,
    )

    expect(result.output).toContain("app.ts:1:TODO in app")
    expect(result.output).not.toContain("node_modules")
  })

  it("searches relevant dot-directories while still excluding .git", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, ".github"), { recursive: true })
    await mkdir(join(context.cwd, ".git"), { recursive: true })
    await writeFile(join(context.cwd, ".github", "workflow.yml"), "release: true\n", "utf8")
    await writeFile(join(context.cwd, ".git", "config"), "release: hidden\n", "utf8")

    const grep = await executeToolCall(
      { name: "grep", input: { pattern: "release", path: "." } },
      context,
    )
    const glob = await executeToolCall(
      { name: "glob", input: { pattern: "**/*.yml", path: "." } },
      context,
    )

    expect(grep.output).toContain(".github/workflow.yml:1:release: true")
    expect(grep.output).not.toContain(".git/config")
    expect(glob.output).toContain(".github/workflow.yml")
  })
})

describe("glob", () => {
  it("finds files matching a pattern recursively", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, "src", "utils"), { recursive: true })
    await writeFile(join(context.cwd, "src", "index.ts"), "", "utf8")
    await writeFile(join(context.cwd, "src", "utils", "helper.ts"), "", "utf8")
    await writeFile(join(context.cwd, "README.md"), "", "utf8")

    const result = await executeToolCall(
      { name: "glob", input: { pattern: "**/*.ts", path: "." } },
      context,
    )

    expect(result.output.split("\n")).toEqual(["src/index.ts", "src/utils/helper.ts"])
  })

  it("matches files in the root directory with a simple pattern", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "a.ts"), "", "utf8")
    await writeFile(join(context.cwd, "b.ts"), "", "utf8")
    await mkdir(join(context.cwd, "src"))
    await writeFile(join(context.cwd, "src", "c.ts"), "", "utf8")

    const result = await executeToolCall(
      { name: "glob", input: { pattern: "*.ts", path: "." } },
      context,
    )

    expect(result.output.split("\n")).toEqual(["a.ts", "b.ts"])
  })

  it("scopes the search to a subdirectory via path", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, "src"), { recursive: true })
    await writeFile(join(context.cwd, "src", "a.ts"), "", "utf8")
    await writeFile(join(context.cwd, "root.ts"), "", "utf8")

    const result = await executeToolCall(
      { name: "glob", input: { pattern: "*.ts", path: "src" } },
      context,
    )

    expect(result.output).toBe("a.ts")
  })

  it("returns a no-files message when nothing matches", async () => {
    const context = await testContext()
    await writeFile(join(context.cwd, "a.txt"), "", "utf8")

    const result = await executeToolCall(
      { name: "glob", input: { pattern: "**/*.ts", path: "." } },
      context,
    )

    expect(result.output).toBe("No files matched.")
  })

  it("respects maxResults and stops early", async () => {
    const context = await testContext()
    for (let i = 0; i < 10; i++) {
      await writeFile(join(context.cwd, `file${i}.ts`), "", "utf8")
    }

    const result = await executeToolCall(
      { name: "glob", input: { pattern: "*.ts", path: ".", maxResults: 3 } },
      context,
    )

    const paths = result.output.split("\n")
    expect(paths).toHaveLength(3)
  })

  it("skips ignored directories like node_modules", async () => {
    const context = await testContext()
    await mkdir(join(context.cwd, "node_modules", "dep"), { recursive: true })
    await writeFile(join(context.cwd, "node_modules", "dep", "index.ts"), "", "utf8")
    await writeFile(join(context.cwd, "app.ts"), "", "utf8")

    const result = await executeToolCall(
      { name: "glob", input: { pattern: "**/*.ts", path: "." } },
      context,
    )

    expect(result.output).toContain("app.ts")
    expect(result.output).not.toContain("node_modules")
  })
})

async function testContext(): Promise<Required<Pick<ToolContext, "cwd" | "dataDirectory">>> {
  return { cwd: await trackedTempDir(), dataDirectory: await trackedTempDir() }
}

async function trackedTempDir() {
  const path = await mkdtemp(join(tmpdir(), "otis-tools-"))
  tempDirs.push(path)
  return path
}

async function splitRunDocx(first: string, second: string) {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(await minimalDocx("placeholder"))
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${first}</w:t></w:r>` +
      `<w:r><w:rPr><w:i/></w:rPr><w:t>${second}</w:t></w:r></w:p></w:body></w:document>`,
  )
  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }))
}

async function fillablePdf() {
  const document = await PDFDocument.create()
  const page = document.addPage([612, 792])
  const font = await document.embedFont(StandardFonts.Helvetica)
  page.drawText("Application form", { x: 50, y: 740, size: 18, font, color: rgb(0, 0, 0) })
  const form = document.getForm()
  form.createTextField("Name").addToPage(page, { x: 50, y: 680, width: 220, height: 24 })
  form.createCheckBox("Confirmed").addToPage(page, { x: 50, y: 630, width: 18, height: 18 })
  const role = form.createDropdown("Role")
  role.addOptions(["Designer", "Engineer"])
  role.select("Designer")
  role.addToPage(page, { x: 50, y: 580, width: 160, height: 24 })
  form.updateFieldAppearances(font)
  return new Uint8Array(await document.save())
}
