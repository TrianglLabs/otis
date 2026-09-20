"""Behavior tests for the bundled helper; run with its requirements installed."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from xml.etree import ElementTree

SCRIPT = Path(__file__).resolve().parents[2] / "src/skills/bundled/documents/document.py"
module_spec = importlib.util.spec_from_file_location("otis_documents", SCRIPT)
helper = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(helper)


class DocumentWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="otis-document-test-")
        self.root = Path(self.directory.name).resolve()
        self.previous = Path.cwd()
        os.chdir(self.root)
        self.spec = {
            "title": "Adapted resume",
            "page_size": "letter",
            "font_size": 10.5,
            "blocks": [
                {"type": "heading", "level": 0, "text": "José Müller"},
                {"type": "paragraph", "text": "Engineer — Example Company, 2022–2025"},
                {"type": "heading", "text": "Experience"},
                {
                    "type": "bullets",
                    "items": ["Built reliable TypeScript services", "Improved deployment tooling"],
                },
                {"type": "table", "rows": [["Skill", "Experience"], ["TypeScript", "3 years"]]},
                {"type": "paragraph", "text": "Literal <b>text</b> & punctuation"},
            ],
        }

    def tearDown(self):
        os.chdir(self.previous)
        self.directory.cleanup()

    def run_helper(self, *arguments, success=True):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *arguments],
            cwd=self.root,
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        value = json.loads(result.stdout if success else result.stderr)
        self.assertEqual(value["ok"], success)
        return value

    def write_spec(self):
        (self.root / "spec.json").write_text(json.dumps(self.spec), encoding="utf-8")

    def create(self, extension="pdf", success=True):
        self.write_spec()
        return self.run_helper(
            "create", "--spec", "spec.json", "--output", "resume." + extension, success=success
        )

    def test_creates_real_pdf_with_unicode_and_literal_markup(self):
        from pypdf import PdfReader

        result = self.create()
        pdf = PdfReader(self.root / "resume.pdf")
        content = "".join(page.extract_text() for page in pdf.pages)
        self.assertEqual(result["pages"], 1)
        self.assertIn("José Müller", content)
        self.assertIn("Literal <b>text</b> & punctuation", content)
        self.assertIn("Improved deployment tooling", content)
        self.assertEqual(result["visual_review"], "not_performed")
        if os.name != "nt":
            self.assertEqual((self.root / "resume.pdf").stat().st_mode & 0o777, 0o600)

    def test_creates_structured_word_document(self):
        result = self.create("docx")
        with zipfile.ZipFile(self.root / "resume.docx") as archive:
            xml = ElementTree.fromstring(archive.read("word/document.xml"))
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        self.assertEqual(len(xml.findall(".//w:tbl", ns)), 1)
        self.assertTrue(xml.findall(".//w:pStyle[@w:val='ListBullet']", ns))
        values = [item.text for item in xml.findall(".//w:t", ns)]
        self.assertIn("José Müller", values)
        self.assertIn("Literal <b>text</b> & punctuation", values)
        self.assertIsNone(result["pages"])

    def test_page_limit_fails_without_publishing_or_dropping_text(self):
        self.spec["max_pages"] = 1
        self.spec["blocks"] = [{"type": "paragraph", "text": "A verified achievement. " * 40}] * 20
        result = self.create(success=False)
        self.assertIn("allowed maximum", result["error"])
        self.assertFalse((self.root / "resume.pdf").exists())
        self.assertEqual(list(self.root.glob(".otis-document-*")), [])

    def test_rejects_invalid_specs_instead_of_silent_fallbacks(self):
        for change in [
            {"page_size": "poster"},
            {"font_size": True},
            {"unrecognized": 1},
            {"blocks": [{"type": "paragraph", "text": "bad\x00text"}]},
            {"blocks": [{"type": "page_break"}]},
        ]:
            with self.subTest(change=change):
                original = dict(self.spec)
                self.spec.update(change)
                self.create(success=False)
                self.assertFalse((self.root / "resume.pdf").exists())
                self.spec = original
        self.spec["max_pages"] = 1
        self.assertIn("PDF-only", self.create("docx", success=False)["error"])

    def test_missing_font_and_complex_script_are_explicit_failures(self):
        self.spec["font_path"] = str(self.root / "missing.ttf")
        self.assertIn("font", self.create(success=False)["error"])
        del self.spec["font_path"]
        self.spec["blocks"] = [{"type": "paragraph", "text": "مرحبا"}]
        self.assertIn("right-to-left", self.create(success=False)["error"])
        self.assertFalse((self.root / "resume.pdf").exists())

    def test_existing_files_and_workspace_escapes_are_preserved(self):
        source = self.root / "resume.pdf"
        source.write_bytes(b"original")
        self.assertIn("already exists", self.create(success=False)["error"])
        self.assertEqual(source.read_bytes(), b"original")
        with tempfile.TemporaryDirectory() as outside:
            escaped = Path(outside) / "result.pdf"
            self.run_helper("create", "--spec", "spec.json", "--output", str(escaped), success=False)
            self.assertFalse(escaped.exists())
            if os.name != "nt":
                (self.root / "linked").symlink_to(outside, target_is_directory=True)
                self.run_helper(
                    "create", "--spec", "spec.json", "--output", "linked/result.pdf", success=False
                )
                self.assertFalse(escaped.exists())

    def test_check_reports_missing_dependencies_without_installing(self):
        with (
            patch.object(helper.importlib.util, "find_spec", return_value=None),
            patch.object(helper, "office_command", return_value=None),
            patch.object(helper.shutil, "which", return_value=None),
        ):
            result = helper.check()
        self.assertEqual(
            result["missing_packages"], ["python-docx", "reportlab", "pypdf", "pypdfium2", "pillow"]
        )
        self.assertFalse(any(result["capabilities"].values()))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_conversion_reports_missing_office_without_creating_a_pdf(self):
        self.create("docx")
        args = helper.argparse.Namespace(source="resume.docx", output="resume.pdf")
        with patch.object(helper, "office_command", return_value=None):
            with self.assertRaisesRegex(ValueError, "LibreOffice is unavailable"):
                helper.convert(args)
        self.assertFalse((self.root / "resume.pdf").exists())

    def test_conversion_rejects_false_success_from_office(self):
        self.create("docx")
        original = (self.root / "resume.docx").read_bytes()
        args = helper.argparse.Namespace(source="resume.docx", output="resume.pdf")
        with (
            patch.object(helper, "office_command", return_value="soffice"),
            patch.object(helper.subprocess, "run", return_value=None),
        ):
            with self.assertRaisesRegex(ValueError, "did not produce"):
                helper.convert(args)
        self.assertFalse((self.root / "resume.pdf").exists())
        self.assertEqual((self.root / "resume.docx").read_bytes(), original)

    def test_conversion_uses_validated_snapshot_during_concurrent_save(self):
        self.create("docx")
        source = self.root / "resume.docx"
        original = source.read_bytes()
        concurrent = helper.create_docx({"blocks": [{"type": "paragraph", "text": "Other draft"}]})
        read_text = helper.docx_text

        def validate_and_save(data):
            values = read_text(data)
            source.write_bytes(concurrent)
            return values

        def convert_snapshot(command, **kwargs):
            snapshot = Path(command[-1])
            self.assertEqual(snapshot.read_bytes(), original)
            snapshot.with_suffix(".pdf").write_bytes(helper.create_pdf(self.spec, read_text(original)))

        with (
            patch.object(helper, "office_command", return_value="soffice"),
            patch.object(helper, "docx_text", side_effect=validate_and_save),
            patch.object(helper.subprocess, "run", side_effect=convert_snapshot),
        ):
            result = helper.convert(helper.argparse.Namespace(source="resume.docx", output="resume.pdf"))
        self.assertIn("body_and_table_text", result["verified"])
        self.assertTrue((self.root / "resume.pdf").is_file())
        self.assertEqual(source.read_bytes(), concurrent)

    def require_optional(self, present, label):
        if present:
            return
        if os.environ.get("OTIS_TEST_DOCUMENT_RENDERING") == "1":
            self.fail(label + " is required for this integration run")
        self.skipTest(label + " is not installed")

    def test_converts_word_and_preserves_source(self):
        self.require_optional(helper.office_command(), "LibreOffice")
        self.create("docx")
        original = (self.root / "resume.docx").read_bytes()
        result = self.run_helper("convert", "--source", "resume.docx", "--output", "converted.pdf")
        self.assertGreaterEqual(result["pages"], 1)
        self.assertEqual((self.root / "resume.docx").read_bytes(), original)
        self.assertIn("body_and_table_text", result["verified"])

    def test_renders_bounded_pdf_pages_without_claiming_review(self):
        self.create()
        result = self.run_helper("render", "--source", "resume.pdf", "--output-dir", "preview")
        self.assertEqual(result["images"], ["page-1.png"])
        self.assertTrue((self.root / "preview/page-1.png").read_bytes().startswith(b"\x89PNG"))
        self.assertEqual(result["visual_review"], "not_performed")
        self.run_helper("render", "--source", "resume.pdf", "--output-dir", "preview", success=False)


if __name__ == "__main__":
    unittest.main()
