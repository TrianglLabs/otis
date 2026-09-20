"""Edit PDF text objects using their existing fonts and verify surrounding page pixels."""

import ctypes
import hashlib
import io
import math
import unicodedata
from contextlib import closing

import pypdfium2 as pdfium
from pypdf import PdfReader

MAX_PAGES = 50
MAX_OBJECTS = 5000
RENDER_SCALE = 2  # 144 DPI; comparison is automated, not a human visual review.


def open_pdf(data):
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        raise ValueError("Encrypted PDFs cannot be edited by this workflow.")
    pdf = pdfium.PdfDocument(data)
    try:
        if not 1 <= len(pdf) <= MAX_PAGES:
            raise ValueError(f"PDF editing supports 1–{MAX_PAGES} pages.")
        if pdfium.raw.FPDF_GetSignatureCount(pdf):
            raise ValueError("Signed PDFs cannot be edited. Request an unsigned source.")
        if pdf.get_formtype() in (pdfium.raw.FORMTYPE_XFA_FULL, pdfium.raw.FORMTYPE_XFA_FOREGROUND):
            raise ValueError("XFA PDFs need an editable source document.")
        pdf.init_forms()
        return pdf
    except Exception:
        pdf.close()
        raise


def fill_color(obj):
    rgba = [ctypes.c_uint() for _ in range(4)]
    if not pdfium.raw.FPDFPageObj_GetFillColor(obj, *rgba):
        raise ValueError("Cannot determine the PDF text color.")
    return tuple(value.value for value in rgba)


def text_runs(page):
    """IDs are page object indices, tied to the exact source hash, never guessed text matches."""
    if pdfium.raw.FPDFPage_CountObjects(page) > MAX_OBJECTS:
        raise ValueError("PDF page exceeds the editing object limit.")
    runs = []
    with closing(page.get_textpage()) as textpage:
        for index, obj in enumerate(page.get_objects(max_depth=0, textpage=textpage)):
            if obj.type != pdfium.raw.FPDF_PAGEOBJ_TEXT:
                continue
            value = obj.extract()
            matrix = obj.get_matrix()
            font = obj.get_font()
            bounds = obj.get_bounds()
            size = obj.get_font_size()
            reason = None
            clip = pdfium.raw.FPDFPageObj_GetClipPath(obj)
            if page.get_rotation() or abs(matrix.b) > 0.001 or abs(matrix.c) > 0.001:
                reason = "Rotated or skewed text needs an editable source."
            elif matrix.a <= 0 or matrix.d <= 0:
                reason = "Reflected text is unsupported."
            elif not all(math.isfinite(v) for v in (*bounds, size, matrix.a, matrix.d, matrix.e, matrix.f)):
                reason = "Invalid text geometry."
            elif size <= 0 or not value.strip():
                reason = "No visible text to edit."
            elif pdfium.raw.FPDFTextObj_GetTextRenderMode(obj) != pdfium.raw.FPDF_TEXTRENDERMODE_FILL:
                reason = "Outlined, clipped, or invisible text is unsupported."
            elif clip and pdfium.raw.FPDFClipPath_CountPaths(clip) > 0:
                reason = "Clipped text needs an editable source."
            color = fill_color(obj)
            if color[3] == 0:
                reason = "Invisible text is unsupported."
            runs.append(
                {
                    "object": index,
                    "text": value,
                    "bounds": bounds,
                    "font": font.get_base_name(),
                    "font_size": size,
                    "color": color,
                    "unsupported_reason": reason,
                    "handle": obj,
                    "matrix": matrix,
                    "font_pointer": ctypes.cast(font.raw, ctypes.c_void_p).value,
                }
            )
    if sum(len(run["text"]) for run in runs) > 200_000:
        raise ValueError("PDF page exceeds the editing text limit.")
    return runs


