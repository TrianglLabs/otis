import { type UIEvent, useCallback, useEffect, useRef, useState } from "react"

const BOTTOM_THRESHOLD = 32

/** One owner for follow mode. Content measurements never override the user's scrolling or text selection. */
export function useTranscriptScroll() {
  const element = useRef<HTMLElement | null>(null)
  const observer = useRef<ResizeObserver | null>(null)
  const frame = useRef<number | undefined>(undefined)
  const following = useRef(true)
  const previousTop = useRef(0)
  const [atBottom, setAtBottom] = useState(true)

  const follow = useCallback(() => {
    if (!following.current || frame.current !== undefined) return
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined
      const scroll = element.current
      if (!scroll || !following.current || scroll.clientHeight === 0) return
      scroll.scrollTop = scroll.scrollHeight
      previousTop.current = scroll.scrollTop
    })
  }, [])

  const scrollerRef = useCallback(
    (scroll: HTMLElement | Window | null) => {
      observer.current?.disconnect()
      element.current = scroll instanceof HTMLElement ? scroll : null
      if (!element.current) return
      observer.current = new ResizeObserver(follow)
      observer.current.observe(element.current)
    },
    [follow],
  )

  useEffect(
    () => () => {
      observer.current?.disconnect()
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    },
    [],
  )

  useEffect(() => {
    const onSelectionChange = () => {
      const selection = document.getSelection()
      if (!selection || selection.isCollapsed || !element.current?.contains(selection.anchorNode)) return
      // Reading/copying text takes priority over following output; otherwise streaming can move the selected
      // row outside the mounted window and destroy the selection.
      following.current = false
      setAtBottom(false)
    }
    document.addEventListener("selectionchange", onSelectionChange)
    return () => document.removeEventListener("selectionchange", onSelectionChange)
  }, [])

  const onScrollCapture = useCallback((event: UIEvent<HTMLElement>) => {
    const scroll = event.currentTarget
    // Horizontal tables and independently scrollable diffs do not change transcript follow mode.
    if (event.target !== scroll || scroll.clientHeight === 0) return
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= BOTTOM_THRESHOLD
    if (nearBottom) following.current = true
    else if (scroll.scrollTop < previousTop.current) following.current = false
    previousTop.current = scroll.scrollTop
    setAtBottom(following.current)
  }, [])

  const jumpToLatest = useCallback(() => {
    following.current = true
    setAtBottom(true)
    follow()
  }, [follow])

  return { atBottom, scrollerRef, onScrollCapture, totalListHeightChanged: follow, jumpToLatest }
}
