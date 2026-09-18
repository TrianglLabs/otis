import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { createDocumentAttachment } from "../../../src/inference/documents.js"

async function main() {
  const path = process.argv[2]
  const document = await createDocumentAttachment(await readFile(path), basename(path))
  process.stdout.write(JSON.stringify({ text: document.extractedText, pages: document.pageCount }))
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
