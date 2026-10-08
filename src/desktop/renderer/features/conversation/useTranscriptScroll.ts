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
  const [atTop, setAtTop] = useState(true)
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

  // The scroller's own box changes with the window; the list's border box changes with every row
  // Virtuoso measures, after the DOM has it. Following the second is what keeps the tail in view
  // when a row grows after the list reported its height, which on a slow machine happens
  // between the report and the commit.
  const scrollerRef = useCallback(
    (scroll: HTMLElement | Window | null) => {
      observer.current?.disconnect()
      element.current = scroll instanceof HTMLElement ? scroll : null
      if (!element.current) return
      observer.current = new ResizeObserver(follow)
      observer.current.observe(element.current)
      const list = element.current.querySelector(".transcript")
      if (list) observer.current.observe(list, { box: "border-box" })
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
    return (
      !!selection &&
      !selection.isCollapsed &&
      element.current?.contains(selection.anchorNode) === true
    )
  }, [])

  useEffect(() => {
    const onSelectionChange = () => {
      const scroll = element.current
      if (!scroll || scroll.clientHeight === 0) return
      if (hasSelection()) {
        // Preserve the selection while content streams, but keep the Latest button tied to the real
        // scroll position. Selecting text at the tail has not moved the reader away from it.
        following.current = false
        setAtBottom(isAtBottom(scroll))
      } else if (isAtBottom(scroll)) {
        following.current = true
        setAtBottom(true)
      }
    }
    document.addEventListener("selectionchange", onSelectionChange)
    return () => document.removeEventListener("selectionchange", onSelectionChange)
  }, [hasSelection])

  const onScrollCapture = useCallback(
    (event: UIEvent<HTMLElement>) => {
      const scroll = event.currentTarget
      if (event.target !== scroll || scroll.clientHeight === 0) return
      setAtTop(scroll.scrollTop <= 0)
      // Layout corrections also dispatch scroll events. Only returning to the tail changes follow
      // mode here; leaving it is driven by the user's input, never inferred from automatic
      // scroll-position changes.
      if (isAtBottom(scroll)) {
        setAtBottom(true)
        if (!hasSelection()) following.current = true
      } else if (hasSelection()) {
        // Drag-selecting can auto-scroll the transcript without wheel or keyboard input.
        setAtBottom(false)
      } else if (following.current) {
        // The reader's input pauses following before its scroll event arrives, so this is a
        // correction the list made for a row it measured, which can carry the view off the tail
        // without a size change to follow: pull it back.
        follow()
      }
    },
    [hasSelection, follow],
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
      const upward =
        ["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)
      if (upward && scrollsTranscript(event.target, event.currentTarget)) pauseFollowing()
    },
    [pauseFollowing],
  )

  // Empty transcript space and the native scrollbar share the scroller as their event target; only
  // a press in the scrollbar gutter counts as scrolling input.
  const onPointerDownCapture = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const scroller = event.currentTarget
      if (event.button !== 0 || event.target !== scroller) return
      const gutter = scroller.offsetWidth - scroller.clientWidth
      if (gutter <= 0) return
      const { right } = scroller.getBoundingClientRect()
      if (event.clientX >= right - gutter && event.clientX <= right) pauseFollowing()
    },
    [pauseFollowing],
  )

  const onTouchStartCapture = useCallback((event: TouchEvent<HTMLElement>) => {
    touchY.current = event.touches[0]?.clientY
  }, [])
  const onTouchMoveCapture = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      const next = event.touches[0]?.clientY
      const upward = next !== undefined && touchY.current !== undefined && next > touchY.current
      if (upward && scrollsTranscript(event.target, event.currentTarget)) pauseFollowing()
      touchY.current = next
    },
    [pauseFollowing],
  )

  const jumpToLatest = useCallback(() => {
    following.current = true
    setAtBottom(true)
    follow()
  }, [follow])

  return {
    /** The scroller element, for callers that read its geometry or walk its rows. */
    scroller: element,
    atBottom,
    atTop,
    scrolling,
    scrollerRef,
    onScrollCapture,
    onWheelCapture,
    onKeyDown,
    onPointerDownCapture,
    onTouchStartCapture,
    onTouchMoveCapture,
    totalListHeightChanged: setListHeight,
    pauseFollowing,
    jumpToLatest,
    isScrolling: setScrolling,
  }
}

/** A nested diff consumes upward input while it has content above its own viewport. */
function scrollsTranscript(target: EventTarget, scroller: HTMLElement) {
  for (
    let node = target instanceof Element ? target : null;
    node && node !== scroller;
    node = node.parentElement
  ) {
    if (
      node instanceof HTMLElement &&
      node.scrollTop > 0 &&
      /auto|scroll/.test(getComputedStyle(node).overflowY)
    ) {
      return false
    }
  }
  return scroller.scrollTop > 0
}

export function isAtBottom(scroller: HTMLElement) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= BOTTOM_THRESHOLD
}
