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
PRIVATE_KEYS = ("handle", "matrix", "font_pointer")


def open_pdf(data):
    if PdfReader(io.BytesIO(data), strict=True).is_encrypted:
        raise ValueError("Encrypted PDFs cannot be edited by this workflow.")
    pdf = pdfium.PdfDocument(data)
    if not 1 <= len(pdf) <= MAX_PAGES:
        raise ValueError(f"PDF editing supports 1–{MAX_PAGES} pages.")
    if pdfium.raw.FPDF_GetSignatureCount(pdf):
        raise ValueError("Signed PDFs cannot be edited. Request an unsigned source.")
    if pdf.get_formtype() in (pdfium.raw.FORMTYPE_XFA_FULL, pdfium.raw.FORMTYPE_XFA_FOREGROUND):
        raise ValueError("XFA PDFs need an editable source document.")
    pdf.init_forms()
    return pdf


def text_runs(page):
    """IDs are page object indices, tied to the exact source hash, never guessed text matches."""
    if pdfium.raw.FPDFPage_CountObjects(page) > MAX_OBJECTS:
        raise ValueError("PDF page exceeds the editing object limit.")
    runs = []
    with closing(page.get_textpage()) as textpage:
        for index, obj in enumerate(page.get_objects(max_depth=0, textpage=textpage)):
            if obj.type != pdfium.raw.FPDF_PAGEOBJ_TEXT:
                continue
            value, matrix, font = obj.extract(), obj.get_matrix(), obj.get_font()
            bounds, size = obj.get_bounds(), obj.get_font_size()
            clip = pdfium.raw.FPDFPageObj_GetClipPath(obj)
            rgba = [ctypes.c_uint() for _ in range(4)]
            if not pdfium.raw.FPDFPageObj_GetFillColor(obj, *rgba):
                raise ValueError("Cannot determine the PDF text color.")
            color = tuple(channel.value for channel in rgba)
            reason = None
            if color[3] == 0:
                reason = "Invisible text is unsupported."
            elif page.get_rotation() or abs(matrix.b) > 0.001 or abs(matrix.c) > 0.001:
                reason = "Rotated or skewed text needs an editable source."
            elif matrix.a <= 0 or matrix.d <= 0:
                reason = "Reflected text is unsupported."
            elif not all(
                math.isfinite(v) for v in (*bounds, size, matrix.a, matrix.d, matrix.e, matrix.f)
            ):
                reason = "Invalid text geometry."
            elif size <= 0 or not value.strip():
                reason = "No visible text to edit."
            elif (
                pdfium.raw.FPDFTextObj_GetTextRenderMode(obj) != pdfium.raw.FPDF_TEXTRENDERMODE_FILL
            ):
                reason = "Outlined, clipped, or invisible text is unsupported."
            elif clip and pdfium.raw.FPDFClipPath_CountPaths(clip) > 0:
                reason = "Clipped text needs an editable source."
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
    with open_pdf(data) as pdf:
        numbers = selected_pages if selected_pages is not None else list(range(1, len(pdf) + 1))
        if not 1 <= len(numbers) <= 20 or len(set(numbers)) != len(numbers):
            raise ValueError("Inspect 1–20 unique pages; use --pages to select a subset.")
        for number in numbers:
            if not isinstance(number, int) or not 1 <= number <= len(pdf):
                raise ValueError("Inspection page is outside the PDF.")
            with closing(pdf[number - 1]) as page:
                pages.append(
                    {
                        "page": number,
                        "size": page.get_size(),
                        "runs": [
                            {key: value for key, value in run.items() if key not in PRIVATE_KEYS}
                            for run in text_runs(page)
                        ],
                        "note": "Only top-level text objects are editable; scanned and nested artwork is retained.",
                    }
                )
        return {
            "source_sha256": hashlib.sha256(data).hexdigest(),
            "page_count": len(pdf),
            "pages": pages,
        }


