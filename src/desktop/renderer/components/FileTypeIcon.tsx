import {
  IconBrandCpp,
  IconBrandCSharp,
  IconBrandGolang,
  IconBrandKotlin,
  IconBrandPython,
  IconBrandSvelte,
  IconBrandSwift,
  IconFile,
  IconFileCode,
  IconFileSpreadsheet,
  IconFileTypeCss,
  IconFileTypeCsv,
  IconFileTypeDoc,
  IconFileTypeDocx,
  IconFileTypeHtml,
  IconFileTypeJpg,
  IconFileTypeJs,
  IconFileTypeJsx,
  IconFileTypePdf,
  IconFileTypePhp,
  IconFileTypePng,
  IconFileTypeRs,
  IconFileTypeSql,
  IconFileTypeSvg,
  IconFileTypeTs,
  IconFileTypeTsx,
  IconFileTypeTxt,
  IconFileTypeVue,
  IconFileTypeXml,
  IconFileTypeZip,
  IconJson,
  IconMarkdown,
  IconPhoto,
  IconSettings,
  IconTerminal2,
  type Icon as TablerIcon,
} from "@tabler/icons-react"
import type { ArtifactKind } from "../../../artifacts/types.js"

export type FileVisualKind = ArtifactKind | "mermaid"

const KIND_GLYPHS: Record<FileVisualKind, TablerIcon> = {
  markdown: IconMarkdown,
  text: IconFileTypeTxt,
  html: IconFileTypeHtml,
  pdf: IconFileTypePdf,
  docx: IconFileTypeDocx,
  mermaid: IconFile,
}

/** Tabler's marks by extension; code without a mark of its own gets the generic code file. */
const GLYPHS: [TablerIcon, string][] = [
  [IconFileTypeTs, "ts mts cts"],
  [IconFileTypeTsx, "tsx"],
  [IconFileTypeJs, "js mjs cjs"],
  [IconFileTypeJsx, "jsx"],
  [IconFileTypeCss, "css scss less"],
  [IconFileTypeHtml, "html htm"],
  [IconFileTypeVue, "vue"],
  [IconBrandSvelte, "svelte"],
  [IconBrandPython, "py pyi"],
  [IconFileTypeRs, "rs"],
  [IconBrandGolang, "go"],
  [IconBrandSwift, "swift"],
  [IconBrandKotlin, "kt kts"],
  [IconBrandCpp, "cpp cc cxx hpp hh"],
  [IconBrandCSharp, "cs"],
  [IconFileTypePhp, "php"],
  [IconFileCode, "c h java rb ex exs lua zig dart scala clj hs ml elm"],
  [IconFileTypeSql, "sql"],
  [IconJson, "json jsonc json5"],
  [IconFileTypeXml, "xml plist"],
  [IconSettings, "yaml yml toml ini env conf cfg lock"],
  [IconTerminal2, "sh zsh bash fish ps1 bat"],
  [IconMarkdown, "md mdx markdown"],
  [IconFileTypeTxt, "txt log"],
  [IconFileTypePdf, "pdf"],
  [IconFileTypeDocx, "docx"],
  [IconFileTypeDoc, "doc"],
  [IconFileTypeCsv, "csv tsv"],
  [IconFileSpreadsheet, "xlsx xls"],
  [IconFileTypePng, "png"],
  [IconFileTypeJpg, "jpg jpeg"],
  [IconFileTypeSvg, "svg"],
  [IconPhoto, "gif webp ico bmp avif"],
  [IconFileTypeZip, "zip tar gz tgz bz2 xz 7z rar"],
]

const BY_EXTENSION = new Map(
  GLYPHS.flatMap(([icon, extensions]) => extensions.split(" ").map((ext) => [ext, icon] as const)),
)

/**
 * A file's type at a glance, in the same outline style as the rest of the icons: Tabler's mark
 * for the extension, the kind's mark without one, a plain page for the unknown.
 */
export function FileTypeIcon({
  kind = "text",
  name,
  size = "md",
}: {
  kind?: FileVisualKind
  name?: string
  size?: "xs" | "sm" | "md"
}) {
  const extension = name?.match(/\.([^./\\]+)$/)?.[1]?.toLowerCase()
  const Glyph = extension ? (BY_EXTENSION.get(extension) ?? IconFile) : KIND_GLYPHS[kind]
  return (
    <span className={`fileTypeIcon fileTypeIcon-${size}`} aria-hidden="true">
      <Glyph size={size === "xs" ? 14 : size === "sm" ? 18 : 26} stroke={1.5} />
    </span>
  )
}
