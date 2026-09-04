import { describe, expect, it, vi } from "vitest"
import { mergeGenerators, serialized } from "../../src/core/concurrency.js"

describe("mergeGenerators", () => {
  it("interleaves events as they arrive and returns results in the original order", async () => {
    async function* slow(): AsyncGenerator<string, string> {
      yield "slow:1"
      await new Promise((resolve) => setTimeout(resolve, 10))
      yield "slow:2"
      return "slow-done"
    }
    async function* fast(): AsyncGenerator<string, string> {
      yield "fast:1"
      yield "fast:2"
      return "fast-done"
    }

    const events: string[] = []
    const merged = mergeGenerators([slow(), fast()])
    let step = await merged.next()
    while (!step.done) {
      events.push(step.value)
      step = await merged.next()
    }

    expect(step.value).toEqual(["slow-done", "fast-done"])
    expect(events).toHaveLength(4)
    expect(events.indexOf("fast:2")).toBeLessThan(events.indexOf("slow:2"))
  })

  it("returns immediately for an empty batch", async () => {
    const merged = mergeGenerators<never, string>([])
    expect(await merged.next()).toEqual({ done: true, value: [] })
  })
})

describe("serialized", () => {
  it("runs concurrent callers one at a time in call order and isolates failures", async () => {
    const active: number[] = []
    let maxActive = 0
    const inner = vi.fn(async (id: number) => {
      active.push(id)
      maxActive = Math.max(maxActive, active.length)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active.pop()
      if (id === 2) throw new Error("second failed")
      return id * 10
    })
    const fn = serialized(inner)

    const results = await Promise.allSettled([fn(1), fn(2), fn(3)])

    expect(maxActive).toBe(1)
    expect(inner.mock.calls.map(([id]) => id)).toEqual([1, 2, 3])
    expect(results).toMatchObject([
      { status: "fulfilled", value: 10 },
      { status: "rejected", reason: expect.objectContaining({ message: "second failed" }) },
      { status: "fulfilled", value: 30 },
    ])
  })
})
