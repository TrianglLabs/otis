import type { ITheme, Terminal } from "ghostty-web"
import { useEffect, useRef } from "react"
import { useDesktop } from "../../runtime.js"
import { APP_SHORTCUTS } from "../../shell/shortcuts.js"

const SCROLLBACK_LINES = 5000
/** Quiet time after the last size change before the grid is measured. */
const SETTLE_MS = 100

/**
 * The workspace shell, drawn by Ghostty's terminal core compiled to WebAssembly; the shell itself
 * runs in the main process and outlives this view. Mounting attaches once the view's size has
 * settled, since the rail animates open around it: what the shell printed before is replayed
 * first, with the terminal's own replies to it swallowed, then live output follows. Later size
 * changes reach the shell once they settle too, so it redraws its prompt once per drag, not per
 * frame. The design tokens are handed over as the palette; Ghostty bakes it in at creation, so a
 * theme change mounts a fresh view, which attaches and replays like any other.
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
      const styles = getComputedStyle(element)
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: styles.getPropertyValue("--font-mono"),
        fontSize: Number.parseFloat(styles.getPropertyValue("--text-ui")),
        scrollback: SCROLLBACK_LINES,
        theme: palette(styles),
      })
      stops.push(() => term.dispose())
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(element)
      // Unlike xterm, ghostty-web asks whether the app takes the key: true keeps it from the shell.
      term.attachCustomKeyEventHandler(
        (event) => (event.metaKey || event.ctrlKey) && APP_SHORTCUTS.has(event.key.toLowerCase()),
      )
      const attach = async () => {
        const history = await api.openTerminal()
        if (gone) return
        void api.resizeTerminal(term.cols, term.rows)
        stops.push(api.subscribeTerminal((data) => term.write(data)))
        let replaying = true
        const typing = term.onData((data) => {
          if (!replaying) void api.writeTerminal(data)
        })
        stops.push(() => typing.dispose())
        term.write(history, () => {
          replaying = false
        })
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
          if (attached) void api.resizeTerminal(term.cols, term.rows)
          else {
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

function palette(styles: CSSStyleDeclaration): ITheme {
  const token = (name: string) => styles.getPropertyValue(name).trim()
  const bg = token("--bg-rail")
  const text = token("--text")
  const dim = token("--text-dim")
  const accent = token("--accent")
  const cyan = token("--cyan")
  const green = token("--green")
  const pink = token("--pink")
  const yellow = token("--yellow")
  return {
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
  }
}
