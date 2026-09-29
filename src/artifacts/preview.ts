/** Characters of a document's opening the home screen sets in a thumbnail. */
const PREVIEW_CHARS = 400

/**
 * The opening of a document as text a thumbnail can typeset: markup or Markdown syntax dropped,
 * paragraphs kept as lines.
 */
export function documentExcerpt(format: "html" | "text", text: string) {
  const plain =
    format === "html"
      ? text
          .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
          .replace(/<\/(?:p|h\d|li|tr|div|section|article|blockquote)>|<br\s*\/?>/gi, "\n")
          .replace(/<\/t[dh]>/gi, " ")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
      : text
          .replace(/^\s{0,3}#{1,6}\s+/gm, "")
          .replace(/^\s*(?:[-+>]|\d+\.)\s+/gm, "")
          .replace(/[*_`~]+/g, "")
  return plain
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
    .slice(0, PREVIEW_CHARS)
}
