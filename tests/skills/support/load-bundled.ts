import { buildSystemPrompt } from "../../../src/inference/system-prompt.js"
import { loadSkillCatalog, readSkillResource } from "../../../src/skills/index.js"

async function main() {
  const catalog = await loadSkillCatalog(process.cwd(), { home: process.cwd(), dataDirectory: process.argv[2] })
  const instructions = await readSkillResource(catalog, "documents")
  const script = await readSkillResource(catalog, "documents", "document.py")
  if (!instructions.output.includes("Document deliverables in Otis") || !script.output.includes("def create_pdf")) {
    throw new Error("Document skill resources were not bundled")
  }
  console.log(JSON.stringify({ root: catalog.byName.get("documents")?.root, systemPrompt: buildSystemPrompt() }))
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
