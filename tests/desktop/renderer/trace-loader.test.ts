import { describe, expect, it } from "vitest"
import { createCoalescedLoader } from "../../../src/desktop/renderer/features/agents/trace-loader.js"

/** A manually resolved promise, for controlling when a load settles. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("trace loader", () => {
  it("lets an in-flight load finish and coalesces refreshes into one follow-up", async () => {
    const pending: Array<{ resolve: (value: number) => void }> = []
    let calls = 0
    const applied: number[] = []
    const loader = createCoalescedLoader(
      () => {
        calls += 1
        const next = deferred<number>()
        pending.push(next)
        return next.promise
      },
      (value) => applied.push(value),
    )

    loader.refresh()
    loader.refresh()
    loader.refresh()
    expect(calls).toBe(1) // refreshes queue behind the in-flight load instead of discarding it

    pending[0].resolve(1)
    await tick()
    await tick()
    expect(calls).toBe(2) // exactly one coalesced follow-up
    expect(applied).toEqual([1])

    pending[1].resolve(2)
    await tick()
    await tick()
    expect(applied).toEqual([1, 2])
    loader.dispose()
  })

  it("drops late responses after disposal", async () => {
    const next = deferred<number>()
    const applied: number[] = []
    const loader = createCoalescedLoader(
      () => next.promise,
      (value) => applied.push(value),
    )

    loader.refresh()
    loader.dispose()
    next.resolve(1)
    await tick()
    await tick()
    expect(applied).toEqual([])

    loader.refresh() // a disposed loader stays quiet
    await tick()
    expect(applied).toEqual([])
  })

  it("recovers after a failed load", async () => {
    let calls = 0
    const applied: number[] = []
    const loader = createCoalescedLoader(
      () => {
        calls += 1
        return calls === 1 ? Promise.reject(new Error("gone")) : Promise.resolve(calls)
      },
      (value) => applied.push(value),
    )

    loader.refresh()
    await tick()
    await tick()
    loader.refresh()
    await tick()
    await tick()
    expect(applied).toEqual([2])
    loader.dispose()
  })
})
