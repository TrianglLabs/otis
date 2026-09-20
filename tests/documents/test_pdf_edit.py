"""PDF edits must retain original page artwork and fail before publication when unsafe."""

import copy
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import pypdfium2 as pdfium
import reportlab
from PIL import Image, ImageChops
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    ByteStringObject,
    DictionaryObject,
    NameObject,
    NumberObject,
    TextStringObject,
)
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

ROOT = Path(__file__).resolve().parents[2] / "src/skills/bundled/documents"
module_spec = importlib.util.spec_from_file_location("otis_pdf_edit", ROOT / "pdf_edit.py")
helper = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(helper)


class PdfEditingTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="otis-pdf-edit-test-")
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def fixture(self, *, embedded=False, split=False, clipped=False, mixed=False):
        output = io.BytesIO()
        canvas = Canvas(output, pagesize=(612, 792))
        canvas.setFillColorRGB(0.08, 0.16, 0.3)
        canvas.rect(0, 0, 24, 792, fill=1, stroke=0)
        canvas.setFillColorRGB(0, 0, 0)
        canvas.setFont("Helvetica-Bold", 22)
        canvas.drawString(40, 750, "Alex Morgan")
        canvas.beginForm("logo", 0, 0, 80, 20)
        canvas.setFont("Helvetica", 8)
        canvas.drawString(0, 0, "Original logo")
        canvas.endForm()
        canvas.saveState()
        canvas.translate(480, 750)
        canvas.doForm("logo")
        canvas.restoreState()
        with Image.new("RGB", (16, 16), (190, 30, 20)) as image:
            canvas.drawImage(ImageReader(image), 500, 700, 20, 20)
        font = "Helvetica"
        if embedded:
            pdfmetrics.registerFont(
                TTFont("FixtureVera", str(Path(reportlab.__file__).parent / "fonts/Vera.ttf"))
            )
            font = "FixtureVera"
        canvas.setFont(font, 12)
        canvas.setFillColorRGB(0.1, 0.2, 0.3)
        if clipped:
            clip = canvas.beginPath()
            clip.rect(40, 690, 250, 30)
            canvas.clipPath(clip, stroke=0)
        if split:
            canvas.drawString(40, 700, "Built reliable ")
            canvas.drawString(
                40 + pdfmetrics.stringWidth("Built reliable ", font, 12), 700, "software for customers."
            )
        else:
            canvas.drawString(40, 700, "Built reliable software for customers.")
        if mixed:
            canvas.setFont("Helvetica-Bold", 12)
        canvas.drawString(40, 685, "Led an engineering team.")
        canvas.drawString(40, 630, "Education: Example University")
        canvas.linkURL("https://example.com", (40, 625, 230, 645), relative=0)
        canvas.showPage()
        canvas.setPageRotation(90)
        canvas.drawString(40, 500, "Second page retained.")
        canvas.save()
        return output.getvalue()

    def plan(self, data, *, new="Built dependable software and led a team.", single=False):
        layout = helper.inspect(data)
        runs = [
            run for run in layout["pages"][0]["runs"] if run["text"].startswith(("Built", "software", "Led"))
        ]
        if single:
            runs = runs[:1]
        return {
            "source_sha256": layout["source_sha256"],
            "edits": [
                {
                    "page": 1,
                    "objects": [run["object"] for run in runs],
                    "old": "\n".join(run["text"] for run in runs),
                    "new": new,
                }
            ],
        }

    def command(self, *args, success=True):
        result = subprocess.run(
            [sys.executable, str(ROOT / "document.py"), *args],
            cwd=self.root,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return json.loads(result.stdout if success else result.stderr)

    def test_cli_preserves_original_fonts_artwork_links_and_pages(self):
        for embedded in (False, True):
            with self.subTest(embedded=embedded):
                data = self.fixture(embedded=embedded)
                (self.root / "source.pdf").write_bytes(data)
                inspected = self.command("inspect-pdf", "--source", "source.pdf")
                self.assertEqual(inspected["page_count"], 2)
                plan = self.plan(data)
                (self.root / "edits.json").write_text(json.dumps(plan))
                destination = "edited-embedded.pdf" if embedded else "edited-standard.pdf"
                result = self.command(
                    "edit-pdf", "--source", "source.pdf", "--spec", "edits.json", "--output", destination
                )
                self.assertIn("unchanged_pixels_outside_edits", result["verified"])
                self.assertEqual(result["comparison_dpi"], 144)
                self.assertEqual((self.root / "source.pdf").read_bytes(), data)
                saved = (self.root / destination).read_bytes()
                reader = PdfReader(io.BytesIO(saved))
                self.assertEqual(len(reader.pages), 2)
                self.assertIn("Built dependable", reader.pages[0].extract_text())
                self.assertNotIn("Built reliable", reader.pages[0].extract_text())
                self.assertEqual(
                    reader.pages[0]["/Annots"][0].get_object()["/A"]["/URI"], "https://example.com"
                )
                old_runs = helper.inspect(data)["pages"][0]["runs"]
                new_runs = helper.inspect(saved)["pages"][0]["runs"]
                old = next(run for run in old_runs if run["text"].startswith("Built"))
                new = next(run for run in new_runs if run["text"].startswith("Built"))
                for key in ("font", "font_size", "color"):
                    self.assertEqual(new[key], old[key])
                with (
                    closing(pdfium.PdfDocument(data)) as original,
                    closing(pdfium.PdfDocument(saved)) as edited,
                ):
                    for index in (0, 1):
                        with closing(original[index]) as a, closing(edited[index]) as b:
                            with (
                                closing(a.render(scale=2)) as bitmap_a,
                                closing(b.render(scale=2)) as bitmap_b,
                            ):
                                before, after = (
                                    bitmap_a.to_pil().convert("RGB"),
                                    bitmap_b.to_pil().convert("RGB"),
                                )
                                # Whole untouched page, plus the header/logo and image outside edited lines.
                                if index == 0:
                                    before, after = (
                                        before.crop((0, 0, 1224, 150)),
                                        after.crop((0, 0, 1224, 150)),
                                    )
                                self.assertIsNone(ImageChops.difference(before, after).getbbox())
                self.command(
                    "edit-pdf",
                    "--source",
                    "source.pdf",
                    "--spec",
                    "edits.json",
                    "--output",
                    destination,
                    success=False,
                )
                self.assertEqual((self.root / destination).read_bytes(), saved)

    def test_reflows_split_runs_and_removes_unused_lines_without_covering_old_text(self):
        data = self.fixture(split=True)
        result, _ = helper.edit(data, self.plan(data, new="Built useful software."))
        content = PdfReader(io.BytesIO(result)).pages[0].extract_text()
        self.assertIn("Built useful software.", content)
        self.assertNotIn("Led an engineering team.", content)
        self.assertNotIn("customers", content)
        self.assertIn("Education: Example University", content)
        self.assertLess(
            len(helper.inspect(result)["pages"][0]["runs"]), len(helper.inspect(data)["pages"][0]["runs"])
        )

    def test_multiple_edits_keep_original_object_identity_after_removing_a_line(self):
        data = self.fixture()
        plan = self.plan(data, new="Built software.")
        education = helper.inspect(data)["pages"][0]["runs"][-1]
        plan["edits"].append(
            {
                "page": 1,
                "objects": [education["object"]],
                "old": education["text"],
                "new": "Education: Example College",
            }
        )
        result, report = helper.edit(data, plan)
        self.assertEqual(report["edits"], 2)
        self.assertIn("Example College", PdfReader(io.BytesIO(result)).pages[0].extract_text())

    def test_overflow_missing_glyphs_and_shaping_fail_without_output(self):
        data = self.fixture()
        (self.root / "source.pdf").write_bytes(data)
        for new, reason in [
            ("Lengthy achievement " * 60, "space"),
            ("Built 🔬 tools.", "font"),
            ("Built שלום.", "shaping"),
        ]:
            with self.subTest(reason=reason):
                (self.root / "edits.json").write_text(json.dumps(self.plan(data, new=new)))
                result = self.command(
                    "edit-pdf",
                    "--source",
                    "source.pdf",
                    "--spec",
                    "edits.json",
                    "--output",
                    "edited.pdf",
                    success=False,
                )
                self.assertIn(reason, result["error"])
                self.assertFalse((self.root / "edited.pdf").exists())
                self.assertEqual((self.root / "source.pdf").read_bytes(), data)

    def test_rejects_stale_ambiguous_and_malformed_plans(self):
        data = self.fixture()
        plan = self.plan(data)
        cases = []
        stale = copy.deepcopy(plan)
        stale["source_sha256"] = "0" * 64
        cases.append(stale)
        old = copy.deepcopy(plan)
        old["edits"][0]["old"] = "wrong source text"
        cases.append(old)
        overlap = copy.deepcopy(plan)
        overlap["edits"] *= 2
        cases.append(overlap)
        invalid = copy.deepcopy(plan)
        invalid["edits"][0]["page"] = True
        cases.append(invalid)
        unknown = copy.deepcopy(plan)
        unknown["edits"][0]["font_size"] = 6
        cases.append(unknown)
        skipped = copy.deepcopy(plan)
        skipped["edits"][0]["objects"] = [1, 4]
        cases.append(skipped)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                helper.edit(data, value)

    def test_rejects_mixed_styles_and_clipped_text(self):
        for option, reason in [("mixed", "one font"), ("clipped", "Clipped")]:
            data = self.fixture(**{option: True})
            with self.subTest(option=option), self.assertRaisesRegex(ValueError, reason):
                helper.edit(data, self.plan(data))

    def test_a_failed_second_edit_does_not_publish_a_partly_edited_file(self):
        data = self.fixture()
        (self.root / "source.pdf").write_bytes(data)
        plan = self.plan(data, new="Built useful software.")
        education = helper.inspect(data)["pages"][0]["runs"][-1]
        plan["edits"].append(
            {
                "page": 1,
                "objects": [education["object"]],
                "old": "Wrong original text",
                "new": "Updated education",
            }
        )
        (self.root / "edits.json").write_text(json.dumps(plan))
        result = self.command(
            "edit-pdf",
            "--source",
            "source.pdf",
            "--spec",
            "edits.json",
            "--output",
            "edited.pdf",
            success=False,
        )
        self.assertIn("Original text does not match", result["error"])
        self.assertFalse((self.root / "edited.pdf").exists())
        self.assertEqual((self.root / "source.pdf").read_bytes(), data)

    def test_rejects_replacement_lines_that_overlap_or_cross_the_page_edge(self):
        for edge in (False, True):
            buffer = io.BytesIO()
            canvas = Canvas(buffer, pagesize=(612, 792))
            canvas.setFont("Helvetica", 12)
            canvas.drawString(40, 1 if edge else 700, "MMMM MMMM")
            if not edge:
                canvas.drawString(40, 690, "MMMM MMMM")
            canvas.save()
            data = buffer.getvalue()
            inspected = helper.inspect(data)
            runs = inspected["pages"][0]["runs"]
            plan = {
                "source_sha256": inspected["source_sha256"],
                "edits": [
                    {
                        "page": 1,
                        "objects": [run["object"] for run in runs],
                        "old": "\n".join(run["text"] for run in runs),
                        "new": "AgAgAgAgAg" if edge else "AgAgAgAgAg AgAgAgAgAg",
                    }
                ],
            }
            with (
                self.subTest(edge=edge),
                self.assertRaisesRegex(ValueError, "page boundary" if edge else "lines would overlap"),
            ):
                helper.edit(data, plan)

    def test_visual_comparison_rejects_unrelated_artwork_changes(self):
        data = self.fixture()
        original_edit = helper.apply_edit

        def change_artwork(page, runs, edit):
            result = original_edit(page, runs, edit)
            background = next(page.get_objects(max_depth=0))
            self.assertTrue(pdfium.raw.FPDFPageObj_SetFillColor(background, 255, 0, 0, 255))
            return result

        with patch.object(helper, "apply_edit", side_effect=change_artwork):
            with self.assertRaisesRegex(ValueError, "outside the edited text"):
                helper.edit(data, self.plan(data))

    def test_rejects_encrypted_and_signed_sources(self):
        data = self.fixture()
        writer = PdfWriter(clone_from=io.BytesIO(data))
        writer.encrypt("secret")
        encrypted = io.BytesIO()
        writer.write(encrypted)
        with self.assertRaisesRegex(ValueError, "Encrypted"):
            helper.inspect(encrypted.getvalue())
        writer = PdfWriter(clone_from=io.BytesIO(data))
        signature = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Sig"),
                NameObject("/ByteRange"): ArrayObject([NumberObject(value) for value in [0, 1, 2, 3]]),
                NameObject("/Contents"): ByteStringObject(b"synthetic signature"),
            }
        )
        field = DictionaryObject(
            {
                NameObject("/FT"): NameObject("/Sig"),
                NameObject("/T"): TextStringObject("Signature"),
                NameObject("/V"): writer._add_object(signature),
            }
        )
        writer.root_object[NameObject("/AcroForm")] = DictionaryObject(
            {NameObject("/Fields"): ArrayObject([writer._add_object(field)])}
        )
        signed = io.BytesIO()
        writer.write(signed)
        with self.assertRaisesRegex(ValueError, "Signed"):
            helper.inspect(signed.getvalue())


if __name__ == "__main__":
    unittest.main()
