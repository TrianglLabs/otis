import { useEffect, useRef, useState } from "react"

/**
 * Shows the scrollbar while the element is being scrolled and briefly after, matching macOS overlay-scrollbar
 * behavior for the custom thin scrollbars. Returns the class flag and the handler to attach to the scrollable.
 */
export function useScrollbarFlash() {
  const [scrolling, setScrolling] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const onScroll = () => {
    setScrolling(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setScrolling(false), 700)
  }

  return { scrolling, onScroll }
}