def inspect(data, selected_pages=None):
    pages = []
    with closing(open_pdf(data)) as pdf:
        numbers = selected_pages if selected_pages is not None else list(range(1, len(pdf) + 1))
        if not 1 <= len(numbers) <= 20 or len(set(numbers)) != len(numbers):
            raise ValueError("Inspect 1–20 unique pages; use --pages to select a subset.")
        for number in numbers:
            if not isinstance(number, int) or not 1 <= number <= len(pdf):
                raise ValueError("Inspection page is outside the PDF.")
            with closing(pdf[number - 1]) as page:
                runs = text_runs(page)
                pages.append(
                    {
                        "page": number,
                        "size": page.get_size(),
                        "runs": [
                            {
                                key: value
                                for key, value in run.items()
                                if key not in ("handle", "matrix", "font_pointer")
                            }
                            for run in runs
                        ],
                        "note": "Only top-level text objects are editable; scanned and nested artwork is retained.",
                    }
                )
        return {"source_sha256": hashlib.sha256(data).hexdigest(), "page_count": len(pdf), "pages": pages}


def validate_plan(plan, data, page_count):
    if not isinstance(plan, dict) or set(plan) != {"source_sha256", "edits"}:
        raise ValueError("PDF edit plan requires only source_sha256 and edits.")
    if plan["source_sha256"] != hashlib.sha256(data).hexdigest():
        raise ValueError("PDF source changed since inspection. Inspect the current file before editing.")
    edits = plan["edits"]
    if not isinstance(edits, list) or not 1 <= len(edits) <= 50:
        raise ValueError("PDF edit plan must contain 1–50 edits.")
    seen = set()
    total = 0
    for edit in edits:
        if not isinstance(edit, dict) or set(edit) != {"page", "objects", "old", "new"}:
            raise ValueError("Each PDF edit requires only page, objects, old, and new.")
        page = edit["page"]
        ids = edit["objects"]
        if type(page) is not int or not 1 <= page <= page_count:
            raise ValueError("Edit page is outside the PDF.")
        if (
            not isinstance(ids, list)
            or not 1 <= len(ids) <= 100
            or any(type(index) is not int or index < 0 for index in ids)
            or ids != sorted(set(ids))
        ):
            raise ValueError("objects must be 1–100 unique object IDs in source order.")
        for index in ids:
            if (page, index) in seen:
                raise ValueError("PDF edits must not overlap; combine changes to the same objects.")
            seen.add((page, index))
        for key in ("old", "new"):
            value = edit[key]
            if (
                not isinstance(value, str)
                or not value.strip()
                or len(value) > 12_000
                or any((ord(c) < 32 and c != "\n") or 0xD800 <= ord(c) <= 0xDFFF for c in value)
            ):
                raise ValueError(
                    "PDF edit text must be 1–12,000 characters without tabs or control characters."
                )
            total += len(value)
        if edit["new"] == edit["old"]:
            raise ValueError("A PDF replacement must change the text.")
        if "\n" in edit["new"]:
            raise ValueError(
                "Each replacement must be one paragraph; wrapping uses the original line positions."
            )
        for character in edit["new"]:
            name = unicodedata.name(character, "")
            if (
                unicodedata.bidirectional(character) in ("R", "AL", "AN")
                or unicodedata.category(character).startswith("M")
                or (
                    character.isalpha()
                    and not name.startswith(
                        ("LATIN", "GREEK", "CYRILLIC", "CJK", "HIRAGANA", "KATAKANA", "HANGUL")
                    )
                )
            ):
                raise ValueError("This replacement requires text shaping. Use the editable source document.")
    if total > 200_000:
        raise ValueError("PDF edit plan exceeds the text limit.")
    return edits


def set_text(obj, value):
    encoded = ctypes.create_string_buffer(value.encode("utf-16-le") + b"\0\0")
    if not pdfium.raw.FPDFText_SetText(obj, ctypes.cast(encoded, pdfium.raw.FPDF_WIDESTRING)):
        raise ValueError("PDFium could not replace the text using its original font.")


def style(run):
    matrix = run["matrix"]
    return run["font_pointer"], run["font_size"], run["color"], matrix.a, matrix.d


