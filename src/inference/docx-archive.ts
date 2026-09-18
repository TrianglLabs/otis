import { fromBufferPromise } from "yauzl"

const MAX_ENTRIES = 10_000
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
const MAX_DOCUMENT_XML_BYTES = 16 * 1024 * 1024

/** Verify every entry with bounded streaming inflation before Mammoth materializes XML. */
export async function validateDocxArchive(bytes: Buffer) {
  const zip = await fromBufferPromise(bytes, { validateEntrySizes: true, strictFileNames: true })
  try {
    if (zip.entryCount === 0 || zip.entryCount > MAX_ENTRIES) throw new Error("invalid DOCX entry count")
    const names = new Set<string>()
    let totalBytes = 0
    for await (const entry of zip.eachEntry()) {
      if (names.has(entry.fileName)) throw new Error("duplicate DOCX archive entry")
      names.add(entry.fileName)
      if (entry.isEncrypted()) throw new Error("encrypted DOCX files are not supported")
      // Mammoth reads local names, whereas yauzl indexes central names. Require an unambiguous package.
      const local = await zip.readLocalFileHeaderPromise(entry)
      if (!local.fileName.equals(entry.fileNameRaw)) throw new Error("inconsistent DOCX entry name")
      if (entry.fileName === "word/document.xml" && entry.uncompressedSize > MAX_DOCUMENT_XML_BYTES) {
        throw new Error("main document XML exceeds the 16 MB safety limit")
      }
      totalBytes += entry.uncompressedSize
      if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("DOCX expands beyond the 100 MB safety limit")

      // yauzl aborts the stream as soon as inflated data exceeds the declared size.
      // Draining (without retaining chunks) verifies compressed entries as well as metadata.
      const stream = await zip.openReadStreamPromise(entry)
      for await (const _chunk of stream) {
        // The verified data is read again by Mammoth after the archive passes validation.
      }
    }
    if (!names.has("[Content_Types].xml") || !names.has("word/document.xml")) {
      throw new Error("not a valid DOCX file")
    }
  } finally {
    zip.close()
  }
}
