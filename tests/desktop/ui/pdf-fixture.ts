/** Small text-only PDF with enough pages to exercise windowing in the real renderer. */
export function pdfFixture(pageCount: number) {
  const pageIds = Array.from({ length: pageCount }, (_, index) => index + 5)
  const stream = "BT /F1 12 Tf 72 720 Td (Canvas page) Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ...pageIds.map(
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>",
    ),
  ]
  let source = "%PDF-1.4\n"
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length)
    source += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = source.length
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) source += `${String(offset).padStart(10, "0")} 00000 n \n`
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return btoa(source)
}
