# Document specification

`document.py create` accepts a UTF-8 JSON object. Unknown options are rejected so typos cannot silently change output.
All text is literal, not Markdown or HTML. Use plain strings, not formatting tags. The same spec produces PDF or DOCX.

```json
{
  "title": "Resume",
  "page_size": "letter",
  "margin_mm": 18,
  "font_size": 10.5,
  "max_pages": 2,
  "blocks": [
    { "type": "heading", "level": 0, "text": "Alex Morgan" },
    { "type": "paragraph", "text": "alex@example.com | Boston, MA" },
    { "type": "heading", "level": 1, "text": "Experience" },
    { "type": "paragraph", "text": "Engineer — Example Company, 2022–2025" },
    { "type": "bullets", "items": ["A verified achievement", "Another verified achievement"] },
    { "type": "table", "rows": [["Skill", "Experience"], ["TypeScript", "3 years"]] },
    { "type": "page_break" },
    { "type": "paragraph", "text": "Additional information" }
  ]
}
```

- `blocks` is required: 1–1000 blocks, at most 200,000 text characters in total.
- `title` is optional metadata. Include a heading block to display a title.
- `page_size`: `letter` (default) or `a4`.
- `margin_mm`: 10–40, default 18. Applied to all sides.
- `font_size`: 9–16 points, default 11. Headings are scaled from this size.
- `max_pages`: optional 1–500; **PDF only**. Creation fails if the PDF exceeds it. DOCX cannot know its rendered
  page count; leave this out of DOCX specs and check a converted PDF instead.
- `font_path`: optional absolute path to a TrueType font for PDFs. The helper otherwise checks common local Unicode
  font locations. Font coverage is validated against all document text. This does not provide complex-script shaping;
  right-to-left scripts require another rendering workflow. DOCX uses Arial and the reader's installed fonts.
- Heading `level`: integer 0–3, default 1. Level 0 is a document title.
- Paragraphs may contain line breaks. Tabs and invalid XML control characters are rejected.
- Bullets require 1–200 literal strings.
- Tables require 1–200 rows, 1–8 columns, equal column counts, and string cells. The first row is a repeated header
  in PDFs. Columns have equal widths. Oversize rows fail rather than being clipped.
- Page breaks may not be first, last, or adjacent.

The helper creates a clean single-column document. It does not import a PDF's layout, reproduce arbitrary templates,
embed remote assets, or accept executable templates. Use it for new documents or when the user has requested or agreed
to recreation with a new layout. Updating an existing document defaults to preserving its design: use `edit_document`
on a saved copy for supported DOCX edits. Do not claim a generated DOCX has visually identical layout to a generated PDF.

## PDF edit plan

The `document` tool’s `edit-pdf` operation accepts a different JSON format, based on the actual `inspect-pdf` output:

```json
{
  "source_sha256": "copy the exact source_sha256 from inspection",
  "edits": [
    {
      "page": 1,
      "objects": [3, 4],
      "old": "Built reliable software for customers.\nLed an engineering team.",
      "new": "Built dependable software and led a team."
    }
  ]
}
```

The IDs above are illustrative. `page` is one-based; object IDs come from inspection and are tied to that exact source
hash. `old` must equal the selected objects' text joined with a newline, including any original spaces. `new` is one
paragraph of plain text: the editor wraps it using the original line positions. It must actually change the text.

- 1–50 edits, with 1–100 unique object IDs each, in source order; no overlapping edits.
- Select consecutive text objects from one paragraph with the same font, size, color, and horizontal scale.
- Adjacent fragments on a line can be combined; subsequent lines must have the same indentation and normal spacing.
- Each old/new value is limited to 12,000 characters; the plan is limited to 1 MB and 200,000 text characters.
- The source's original font and paragraph width/line count are fixed. No font substitution, font shrinking, arbitrary
  rectangles, or changes to surrounding content are accepted. Missing glyphs and overflow fail without an output file.
- After a saved edit, inspect that output again before further changes: the hash and object IDs can change.