def validate_plan(plan, data, page_count):
    if not isinstance(plan, dict) or set(plan) != {"source_sha256", "edits"}:
        raise ValueError("PDF edit plan requires only source_sha256 and edits.")
    if plan["source_sha256"] != hashlib.sha256(data).hexdigest():
        raise ValueError(
            "PDF source changed since inspection. Inspect the current file before editing."
        )
    edits = plan["edits"]
    if not isinstance(edits, list) or not 1 <= len(edits) <= 50:
        raise ValueError("PDF edit plan must contain 1–50 edits.")
    scripts = ("LATIN", "GREEK", "CYRILLIC", "CJK", "HIRAGANA", "KATAKANA", "HANGUL")
    seen = set()
    total = 0
    for edit in edits:
        if not isinstance(edit, dict) or set(edit) != {"page", "objects", "old", "new"}:
            raise ValueError("Each PDF edit requires only page, objects, old, and new.")
        page, ids = edit["page"], edit["objects"]
        if type(page) is not int or not 1 <= page <= page_count:
            raise ValueError("Edit page is outside the PDF.")
        if (
            not isinstance(ids, list)
            or not 1 <= len(ids) <= 100
            or any(type(index) is not int or index < 0 for index in ids)
            or ids != sorted(set(ids))
        ):
            raise ValueError("objects must be 1–100 unique object IDs in source order.")
        if not seen.isdisjoint((page, index) for index in ids):
            raise ValueError("PDF edits must not overlap; combine changes to the same objects.")
        seen.update((page, index) for index in ids)
        for value in (edit["old"], edit["new"]):
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
        if any(
            unicodedata.bidirectional(c) in ("R", "AL", "AN")
            or unicodedata.category(c).startswith("M")
            or (c.isalpha() and not unicodedata.name(c, "").startswith(scripts))
            for c in edit["new"]
        ):
            raise ValueError(
                "This replacement requires text shaping. Use the editable source document."
            )
    if total > 200_000:
        raise ValueError("PDF edit plan exceeds the text limit.")
    return edits


def set_text(obj, value):
    encoded = ctypes.create_string_buffer(value.encode("utf-16-le") + b"\0\0")
    if not pdfium.raw.FPDFText_SetText(obj, ctypes.cast(encoded, pdfium.raw.FPDF_WIDESTRING)):
        raise ValueError("PDFium could not replace the text using its original font.")


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
    start = runs.index(selected[0])
    if runs[start : start + len(selected)] != selected:
        raise ValueError("Select consecutive text objects; do not skip intervening content.")
    for run in selected:
        if run["unsupported_reason"]:
            raise ValueError(run["unsupported_reason"])
    styles = {
        (run["font_pointer"], run["font_size"], run["color"], run["matrix"].a, run["matrix"].d)
        for run in selected
    }
    if len(styles) > 1:
        raise ValueError(
            "Select text with one font, size, and color; edit mixed styles separately."
        )
    # Keep original baselines, indentation, and font; only flow inside the selected text's width.
    lines = [[selected[0]]]
    for run in selected[1:]:
        matrix, previous = run["matrix"], lines[-1][0]["matrix"]
        if abs(matrix.f - previous.f) < 0.2:
            if matrix.e <= lines[-1][-1]["matrix"].e:
                raise ValueError("Text objects are not ordered left to right.")
            lines[-1].append(run)
            continue
        gap = previous.f - matrix.f
        size = run["font_size"] * matrix.d
        if abs(matrix.e - lines[0][0]["matrix"].e) > 2 or not size * 0.8 <= gap <= size * 2.5:
            raise ValueError("Select consecutive lines in one paragraph or edit lines separately.")
        lines.append([run])
    right = max(run["bounds"][2] for run in selected)
    words = edit["new"].split()
    cursor = 0
    replacements = []
    for line in lines:
        handle, left = line[0]["handle"], line[0]["matrix"].e
        chosen = ""
        while cursor < len(words):
            candidate = f"{chosen} {words[cursor]}" if chosen else words[cursor]
            set_text(handle, candidate)
            bounds = handle.get_bounds()
            if bounds[2] > right + 0.1 or bounds[0] < left - 1:
                break
            chosen = candidate
            cursor += 1
        if chosen:
            set_text(handle, chosen)
        elif cursor < len(words):
            raise ValueError(
                "Replacement text does not fit at the original font size. Shorten it or use the editable source."
            )
        replacements.append(chosen)
    if cursor < len(words):
        raise ValueError(
            "Replacement text exceeds the original paragraph space. Shorten it or use the editable source."
        )
    page_box = page.get_bbox()
    changed = [line[0]["handle"].get_bounds() for line, value in zip(lines, replacements) if value]
    for index, bounds in enumerate(changed):
        if (
            bounds[0] < page_box[0]
            or bounds[1] < page_box[1]
            or bounds[2] > page_box[2]
            or bounds[3] > page_box[3]
        ):
            raise ValueError("Replacement text would be clipped by the page boundary.")
        if any(intersects(bounds, other) for other in changed[index + 1 :]):
            raise ValueError("Replacement lines would overlap at the original line spacing.")
    others = [run["bounds"] for run in runs if run not in selected and not run.get("removed")]
    if any(intersects(bounds, other) for bounds in changed for other in others):
        raise ValueError(
            "Replacement text would overlap neighboring text. Shorten it or use the editable source."
        )
    regions = [run["bounds"] for run in selected] + changed
    for line, value in zip(lines, replacements):
        if value:
            line[0]["bounds"] = line[0]["handle"].get_bounds()
        for run in line[1:] if value else line:
            page.remove_obj(run["handle"])
            run["handle"].close()
            run["removed"] = True
    # Read the changed objects with a fresh text page: fonts must encode every requested character.
    with closing(page.get_textpage()) as textpage:
        for line, expected in zip(lines, replacements):
            if not expected:
                continue
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


