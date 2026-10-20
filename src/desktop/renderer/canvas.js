// This script is inlined into an opaque-origin iframe and cannot import modules.
// The parent replaces these initial English labels with the selected catalog on load.
let labels = {
  viewport: "Diagram canvas. Drag to pan; use the controls to zoom.",
  renderFailed: "Could not render this Mermaid diagram.",
  loadFailed: "The diagram renderer failed to load.",
  emptySource: "The Mermaid block is empty.",
  tooLarge: "This Mermaid diagram is too large to render. The limit is 50,000 characters.",
}
let lastError
const root = requiredElement("diagram")
const errorView = requiredElement("error")
const viewport = requiredElement("viewport")

let scale = 1
let panX = 0
let panY = 0
let drag
let lastSource
// The label size the parent asks for: the document's text inline, the prose size in a tab.
let fontSize
// The viewport width the drawing on screen was laid out for.
let laidOut
// Inline, the diagram sits in a document: no pan or zoom, and the frame reports its height.
let inline = false
// Large, the frame fills a dialog over the window; the parent opens and closes it.
let large = false

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && large)
    parent.postMessage({ type: "otis-canvas-enlarge", open: false }, "*")
})

viewport.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || inline) return
  event.preventDefault()
  viewport.focus()
  viewport.setPointerCapture(event.pointerId)
  viewport.classList.add("dragging")
  drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX, panY }
})
viewport.addEventListener("pointermove", (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return
  panX = drag.panX + event.clientX - drag.x
  panY = drag.panY + event.clientY - drag.y
  applyView()
})
viewport.addEventListener("pointerup", endDrag)
viewport.addEventListener("pointercancel", endDrag)
viewport.addEventListener(
  "wheel",
  (event) => {
    if (inline) return
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) setZoom(scale * Math.exp(-event.deltaY * 0.002))
    else {
      panX -= event.deltaX
      panY -= event.deltaY
      applyView()
    }
  },
  { passive: false },
)
viewport.addEventListener("keydown", (event) => {
  if (inline) return
  const distance = event.shiftKey ? 60 : 24
  if (event.key === "+" || event.key === "=") setZoom(scale * 1.2)
  else if (event.key === "-") setZoom(scale / 1.2)
  else if (event.key === "0") resetView()
  else if (event.key === "ArrowLeft") panX += distance
  else if (event.key === "ArrowRight") panX -= distance
  else if (event.key === "ArrowUp") panY += distance
  else if (event.key === "ArrowDown") panY -= distance
  else return
  event.preventDefault()
  applyView()
})

window.addEventListener("message", (event) => {
  if (event.source !== parent) return
  if (event.data?.type === "otis-canvas-language") {
    const next = event.data.labels
    if (
      typeof event.data.locale !== "string" ||
      !next ||
      !Object.keys(labels).every((key) => typeof next[key] === "string")
    )
      return
    labels = next
    document.documentElement.lang = event.data.locale
    viewport.setAttribute("aria-label", labels.viewport)
    if (lastError !== undefined) renderError()
    return
  }
  // The parent's zoom pill steps or resets the view; wheel and keys here do the same directly.
  if (event.data?.type === "otis-canvas-zoom") {
    if (event.data.reset) resetView()
    else setZoom(scale * event.data.factor)
    return
  }
  const request = event.data
  if (request?.type !== "otis-canvas-source" || typeof request.source !== "string") return
  const colors = request.colors
  const validColors =
    !!colors &&
    typeof colors === "object" &&
    [
      "background",
      "surface",
      "text",
      "muted",
      "accent",
      "border",
      "cyan",
      "green",
      "orange",
      "pink",
      "yellow",
    ].every((name) => typeof colors[name] === "string" && colors[name].length <= 100)
  if (!validColors) return
  // A re-render of the same diagram (a theme or language change) keeps the user's zoom and pan.
  const keepView = request.source === lastSource
  lastSource = request.source
  fontSize = request.fontSize
  inline = request.inline === true
  large = request.large === true
  document.documentElement.classList.toggle("inline", inline)
  document.documentElement.classList.toggle("large", large)
  viewport.tabIndex = inline ? -1 : 0
  // Pele draws with these, and the page's text takes the same ink; a theme change recolours a
  // drawing already on screen. Chart series, branches and sections cycle the theme's palette,
  // then its dim and its ink for the seventh and eighth.
  for (const [name, value] of [
    ["bg", colors.background],
    ["fg", colors.text],
    ["muted", colors.muted],
    ["line", colors.muted],
    ["surface", colors.surface],
    ["surface-alt", colors.background],
    ["border", colors.border],
    ["accent", colors.accent],
    ["series-1", colors.accent],
    ["series-2", colors.cyan],
    ["series-3", colors.orange],
    ["series-4", colors.green],
    ["series-5", colors.pink],
    ["series-6", colors.yellow],
    ["series-7", colors.muted],
    ["series-8", colors.text],
  ])
    document.documentElement.style.setProperty(`--pele-${name}`, value)
  root.hidden = true
  root.innerHTML = ""
  errorView.hidden = true
  errorView.textContent = ""
  lastError = undefined
  if (request.source.length === 0) showError("emptySource")
  else if (request.source.length > 50_000) showError("tooLarge")
  else render(request.source, keepView)
})

