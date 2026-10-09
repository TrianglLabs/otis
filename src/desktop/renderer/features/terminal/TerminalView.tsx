import type { Terminal } from "ghostty-web"
import { useEffect, useRef } from "react"
import { useDesktop } from "../../runtime.js"
import { APP_SHORTCUTS } from "../../shell/shortcuts.js"

const SCROLLBACK_LINES = 5000
/** Quiet time after the last size change before the grid is measured. */
const SETTLE_MS = 100
/** How long the scrollbar stays after a scroll, like the app's other thin bars. */
const SCROLL_FLASH_MS = 700
/** The smallest thumb, so a long scrollback still has something to grab. */
const MIN_THUMB_PX = 20

/**
 * The workspace shell, drawn by Ghostty's terminal core compiled to WebAssembly; the shell itself
 * runs in the main process and outlives this view. Mounting attaches once the view's size has
 * settled, since the rail animates open around it: what the shell printed before is replayed
 * first, with the terminal's own replies to it swallowed, then live output follows. Later size
 * changes reach the shell once they settle too, so it redraws its prompt once per drag, not per
 * frame. The design tokens are handed over as the palette; Ghostty bakes it in at creation, so a
 * theme change mounts a fresh view, which attaches and replays like any other. The scrollbar is
 * the app's thin one, in the gutter Ghostty's fit addon leaves beside the grid.
 */
export function TerminalView({
  activated,
}: {
  /** When the terminal was last asked for; a change brings focus back to it. */
  activated: number | undefined
}) {
  const { api } = useDesktop()
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal>(null)
  useEffect(() => {
    const element = host.current as HTMLDivElement
    let gone = false
    const stops: (() => void)[] = []
    void (async () => {
      // Loaded on first use: the terminal core is a megabyte the app otherwise never needs.
      const { FitAddon, init, Terminal } = await import("ghostty-web")
      await init()
      if (gone) return
      const token = (name: string) => getComputedStyle(element).getPropertyValue(name).trim()
      const bg = token("--bg-rail")
      const text = token("--text")
      const dim = token("--text-dim")
      const accent = token("--accent")
      const cyan = token("--cyan")
      const green = token("--green")
      const pink = token("--pink")
      const yellow = token("--yellow")
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: token("--font-mono"),
        fontSize: Number.parseFloat(token("--text-ui")),
        scrollback: SCROLLBACK_LINES,
        theme: {
          background: bg,
          foreground: text,
          cursor: accent,
          cursorAccent: bg,
          selectionBackground: accent,
          selectionForeground: token("--on-accent"),
          black: dim,
          brightBlack: dim,
          red: pink,
          brightRed: pink,
          green,
          brightGreen: green,
          yellow,
          brightYellow: yellow,
          blue: cyan,
          brightBlue: cyan,
          magenta: accent,
          brightMagenta: accent,
          cyan,
          brightCyan: cyan,
          white: text,
          brightWhite: text,
        },
      })
      stops.push(() => term.dispose())
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(element)
      // Unlike xterm, ghostty-web asks whether the app takes the key: true keeps it from the shell.
      term.attachCustomKeyEventHandler(
        (event) => (event.metaKey || event.ctrlKey) && APP_SHORTCUTS.has(event.key.toLowerCase()),
      )
      // Ghostty paints its own scrollbar over the grid's last column and takes clicks there for
      // it. Its show method is the only way the bar appears and its mousedown handler the only
      // way it reacts; with both gone the grid stays clean and the gutter holds the app's bar.
      const own = term as unknown as { showScrollbar(): void; handleMouseDown: EventListener }
      own.showScrollbar = () => {}
      element.removeEventListener("mousedown", own.handleMouseDown, { capture: true })
      const track = document.createElement("div")
      track.className = "terminal-scrollbar"
      const thumb = document.createElement("div")
      thumb.className = "terminal-scrollbarThumb"
      track.append(thumb)
      element.append(track)
      // The viewport counts lines up from the bottom: at the scrollback length it is at the top.
      const place = () => {
        const scrollback = term.getScrollbackLength()
        track.hidden = scrollback === 0
        if (track.hidden) return
        const height = track.clientHeight
        const size = Math.max(MIN_THUMB_PX, (term.rows / (scrollback + term.rows)) * height)
        thumb.style.height = `${size}px`
        const top = (1 - term.getViewportY() / scrollback) * (height - size)
        thumb.style.transform = `translateY(${top}px)`
      }
      const lineFor = (thumbTop: number) =>
        Math.round(
          (1 - thumbTop / (track.clientHeight - thumb.offsetHeight)) * term.getScrollbackLength(),
        )
      track.onpointerdown = (down) => {
        // Keeps the focus and the selection where they are.
        down.preventDefault()
        const trackTop = track.getBoundingClientRect().top
        if (down.target !== thumb) {
          term.scrollToLine(lineFor(down.clientY - trackTop - thumb.offsetHeight / 2))
          return
        }
        const grip = down.clientY - thumb.getBoundingClientRect().top
        const drag = (event: PointerEvent) =>
          term.scrollToLine(lineFor(event.clientY - trackTop - grip))
        const release = () => {
          document.removeEventListener("pointermove", drag)
          document.removeEventListener("pointerup", release)
        }
        document.addEventListener("pointermove", drag)
        document.addEventListener("pointerup", release)
      }
      let flash: ReturnType<typeof setTimeout> | undefined
      const scrolled = term.onScroll(() => {
        place()
        element.classList.add("scrolling")
        clearTimeout(flash)
        flash = setTimeout(() => element.classList.remove("scrolling"), SCROLL_FLASH_MS)
      })
      stops.push(() => {
        scrolled.dispose()
        clearTimeout(flash)
      })
      const attach = async () => {
        const history = await api.openTerminal()
        if (gone) return
        void api.resizeTerminal(term.cols, term.rows)
        stops.push(
          api.subscribeTerminal((data) => {
            term.write(data)
            place()
          }),
        )
        // Ghostty answers the queries in the replayed history (device attributes, cursor
        // position) synchronously from write, so the gate lifts as soon as it returns. Its write
        // callback would wait for an animation frame instead, which a hidden window never gets:
        // a terminal attached while the window was covered would then drop every keystroke.
        // A shell that has not printed yet has nothing to replay, and ghostty-web 0.4 throws on
        // an empty write (its zero-length allocation is a dangling pointer).
        let replaying = true
        const typing = term.onData((data) => {
          if (!replaying) void api.writeTerminal(data)
        })
        stops.push(() => typing.dispose())
        if (history) term.write(history)
        replaying = false
        place()
      }
      let attached = false
      let settle: ReturnType<typeof setTimeout> | undefined
      const resize = new ResizeObserver(() => {
        clearTimeout(settle)
        settle = setTimeout(() => {
          // The addon's own fit() ignores calls within 50 ms of the last one; its proposal has no
          // such lockout.
          const grid = fit.proposeDimensions()
          if (grid) term.resize(grid.cols, grid.rows)
          if (attached) {
            void api.resizeTerminal(term.cols, term.rows)
            place()
          } else {
            attached = true
            void attach()
          }
        }, SETTLE_MS)
      })
      resize.observe(element)
      stops.push(() => {
        clearTimeout(settle)
        resize.disconnect()
      })
      terminal.current = term
      term.focus()
    })()
    return () => {
      gone = true
      for (const stop of stops) stop()
    }
  }, [api])
  useEffect(() => terminal.current?.focus(), [activated])
  return <div ref={host} className="terminal" />
}