def layout_lines(selected):
    """Keep original baselines, indentation, and font; only flow inside the selected text's width."""
    lines = []
    for run in selected:
        if run["unsupported_reason"]:
            raise ValueError(run["unsupported_reason"])
        if style(run) != style(selected[0]):
            raise ValueError("Select text with one font, size, and color; edit mixed styles separately.")
        matrix = run["matrix"]
        if lines and abs(matrix.f - lines[-1][0]["matrix"].f) < 0.2:
            if matrix.e <= lines[-1][-1]["matrix"].e:
                raise ValueError("Text objects are not ordered left to right.")
            lines[-1].append(run)
        else:
            if lines:
                previous = lines[-1][0]["matrix"]
                gap = previous.f - matrix.f
                size = run["font_size"] * matrix.d
                if abs(matrix.e - lines[0][0]["matrix"].e) > 2 or not size * 0.8 <= gap <= size * 2.5:
                    raise ValueError("Select consecutive lines in one paragraph or edit lines separately.")
            lines.append([run])
    return lines


def wrap_text(value, lines, right):
    words = value.split()
    cursor = 0
    replacements = []
    for line in lines:
        run = line[0]
        chosen = ""
        while cursor < len(words):
            candidate = f"{chosen} {words[cursor]}" if chosen else words[cursor]
            set_text(run["handle"], candidate)
            bounds = run["handle"].get_bounds()
            if bounds[2] > right + 0.1 or bounds[0] < run["matrix"].e - 1:
                break
            chosen = candidate
            cursor += 1
        if not chosen:
            if cursor < len(words):
                raise ValueError(
                    "Replacement text does not fit at the original font size. Shorten it or use the editable source."
                )
            replacements.append("")
        else:
            set_text(run["handle"], chosen)
            replacements.append(chosen)
    if cursor < len(words):
        raise ValueError(
            "Replacement text exceeds the original paragraph space. Shorten it or use the editable source."
        )
    return replacements


def intersects(a, b):
    return min(a[2], b[2]) - max(a[0], b[0]) > 0.1 and min(a[3], b[3]) - max(a[1], b[1]) > 0.1


def apply_edit(page, runs, edit):
    selected = [run for run in runs if run["object"] in edit["objects"]]
    if len(selected) != len(edit["objects"]):
        raise ValueError("A selected object is not editable page text. Inspect the PDF again.")
    if "\n".join(run["text"] for run in selected) != edit["old"]:
        raise ValueError(
            "Original text does not match the selected objects. Copy it exactly from inspection."
        )
    start, end = runs.index(selected[0]), runs.index(selected[-1])
    if runs[start : end + 1] != selected:
        raise ValueError("Select consecutive text objects; do not skip intervening content.")
    lines = layout_lines(selected)
    right = max(run["bounds"][2] for run in selected)
    replacements = wrap_text(edit["new"], lines, right)
    regions = [run["bounds"] for run in selected]
    changed_bounds = [line[0]["handle"].get_bounds() for line, value in zip(lines, replacements) if value]
    page_box = page.get_bbox()
    for index, bounds in enumerate(changed_bounds):
        if (
            bounds[0] < page_box[0]
            or bounds[1] < page_box[1]
            or bounds[2] > page_box[2]
            or bounds[3] > page_box[3]
        ):
            raise ValueError("Replacement text would be clipped by the page boundary.")
        if any(intersects(bounds, other) for other in changed_bounds[index + 1 :]):
            raise ValueError("Replacement lines would overlap at the original line spacing.")
    for line, value in zip(lines, replacements):
        if value:
            changed = line[0]["handle"].get_bounds()
            if any(
                intersects(changed, run["bounds"])
                for run in runs
                if run not in selected and not run.get("removed")
            ):
                raise ValueError(
                    "Replacement text would overlap neighboring text. Shorten it or use the editable source."
                )
            regions.append(changed)
            line[0]["bounds"] = changed
        for run in line[1:] if value else line:
            page.remove_obj(run["handle"])
            run["handle"].close()
            run["removed"] = True
    # Read the changed objects with a fresh text page: fonts must encode every requested character.
    with closing(page.get_textpage()) as textpage:
        for line, expected in zip(lines, replacements):
            if expected:
                line[0]["handle"].textpage = textpage
                if line[0]["handle"].extract() != expected:
                    raise ValueError(
                        "The original PDF font cannot encode this replacement. Use the editable source or different wording."
                    )
    return regions, replacements


def page_text(page):
    with closing(page.get_textpage()) as textpage:
        return textpage.get_text_range()


