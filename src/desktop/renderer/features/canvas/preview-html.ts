export function wordPreviewDocument(fragment: string, title: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:"><title>${escapeHtml(title)}</title><style>${DOCUMENT_CSS}</style></head><body><main>${fragment}</main></body></html>`
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

const DOCUMENT_CSS = `
  :root { color-scheme: light; font: 16px/1.6 ui-serif, Georgia, serif; color: #242321; background: #e9e7e2; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 48px; }
  main { width: min(720px, 100%); min-height: calc(100vh - 48px); margin: 0 auto; padding: 48px clamp(28px, 7vw, 72px); background: #fff; box-shadow: 0 4px 24px #0002; overflow-wrap: anywhere; }
  img, svg, video, canvas, table { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  h1, h2, h3 { line-height: 1.2; letter-spacing: -.02em; }
  h1 { margin-bottom: .4em; font-size: 2.2em; }
  h2 { margin-top: 1.8em; padding-bottom: .25em; border-bottom: 1px solid #ddd9d0; font-size: 1.35em; }
  table { width: 100%; border-collapse: collapse; font-size: .88em; }
  th, td { padding: 9px 10px; border: 1px solid #ddd9d0; text-align: left; vertical-align: top; }
  th { background: #f4f2ed; font-family: ui-sans-serif, system-ui, sans-serif; font-size: .82em; letter-spacing: .04em; text-transform: uppercase; }
  li + li { margin-top: .35em; }
  p:first-child, h1:first-child, h2:first-child { margin-top: 0; }
  @media (max-width: 520px) { body { padding: 0; } main { min-height: 100vh; padding: 28px 22px; box-shadow: none; } }
`
