import type { LucideIcon } from "lucide-react"
import { type ReactNode, useLayoutEffect, useRef } from "react"
import { Icon } from "./Icon.js"

/**
 * A segmented control: one capsule track, and a pill that glides to whichever segment is
 * selected. It snaps into place on first paint only.
 */
export function TabStrip<T extends string>({
  tabs,
  selected,
  onSelect,
}: {
  tabs: readonly (readonly [T, ReactNode, LucideIcon?])[]
  selected: T
  onSelect: (tab: T) => void
}) {
  const strip = useRef<HTMLDivElement>(null)
  const tab = useRef<HTMLButtonElement>(null)
  const pill = useRef<HTMLSpanElement>(null)
  const placed = useRef(false)
  const place = (snap: boolean) => {
    if (!tab.current || !pill.current) return
    const style = pill.current.style
    if (snap) style.transition = "none"
    style.transform = `translateX(${tab.current.offsetLeft}px)`
    style.width = `${tab.current.offsetWidth}px`
    if (!snap) return
    void pill.current.offsetWidth
    style.transition = ""
  }
  // Every render, since a label can change width without the selection moving.
  useLayoutEffect(() => {
    place(!placed.current)
    placed.current = true
  })
  // The bundled font can land after first paint and widen the labels.
  useLayoutEffect(() => {
    if (!strip.current) return
    const observer = new ResizeObserver(() => place(false))
    observer.observe(strip.current)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={strip} className="tabStrip" role="tablist">
      <span ref={pill} className="tabStrip-pill" aria-hidden />
      {tabs.map(([id, label, icon]) => (
        <button
          key={id}
          ref={id === selected ? tab : undefined}
          type="button"
          role="tab"
          className="tabStrip-tab"
          aria-selected={id === selected}
          onClick={() => onSelect(id)}
        >
          {icon ? <Icon icon={icon} size={13} /> : null}
          {label}
        </button>
      ))}
    </div>
  )
}
