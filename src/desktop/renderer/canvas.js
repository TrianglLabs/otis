// This script is inlined into an opaque-origin iframe and cannot import modules.
// The parent replaces these initial English labels with the selected catalog on load.
let labels = {
  viewport: "Diagram canvas. Drag to pan; use the controls to zoom.",
  controls: "Diagram view controls",
  zoomOut: "Zoom out",
  resetView: "Reset view",
  zoomIn: "Zoom in",
  renderFailed: "Could not render this Mermaid diagram.",
  loadFailed: "Mermaid failed to load.",
  emptySource: "The Mermaid block is empty.",
  tooLarge: "This Mermaid diagram is too large to render. The limit is 50,000 characters.",
}
let lastError
const root = requiredElement("diagram")
const errorView = requiredElement("error")
const viewport = requiredElement("viewport")
const controls = requiredElement("controls")
const zoomOut = requiredElement("zoom-out")
const zoomIn = requiredElement("zoom-in")
const resetButton = requiredElement("reset-view")

let renderId = 0
let scale = 1
let panX = 0
let panY = 0
let drag
let latestRequest = 0
let lastSource

zoomOut.addEventListener("click", () => setZoom(scale / 1.2))
zoomIn.addEventListener("click", () => setZoom(scale * 1.2))
resetButton.addEventListener("click", resetView)

viewport.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return
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
    controls.setAttribute("aria-label", labels.controls)
    for (const [element, label] of [
      [zoomOut, labels.zoomOut],
      [resetButton, labels.resetView],
      [zoomIn, labels.zoomIn],
    ]) {
      element.setAttribute("aria-label", label)
      element.title = label
    }
    if (lastError !== undefined) renderError()
    return
  }
  const request = event.data
  if (request?.type !== "otis-canvas-source" || typeof request.source !== "string") return
  const colors = request.colors
  const validColors =
    !!colors &&
    typeof colors === "object" &&
    ["background", "surface", "text", "muted", "accent", "border"].every(
      (name) => typeof colors[name] === "string" && colors[name].length <= 100,
    )
  if (!validColors) return
  const requestId = ++latestRequest
  // A re-render of the same diagram (a theme or language change) keeps the user's zoom and pan.
  const keepView = request.source === lastSource
  lastSource = request.source
  document.body.style.color = colors.text
  document.documentElement.style.setProperty("--canvas-surface", colors.surface)
  document.documentElement.style.setProperty("--canvas-border", colors.border)
  document.documentElement.style.setProperty("--canvas-text", colors.text)
  document.documentElement.style.setProperty("--canvas-muted", colors.muted)
  document.documentElement.style.setProperty("--canvas-hover", colors.background)
  errorView.style.color = colors.muted
  root.hidden = true
  root.innerHTML = ""
  errorView.hidden = true
  errorView.textContent = ""
  lastError = undefined
  if (request.source.length === 0) showError("emptySource", requestId)
  else if (request.source.length > 50_000) showError("tooLarge", requestId)
  else void render(request.source, colors, requestId, keepView)
})

async function render(source, colors, requestId, keepView) {
  const mermaid = globalThis.mermaid
  if (!mermaid) return showError("loadFailed", requestId)

  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: "base",
      look: "classic",
      themeCSS: "* { filter: none; box-shadow: none; }",
      themeVariables: {
        background: colors.background,
        primaryColor: colors.surface,
        primaryTextColor: colors.text,
        primaryBorderColor: colors.border,
        lineColor: colors.muted,
        secondaryColor: colors.surface,
        tertiaryColor: colors.background,
        actorBkg: colors.surface,
        actorBorder: colors.border,
        actorTextColor: colors.text,
        signalColor: colors.text,
        signalTextColor: colors.text,
        labelBoxBkgColor: colors.surface,
        labelBoxBorderColor: colors.border,
        labelTextColor: colors.text,
        noteBkgColor: colors.surface,
        noteBorderColor: colors.accent,
        noteTextColor: colors.text,
      },
    })
    const result = await mermaid.render(`otis-canvas-${renderId++}`, source)
    if (requestId !== latestRequest) return
    root.innerHTML = result.svg
    if (keepView) applyView()
    else resetView()
    const svg = root.querySelector("svg")
    if (svg) {
      const viewBoxWidth = Number(svg.getAttribute("viewBox")?.split(/\s+/)[2])
      const naturalWidth = Number.isFinite(viewBoxWidth) && viewBoxWidth > 0 ? viewBoxWidth : 480
      svg.style.width = `min(100%, ${Math.min(naturalWidth, 480)}px)`
      svg.style.maxWidth = "100%"
      svg.style.height = "auto"
      svg.style.margin = "0 auto"
    }
    root.hidden = false
    parent.postMessage(
      {
        type: "otis-canvas-render",
        ok: true,
        width: svg?.getBoundingClientRect().width,
        diagramTop: svg?.getBoundingClientRect().top,
        controlsBottom: controls.getBoundingClientRect().bottom,
        controls: true,
      },
      "*",
    )
  } catch (reason) {
    showError(reason instanceof Error ? reason.message : String(reason), requestId)
  }
}

function setZoom(nextScale) {
  scale = Math.min(3, Math.max(0.4, nextScale))
  applyView()
}

function resetView() {
  scale = 1
  panX = 0
  panY = 0
  applyView()
}

function applyView() {
  root.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${scale})`
  resetButton.textContent = `${Math.round(scale * 100)}%`
}

function endDrag(event) {
  if (!drag || drag.pointerId !== event.pointerId) return
  drag = undefined
  viewport.classList.remove("dragging")
  if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId)
}

function showError(message, requestId) {
  if (requestId !== latestRequest) return
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
    },
    "*",
  )
}

function renderError() {
  const detail = Object.hasOwn(labels, lastError) ? labels[lastError] : lastError
  errorView.textContent = `${labels.renderFailed}\n\n${detail}`
}

function requiredElement(id) {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Canvas is missing #${id}.`)
  return element
}