// The frame's own fonts, which the drawing is measured and set in; the sandbox loads no other.
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const FONT_MONO = 'ui-monospace, "SF Mono", Menlo, monospace'

// Pele parses the Mermaid source and lays the drawing out itself, in one synchronous call, so a
// render is done before the next message can arrive. The layout knows the width it has, the
// frame's less the margins a tab and the dialog keep and the tab's cap, so a wide flowchart turns
// top-to-bottom in a narrow panel instead of shrinking. Links and images stay off: the source is
// the model's, and the frame may reach nothing anyway.
function render(source, keepView) {
  const pele = globalThis.pele
  if (!pele) return showError("loadFailed")

  laidOut = viewport.clientWidth
  try {
    const result = pele.render(source, {
      maxWidth: inline ? laidOut : Math.min(laidOut - 48, large ? Infinity : 760),
      fontFamily: FONT,
      fontFamilyMono: FONT_MONO,
      fontSize,
      links: false,
      images: false,
    })
    root.innerHTML = result.svg
    const svg = root.querySelector("svg")
    // Shown before the view is applied, so its bounds can be measured.
    root.hidden = false
    if (keepView) applyView()
    else resetView()
    parent.postMessage(
      {
        type: "otis-canvas-render",
        ok: true,
        width: svg.getBoundingClientRect().width,
        diagramBottom: svg.getBoundingClientRect().bottom,
        height: inline ? root.getBoundingClientRect().bottom : undefined,
      },
      "*",
    )
  } catch (reason) {
    showError(reason instanceof Error ? reason.message : String(reason))
  }
}

// The same limits as the parent's pill, which disables its buttons at them.
function setZoom(nextScale) {
  scale = Math.min(3, Math.max(0.5, nextScale))
  applyView()
}

function resetView() {
  scale = 1
  panX = 0
  panY = 0
  applyView()
}

// A corner of the drawing always stays this far inside the viewport, so a pan or a zoom cannot
// lose it. A frame not yet laid out has no viewport to measure against and keeps the view as is.
const PAN_MARGIN = 48

function clampPan() {
  const { clientWidth, clientHeight } = viewport
  if (!clientWidth || !clientHeight) return
  const width = root.offsetWidth * scale
  const height = root.offsetHeight * scale
  // The drawing scales about its top centre, or its centre when large.
  const left = root.offsetLeft + (root.offsetWidth - width) / 2
  const top = root.offsetTop + (large ? (root.offsetHeight - height) / 2 : 0)
  panX = Math.min(clientWidth - PAN_MARGIN - left, Math.max(PAN_MARGIN - left - width, panX))
  panY = Math.min(clientHeight - PAN_MARGIN - top, Math.max(PAN_MARGIN - top - height, panY))
}

// The parent shows the level in its pill, so every change of view reports the scale.
function applyView() {
  clampPan()
  root.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${scale})`
  parent.postMessage({ type: "otis-canvas-view", scale }, "*")
}

function endDrag(event) {
  if (!drag || drag.pointerId !== event.pointerId) return
  drag = undefined
  viewport.classList.remove("dragging")
  if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId)
}

function showError(message) {
  root.hidden = true
  root.innerHTML = ""
  errorView.hidden = false
  lastError = message
  renderError()
  parent.postMessage(
    {
      type: "otis-canvas-render",
      ok: false,
      message: Object.hasOwn(labels, message) ? labels[message] : message,
      height: inline ? errorView.getBoundingClientRect().bottom : undefined,
    },
    "*",
  )
}

// The frame's width follows the panel, so a drawing on screen is laid out again for it, keeping
// the user's view. A change of height alone, which the parent makes to fit an inline drawing,
// changes nothing.
window.addEventListener("resize", () => {
  if (root.hidden || viewport.clientWidth === laidOut) return
  render(lastSource, true)
})

function renderError() {
  const detail = Object.hasOwn(labels, lastError) ? labels[lastError] : lastError
  errorView.textContent = `${labels.renderFailed}\n\n${detail}`
}

function requiredElement(id) {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Canvas is missing #${id}.`)
  return element
}
