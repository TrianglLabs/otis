import { FileText } from "lucide-react"
import type { ArtifactKind } from "../../../artifacts/types.js"
import { Icon } from "./Icon.js"

export type FileVisualKind = ArtifactKind | "mermaid"

const LABELS: Record<FileVisualKind, string> = {
  markdown: "MD",
  text: "TXT",
  html: "HTML",
  pdf: "PDF",
  docx: "DOCX",
  mermaid: "MMD",
}

export function FileTypeIcon({
  kind = "text",
  name,
  size = "md",
}: {
  kind?: FileVisualKind
  name?: string
  size?: "sm" | "md"
}) {
  const extension = name?.match(/\.([^./\\]+)$/)?.[1]
  return (
    <span className={`fileTypeIcon fileTypeIcon-${size}`} aria-hidden="true">
      <Icon icon={FileText} size={size === "sm" ? 16 : 22} />
      <span>{extension?.toUpperCase() || LABELS[kind]}</span>
    </span>
  )
}
