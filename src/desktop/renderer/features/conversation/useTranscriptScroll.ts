import {
  type KeyboardEvent,
  type PointerEvent,
  type TouchEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type WheelEvent,
} from "react"

const BOTTOM_THRESHOLD = 32

/** Follow layout changes, but pause on actual scrolling input or text selection. */
export function useTranscriptScroll() {
  const element = useRef<HTMLElement | null>(null)
  const observer = useRef<ResizeObserver | null>(null)
  const frame = useRef<number | undefined>(undefined)
  const following = useRef(true)
  const touchY = useRef<number | undefined>(undefined)
  const [atBottom, setAtBottom] = useState(true)
  const [scrolling, setScrolling] = useState(false)
  const [listHeight, setListHeight] = useState(0)

  const follow = useCallback(() => {
    if (!following.current || frame.current !== undefined) return
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined
      const scroll = element.current
      if (!scroll || !following.current || scroll.clientHeight === 0) return
      scroll.scrollTop = scroll.scrollHeight
    })
  }, [])

  // Measurements arrive before React commits Virtuoso's updated layout.
  useLayoutEffect(follow, [follow, listHeight])

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

  const pauseFollowing = useCallback(() => {
    following.current = false
    setAtBottom(false)
  }, [])

  const hasSelection = useCallback(() => {
    const selection = document.getSelection()
    return !!selection && !selection.isCollapsed && element.current?.contains(selection.anchorNode) === true
  }, [])

  useEffect(() => {
    const onSelectionChange = () => {
      if (hasSelection()) pauseFollowing()
    }
    document.addEventListener("selectionchange", onSelectionChange)
    return () => document.removeEventListener("selectionchange", onSelectionChange)
  }, [hasSelection, pauseFollowing])

  const onScrollCapture = useCallback(
    (event: UIEvent<HTMLElement>) => {
      const scroll = event.currentTarget
      if (event.target !== scroll || scroll.clientHeight === 0) return
      // Layout corrections also dispatch scroll events. Only returning to the tail changes follow mode here;
      // leaving it is driven by the user's input, never inferred from automatic scroll-position changes.
      if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= BOTTOM_THRESHOLD && !hasSelection()) {
        following.current = true
        setAtBottom(true)
      }
    },
    [hasSelection],
  )

  const onWheelCapture = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      if (event.deltaY < 0 && scrollsTranscript(event.target, event.currentTarget)) pauseFollowing()
    },
    [pauseFollowing],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented || !(event.target instanceof HTMLElement)) return
      if (event.target.closest("input, textarea, [contenteditable=true]")) return
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) {
        if (scrollsTranscript(event.target, event.currentTarget)) pauseFollowing()
      }
    },
    [pauseFollowing],
  )

  const onPointerDownCapture = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      // Native scrollbar presses target the scroller itself, unlike content or nested diff controls.
      if (event.button === 0 && event.target === event.currentTarget) pauseFollowing()
    },
    [pauseFollowing],
  )

  const onTouchStartCapture = useCallback((event: TouchEvent<HTMLElement>) => {
    touchY.current = event.touches[0]?.clientY
  }, [])
  const onTouchMoveCapture = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      const next = event.touches[0]?.clientY
      if (
        next !== undefined &&
        touchY.current !== undefined &&
        next > touchY.current &&
        scrollsTranscript(event.target, event.currentTarget)
      )
        pauseFollowing()
      touchY.current = next
    },
    [pauseFollowing],
  )

  const isScrolling = useCallback((value: boolean) => setScrolling(value), [])

  const jumpToLatest = useCallback(() => {
    following.current = true
    setAtBottom(true)
    follow()
  }, [follow])

  return {
    atBottom,
    scrolling,
    scrollerRef,
    onScrollCapture,
    onWheelCapture,
    onKeyDown,
    onPointerDownCapture,
    onTouchStartCapture,
    onTouchMoveCapture,
    totalListHeightChanged: setListHeight,
    jumpToLatest,
    isScrolling,
  }
}

/** A nested diff consumes upward input while it has content above its own viewport. */
function scrollsTranscript(target: EventTarget, scroller: HTMLElement) {
  for (let node = target instanceof Element ? target : null; node && node !== scroller; node = node.parentElement) {
    if (node instanceof HTMLElement && node.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(node).overflowY)) {
      return false
    }
  }
  return scroller.scrollTop > 0
}
