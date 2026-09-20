---
name: documents
description: Create, adapt, convert, and verify PDF and DOCX deliverables, including resumes. Preserve existing design and requested formats.
---

# Document deliverables in Otis

Use the structured `document` tool for local PDF editing, PDF/DOCX creation, conversion, and PDF rendering.
Otis runs bundled first-party helpers and prepares their private runtime. No separate service or API key is needed.
Use `edit_document` for native DOCX text replacements and interactive PDF forms.

## Choose the operation

1. Keep the uploaded document's format unless the user requested another. Markdown drafts and JSON specifications
   are intermediate files, not finished deliverables. Updating content does not authorize changing its design.
2. An attachment name is not a filesystem path. Use `save_attachment` with its SHA-256 (or unique name) and a new
   workspace path to obtain the original bytes. Never reconstruct source bytes from extracted text or session files.
3. Read the source and supplied reference URLs with `read` and `web_read`. Preserve facts; a resume adaptation must
   not invent jobs, skills, achievements, dates, or credentials. Flag missing facts instead.
4. Use `edit_document` for Word text changes: it keeps the existing package, styles, images, tables, and paragraph
   structure. Keep replacements focused; replacement text inherits the first changed run's formatting. Text changes
   can reflow lines and pages. Use that tool for interactive PDF form fields too. Its default output is a copy.
5. Use `document` with `inspect-pdf` then `edit-pdf` for ordinary PDF text changes. This retains original fonts,
   colors, positions and page artwork, with automated fit and rendering checks before saving.
6. Use `create` for a new document or an explicitly requested/agreed recreation. A substantial rewrite alone does
   not authorize recreation. If an edit cannot preserve the design, explain the specific limitation and request an
   editable source (such as DOCX), or agreement to recreate it. Prior agreement is sufficient; do not ask again.
7. Text, Markdown and code use ordinary file tools. Scanned PDFs need a separate OCR workflow. This helper does not
   provide OCR, image modification, spreadsheets, slides, complex-script shaping, or unrestricted PDF page reflow.

## Runtime and permissions

`document` with `{"operation":"check"}` reports Python, prepared dependencies and LibreOffice availability without
installing anything. Other operations automatically prepare and verify a reusable environment in Otis's private data
folder when needed. A not-yet-prepared environment is normal: run the requested operation to prepare it.
Do not construct pip commands, create workspace virtual environments, or download skills manually.

Python 3.10+ must already be installed. Word-to-PDF conversion additionally requires local LibreOffice; direct PDF
creation and editing do not. Missing Python or LibreOffice is reported explicitly. Explain the missing capability
rather than changing the deliverable's format. Do not promise a successful output before its checks pass.

All operations except `check` follow the `document` tool's mutation permission policy, including dependency setup.
Skill loading grants no execution permission. If the tool is unavailable or denied, report that limitation; do not
bypass it by running the bundled script or installing packages through the shell. Native reading and `edit_document`
remain available under their own policies.

## Edit an existing PDF

After saving and reading the original upload, inspect its text objects:

```json
{"operation":"inspect-pdf","path":"resume.pdf"}
```

Read the PDF edit plan in `spec.md`. Inspection returns the source hash and text objects with IDs, original text,
fonts, sizes, colors, bounds, and unsupported reasons. Use `pages:[1,2]` to inspect a subset (at most 20 pages per call).
Copy IDs and exact original text from this output. Never guess them from extracted plain text.
Write a JSON edit plan with `write`, then execute it:

```json
{"operation":"edit-pdf","path":"resume.pdf","spec_path":"resume-edits.json","output_path":"resume-adapted.pdf"}
```

The editor changes actual text using the original font, color and baselines. Words wrap within the selected
paragraph's original width and existing lines. Select one uniformly formatted paragraph per edit; target different
styles separately. Preserve bullets, headings and facts. Unused original lines are removed.

The helper reopens the output with two PDF readers, checks page count, and compares every page at 144 DPI. Pixels
outside edited glyph bounds (plus a one-point antialiasing margin) must remain identical. This is an automated
comparison, not a human review or proof of factual accuracy. Read the output and inspect rendered pages when an
image capability is available, then publish the finished PDF.

Supported targets are horizontal, visible, unclipped top-level text with a font that encodes the replacement.
Scanned text, nested form artwork, signed/encrypted PDFs, rotated/skewed text and complex-script shaping require
another workflow. Documents are limited to 50 pages and bounded rendering size. A fit failure means the wording
exceeds the original space: shorten without losing intended meaning, or explain the limitation. Never shrink fonts,
substitute fonts, cover old text, bypass failed validation, or silently recreate pages to force an edit through.

## Create, convert and render

For a new document or agreed recreation, read `spec.md` through the `skill` tool. Write the bounded JSON specification
with `write` and choose the requested extension:

```json
{"operation":"create","spec_path":"resume.json","output_path":"resume.pdf"}
{"operation":"create","spec_path":"resume.json","output_path":"resume.docx"}
```

The helper validates the specification, reopens the generated document and checks expected text. It refuses existing
outputs; use a new filename for iterations. PDF `max_pages` limits fail rather than shrinking or dropping text.
Unsupported glyphs fail explicitly. This generator produces a new flowing layout; it cannot recover an upload's design.

To convert Word with its layout engine:

```json
{"operation":"convert","path":"resume.docx","output_path":"resume.pdf"}
```

Conversion uses an isolated LibreOffice profile and checks body/table text. Fonts and pagination may still differ
from Microsoft Word. Conversion alone does not establish visual fidelity.

To render PDF pages for review:

```json
{"operation":"render","path":"resume.pdf","output_path":"resume-preview","pages":[1,2]}
```

The output is a new directory of page PNGs. Rendering does not inspect the images. Use an available image capability;
otherwise say that visual layout remains unreviewed. Convert a Word copy to PDF before checking pagination.

## Verify and deliver

1. A tool failure means there is no completed deliverable. Explain the specific failure before choosing an alternative.
2. Read the actual output, check requested changes and facts, and check its format and page count.
3. Review rendered pages when possible. Canvas previews alone are not evidence that the model inspected the result.
4. Call `publish_artifact` on the final PDF/DOCX. Revisions use the same artifact ID. Describe the changes and material
   limits. Do not publish a JSON plan or Markdown draft as the finished document.

For a PDF resume plus a job URL, completion means an adapted, validated PDF with truthful content, or an explicit
explanation of the blocker. Producing a Markdown resume alone does not complete the request.