def text_state(page):
    return [
        (
            run["text"],
            run["font"],
            round(run["font_size"], 4),
            run["color"],
            tuple(round(getattr(run["matrix"], key), 4) for key in "abcdef"),
        )
        for run in text_runs(page)
    ]


def compare_pages(original, edited, regions):
    from PIL import ImageChops, ImageDraw

    pixels = 0
    for index in range(len(original)):
        with closing(original[index]) as before, closing(edited[index]) as after:
            if before.get_size() != after.get_size() or before.get_rotation() != after.get_rotation():
                raise ValueError("Verification failed: PDF page geometry changed.")
            width, height = before.get_size()
            count = width * height * RENDER_SCALE**2
            pixels += count
            if not math.isfinite(count) or count <= 0 or count > 20_000_000 or pixels > 100_000_000:
                raise ValueError("PDF exceeds the bounded visual comparison size.")
            with (
                closing(before.render(scale=RENDER_SCALE)) as a,
                closing(after.render(scale=RENDER_SCALE)) as b,
            ):
                with a.to_pil().convert("RGB") as image_a, b.to_pil().convert("RGB") as image_b:
                    if image_a.size != image_b.size:
                        raise ValueError("Verification failed: rendered page dimensions changed.")
                    with ImageChops.difference(image_a, image_b) as difference:
                        draw = ImageDraw.Draw(difference)
                        converter = a.get_posconv(before)
                        for left, bottom, right, top in regions.get(index, []):
                            points = [
                                converter.to_bitmap(left - 1, bottom - 1),
                                converter.to_bitmap(right + 1, top + 1),
                            ]
                            x, y = zip(*points)
                            draw.rectangle((min(x), min(y), max(x), max(y)), fill=(0, 0, 0))
                        if difference.getbbox() is not None:
                            raise ValueError(
                                f"Verification failed: page {index + 1} changed outside the edited text."
                            )


def edit(data, plan):
    with closing(open_pdf(data)) as pdf:
        edits = validate_plan(plan, data, len(pdf))
        regions = {}
        expected_pages = {}
        expected_styles = {}
        expected_lines = {}
        for index in sorted({item["page"] - 1 for item in edits}):
            with closing(pdf[index]) as page:
                runs = text_runs(page)
                for item in (item for item in edits if item["page"] == index + 1):
                    changed, values = apply_edit(page, runs, item)
                    regions.setdefault(index, []).extend(changed)
                    expected_lines.setdefault(index, []).extend(value for value in values if value)
                page.gen_content()
                expected_pages[index] = page_text(page)
                expected_styles[index] = text_state(page)
        stream = io.BytesIO()
        pdf.save(stream, flags=pdfium.raw.FPDF_NO_INCREMENTAL)
        result = stream.getvalue()
    with closing(open_pdf(data)) as original, closing(open_pdf(result)) as reopened:
        if len(original) != len(reopened):
            raise ValueError("Verification failed: PDF page count changed.")
        reader = PdfReader(io.BytesIO(result), strict=True)
        for index in range(len(reopened)):
            with closing(reopened[index]) as page, closing(original[index]) as source:
                expected = expected_pages.get(index, page_text(source))
                if page_text(page) != expected:
                    raise ValueError("Verification failed: saved PDF text changed unexpectedly.")
                if index in expected_styles and text_state(page) != expected_styles[index]:
                    raise ValueError(
                        "Verification failed: saved PDF fonts, styling, or text positions changed."
                    )
            extracted = "".join((reader.pages[index].extract_text() or "").split())
            for value in expected_lines.get(index, []):
                if "".join(value.split()) not in extracted:
                    raise ValueError(
                        "Verification failed: replacement text is not readable in the saved PDF."
                    )
        compare_pages(original, reopened, regions)
        return result, {
            "pages": len(reopened),
            "edits": len(edits),
            "verified": [
                "source_sha256",
                "original_font",
                "text_fit",
                "reopened_text",
                "page_count",
                "unchanged_pixels_outside_edits",
            ],
            "comparison_dpi": int(72 * RENDER_SCALE),
            "visual_review": "automated_pixel_comparison",
        }
