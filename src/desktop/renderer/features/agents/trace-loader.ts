/**
 * Coalesces refresh requests behind the in-flight load: a refresh arriving while a load runs marks at most one
 * follow-up load, which starts when the current one settles. Disposing drops late responses. The trace overlay
 * uses this so a burst of status events cannot starve the live view by repeatedly discarding in-flight
 * responses — and a trace or session change disposes the loader, invalidating its outstanding responses.
 */
export function createCoalescedLoader<T>(load: () => Promise<T>, apply: (value: T) => void) {
  let inFlight = false
  let queued = false
  let disposed = false

  const refresh = () => {
    if (disposed) return
    if (inFlight) {
      queued = true
      return
    }
    inFlight = true
    void load()
      .then((value) => {
        if (!disposed) apply(value)
      })
      .catch(() => {})
      .finally(() => {
        inFlight = false
        if (queued && !disposed) {
          queued = false
          refresh()
        }
      })
  }

  return {
    refresh,
    dispose: () => {
      disposed = true
    },
  }
}
