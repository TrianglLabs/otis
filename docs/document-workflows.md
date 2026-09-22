# Document workflows

Otis can adapt uploaded documents into real PDF or DOCX deliverables. The bundled `documents` skill coordinates
native file editing, the structured `document` tool, and Canvas publication. It is available in terminal, headless,
and desktop sessions; no manual skill download, separate document service, or API key is required.

For example: attach a PDF resume and ask, “Adapt my resume to this job and deliver a two-page PDF.” Otis should read
the resume and job and preserve factual information. Updates default to keeping the existing design. Otis inspects
PDF text objects and edits supported paragraphs within their original space, then verifies and publishes the PDF.
If the source or proposed changes exceed the editor's capabilities, it must explain that specific limitation and
request an editable source or agreement to recreate it. A Markdown draft alone is not a completed PDF request.

## Capabilities

| Operation | Implementation | Dependencies |
| --- | --- | --- |
| Read PDF/DOCX text; preview in Canvas | Native Otis document pipeline | Included with Otis |
| Save an upload's original bytes into the workspace | `save_attachment` | Included with Otis |
| Replace text in an existing Word document | `edit_document` | Included with Otis |
| Fill interactive PDF forms | `edit_document` | Included with Otis |
| Edit existing PDF text while retaining fonts and surrounding design | Bundled PDFium helper with fit and rendered-page checks | Python 3.10+; packages prepared by Otis |
| Generate PDF/DOCX with headings, paragraphs, bullets, tables | Bundled document helper | Python 3.10+; packages prepared by Otis |
| Convert Word to PDF | Bundled helper with an isolated LibreOffice profile | Python 3.10+ and local LibreOffice |
| Render PDF pages to PNG for review | Bundled helper using PDFium | Python 3.10+; packages prepared by Otis |

The native editor creates a sibling copy by default; explicit replacement keeps a private backup. The generation
helper always creates a new file and refuses to overwrite an existing destination. PDFs are reopened and checked
against the intended text before the output is saved; an optional page limit fails explicitly if exceeded. DOCX
outputs are reopened and their text checked in document order. Font coverage failures do not silently discard text.

Uploaded documents are immutable session sources, not filesystem paths. `save_attachment` selects a source by the
SHA-256 shown in its model metadata or a unique filename, validates its bytes, and writes a private workspace copy.
The original remains available after compaction and session restoration. Two different uploads with the same name
require content identity rather than guessing which to edit.

## Local setup

The skill instructions and helpers ship inside the Otis release. The model loads `documents` with the `skill` tool;
users do not install the skill themselves. Loading it makes its versioned helper files available locally;
it does not execute them or install anything. The returned instructions include the absolute skill directory.

The `document` tool runs fixed bundled helpers with argument arrays, outside a shell. It resolves source, spec and
output paths inside the workspace before setup. Its `check` operation reports readiness without installation.
Other operations automatically prepare a private environment under
`<Otis data directory>/document-runtime/<manifest revision>` when needed. They follow the normal mutation permission policy, including first-use installation.

All required packages, including transitive dependencies, are pinned. Setup installs wheels from PyPI into that
isolated environment, checks dependency consistency, exact versions and imports, then reuses it across workspaces
and app adapters. Concurrent setup is serialized; failed or cancelled installations are removed and can be retried.
A changed manifest gets a separate environment, so an upgrade does not modify an older version's dependencies.
Subprocesses have bounded time/output, support cancellation, and do not inherit provider keys or Python/pip overrides.
The model does not manage pip, create workspace virtual environments, or choose packages to install.

Python 3.10+ must already be installed and discoverable. Otis does not download Python or install LibreOffice.
Missing Python produces a clear setup error. LibreOffice is optional and only needed for Word-to-PDF conversion.
Native reading, DOCX text editing and PDF form filling work without either. A missing dependency must be explained;
Otis must not substitute another file format without the user's agreement.

For example, after saving an uploaded PDF with `save_attachment`, call:

```json
{"operation":"inspect-pdf","path":"resume.pdf"}
{"operation":"edit-pdf","path":"resume.pdf","spec_path":"resume-edits.json","output_path":"resume-adapted.pdf"}
```

The edit plan is described in the bundled skill's `spec.md`. Creation uses `operation: "create"` with `spec_path`
and `output_path`; conversion uses `"convert"` with a DOCX `path` and PDF `output_path`; rendering uses `"render"`
with a PDF `path`, new output directory and optional `pages` array. Finish with `publish_artifact`.

## Limits and review

PDF text editing changes actual text objects in the original pages. Inspection returns object IDs, original text,
styling, and a source hash; an edit plan must match that exact source. Words wrap within the selected paragraph's
original width and existing baselines, retaining font size and color. Old text is replaced, and unused lines are
removed. There are no covering rectangles, substituted fonts, or automatic font shrinking. Output is always a new
file. The editor reopens it, checks readable replacement text with two PDF libraries, preserves page count, and
compares every page at 144 DPI. Any changed pixels outside edited glyph bounds plus a one-point antialiasing margin
cause failure before publication.

Supported targets are consecutive, horizontal, visible, unclipped top-level text objects with uniform font, size,
color, and normal line spacing. Separate edits can target different styles. The original font must encode the new
characters. Missing glyphs, overflow, overlap, rotated text, complex-script shaping, scanned text, and nested form
artwork require another workflow. Signed and encrypted PDFs are rejected. Documents are limited to 50 pages,
20 million rendered pixels per page, and 100 million pixels per comparison. The automated comparison checks the
unchanged surroundings; it does not verify facts or replace a human review of the edited content.

The generator produces a clean, flowing single-column layout. It does not recover an existing PDF's design or turn
ordinary PDF page text into editable Word structures. The workflow requires an explicit redesign request or agreement
before recreating an existing document; a content-update request alone is insufficient. This is model guidance,
not a guarantee that every model will choose the correct operation.

Native DOCX text replacements keep the original package, styles, images, tables, and paragraph structure. Replacement
text inherits the first changed run's formatting, so edits across mixed formatting need care. Longer or shorter text
can reflow lines and pages. Exact visual fidelity needs rendered comparison; pagination may also change with fonts
or Word/LibreOffice differences. The original upload remains intact.

Text and package validation are not visual inspection. Rendering produces page images for a separate inspection step.
Otis must say when it has checked structure and content but has not visually reviewed the pages. Canvas previews let
the user inspect the result, but showing a preview does not prove the model inspected it.

Canvas's **Save a copy** action saves the original bytes of the displayed document, including a selected older
published revision, and works even when the preview itself could not render. Word exports stay DOCX even though
their preview is HTML. Choosing a destination uses the native Save dialog; cancelling does not write a file. A changed
selection or session during preparation invalidates the export.

Scanned PDFs require a separate OCR workflow. The helper does not provide image editing, complex-script shaping,
unrestricted PDF page reflow, spreadsheets, or slides. Text/Markdown/code use the normal file tools. Unsupported
operations and formats should be identified explicitly rather than replaced with Markdown.

## Development checks

The normal Bun suite covers attachment permissions, original-byte preservation, session source retention, native
editing/publication, and bundled-resource behavior in compiled and CommonJS builds. Run helper behavior tests in a
Python environment containing its requirements:

```sh
python3 -m pip install -r tests/documents/requirements.txt
ruff check src/skills/bundled/documents tests/documents
ruff format --check src/skills/bundled/documents tests/documents
python3 -m unittest discover -s tests/documents -p 'test_*.py'
```

The document CI job installs LibreOffice and requires the real conversion integration test as well as PDF creation,
DOCX creation, PDF rendering, and failure-mode tests. Local runs report the conversion test as skipped if LibreOffice
is absent; missing Python dependencies fail rather than silently skipping the generation tests.
PDF editing tests exercise standard and embedded fonts, split text runs, multiline edits, original artwork and links,
unchanged pages, stale plans, overflow, missing glyphs, signatures, encryption, and unexpected visual changes.