def edit(data, plan):
    from PIL import ImageChops, ImageDraw

    with open_pdf(data) as pdf:
        edits = validate_plan(plan, data, len(pdf))
        edited = {}
        for index in sorted({item["page"] - 1 for item in edits}):
            with closing(pdf[index]) as page:
                runs = text_runs(page)
                regions, lines = [], []
                for item in edits:
                    if item["page"] == index + 1:
                        changed, values = apply_edit(page, runs, item)
                        regions.extend(changed)
                        lines.extend(value for value in values if value)
                page.gen_content()
                edited[index] = (regions, lines, page_text(page), text_state(page))
        stream = io.BytesIO()
        pdf.save(stream, flags=pdfium.raw.FPDF_NO_INCREMENTAL)
        result = stream.getvalue()
    with open_pdf(data) as original, open_pdf(result) as reopened:
        if len(original) != len(reopened):
            raise ValueError("Verification failed: PDF page count changed.")
        reader = PdfReader(io.BytesIO(result), strict=True)
        pixels = 0
        for index in range(len(reopened)):
            regions, lines, text, styles = edited.get(index, ([], [], None, None))
            with closing(original[index]) as before, closing(reopened[index]) as after:
                if page_text(after) != (text if text is not None else page_text(before)):
                    raise ValueError("Verification failed: saved PDF text changed unexpectedly.")
                if styles is not None and text_state(after) != styles:
                    raise ValueError(
                        "Verification failed: saved PDF fonts, styling, or text positions changed."
                    )
                extracted = "".join((reader.pages[index].extract_text() or "").split())
                if any("".join(value.split()) not in extracted for value in lines):
                    raise ValueError(
                        "Verification failed: replacement text is not readable in the saved PDF."
                    )
                size = before.get_size()
                if size != after.get_size() or before.get_rotation() != after.get_rotation():
                    raise ValueError("Verification failed: PDF page geometry changed.")
                count = size[0] * size[1] * RENDER_SCALE**2
                pixels += count
                if not 0 < count <= 20_000_000 or pixels > 100_000_000:
                    raise ValueError("PDF exceeds the bounded visual comparison size.")
                with (
                    closing(before.render(scale=RENDER_SCALE)) as a,
                    closing(after.render(scale=RENDER_SCALE)) as b,
                ):
                    image_a, image_b = a.to_pil().convert("RGB"), b.to_pil().convert("RGB")
                    if image_a.size != image_b.size:
                        raise ValueError("Verification failed: rendered page dimensions changed.")
                    difference = ImageChops.difference(image_a, image_b)
                    draw = ImageDraw.Draw(difference)
                    converter = a.get_posconv(before)
                    for left, bottom, right, top in regions:
                        p = converter.to_bitmap(left - 1, bottom - 1)
                        q = converter.to_bitmap(right + 1, top + 1)
                        draw.rectangle((*map(min, p, q), *map(max, p, q)), fill=(0, 0, 0))
                    if difference.getbbox() is not None:
                        raise ValueError(
                            f"Verification failed: page {index + 1} changed outside the edited text."
                        )
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
