// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { CubeLoader, OtisMark } from "../../../src/desktop/renderer/components/OtisMark.js"
import { MARK_CELL, MARK_FACES } from "../../../src/desktop/renderer/mark.js"

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

type Matrix = readonly number[]

/** A square's corners on the page, rounded and in a fixed order, whatever its markup. */
function corners([a, b, c, d, e, f]: Matrix, x: number, y: number) {
  return [
    [x, y],
    [x + MARK_CELL, y],
    [x, y + MARK_CELL],
    [x + MARK_CELL, y + MARK_CELL],
  ]
    .map(([u, v]) => `${(a * u + c * v + e).toFixed(2)},${(b * u + d * v + f).toFixed(2)}`)
    .sort()
    .join(" ")
}

/** Where the view box starts, which maps a user coordinate to the mark's own (user - start). */
const origin = (svg: Element) => (svg.getAttribute("viewBox") ?? "").split(" ").map(Number)

/** Every drawn square as its corners with its fill and its opacity at the default top value. */
function squares(svg: Element) {
  const [originX, originY] = origin(svg)
  return [...svg.querySelectorAll("rect")]
    .map((rect) => {
      const [a, b, c, d, e, f] = (
        rect.getAttribute("transform")?.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []
      ).map(Number)
      const matrix = [a, b, c, d, e - originX, f - originY]
      // calc(right + up * var(--otis-mark-top-opacity, default) + left), at the default.
      const [, right, up, , left] =
        /calc\((\S+) \+ (\S+) \* var\(--otis-mark-top-opacity, (\S+)\) \+ (\S+)\)/
          .exec(rect.style.opacity)
          ?.map(Number) ?? []
      const opacity = right + up * MARK_FACES.top.opacity + left
      const at = corners(matrix, Number(rect.getAttribute("x")), Number(rect.getAttribute("y")))
      return `${at} ${rect.getAttribute("fill") ?? "currentColor"} ${opacity.toFixed(2)}`
    })
    .sort()
}

it("draws exactly the original artwork's squares, fills and shading at rest", () => {
  const { container } = render(<OtisMark />)
  const artwork = Object.entries(MARK_FACES)
    .flatMap(([face, { matrix, cells, opacity }]) =>
      cells.map(([x, y]) => {
        const fill = face === "front" ? "var(--accent, currentColor)" : "currentColor"
        return `${corners(matrix, x, y)} ${fill} ${opacity.toFixed(2)}`
      }),
    )
    .sort()
  expect(squares(container.querySelector("svg") as Element)).toEqual(artwork)
  expect(screen.getByRole("img", { name: "Otis" })).toBeTruthy()
  expect(screen.queryByRole("button")).toBeNull()
})

it("scrambles on a click, keeps the O, and solves back to exactly where it began", async () => {
  render(<OtisMark className="home-logo" solvable />)
  const button = screen.getByRole("button", { name: "Scramble and solve the cube" })
  const svg = button.querySelector("svg") as SVGSVGElement
  expect(svg.getAttribute("aria-hidden")).toBe("true")
  const rest = svg.innerHTML

  fireEvent.click(button)
  // Into the scrambled beat. Nine quarter turns permute the corners oddly and only one corner is
  // out of sight, so any scramble shows.
  await act(async () => vi.advanceTimersByTime(9 * 95 + 100))
  expect(svg.innerHTML).not.toBe(rest)
  // Nothing sits where the O's center is: face centers never move.
  const [originX, originY] = origin(svg)
  const [x, y] = [
    MARK_FACES.front.matrix[4] + 30 * 0.866025 + originX,
    MARK_FACES.front.matrix[5] + 15 + originY,
  ]
  const centers = [...svg.querySelectorAll("rect")].map((rect) =>
    (rect.getAttribute("transform")?.match(/-?[\d.]+(?:e-?\d+)?/g) ?? [])
      .slice(4)
      .map((value) => Number(value).toFixed(1)),
  )
  expect(centers).not.toContainEqual([x.toFixed(1), y.toFixed(1)])
  expect(svg.querySelectorAll('rect[fill="var(--accent, currentColor)"]').length).toBeLessThan(9)

  // A click mid-animation is ignored; the solve runs out and the cube is as before.
  fireEvent.click(button)
  await act(async () => vi.advanceTimersByTime(260 + 9 * 150 + 50))
  expect(svg.innerHTML).toBe(rest)

  // It can be played again.
  fireEvent.click(button)
  await act(async () => vi.advanceTimersByTime(400))
  expect(svg.innerHTML).not.toBe(rest)
})

it("stays still with reduced motion", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }))
  render(<OtisMark solvable />)
  const button = screen.getByRole("button", { name: "Scramble and solve the cube" })
  const rest = button.innerHTML
  fireEvent.click(button)
  await act(async () => vi.advanceTimersByTime(400))
  expect(button.innerHTML).toBe(rest)
})

it("loads with a cube that solves over and over beside its label until it unmounts", async () => {
  const { unmount } = render(<CubeLoader label="Loading models…" />)
  const status = screen.getByRole("status")
  expect(status.textContent).toBe("Loading models…")
  const svg = status.querySelector("svg") as SVGSVGElement
  const rest = svg.innerHTML
  // One cycle: scramble, beat, solve, then a rest at the solved cube before the next.
  await act(async () => vi.advanceTimersByTime(1000))
  expect(svg.innerHTML).not.toBe(rest)
  await act(async () => vi.advanceTimersByTime(1700))
  expect(svg.innerHTML).toBe(rest)
  await act(async () => vi.advanceTimersByTime(1250))
  expect(svg.innerHTML).not.toBe(rest)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it("loads with a still cube under reduced motion", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }))
  render(<CubeLoader label="Loading models…" />)
  const svg = screen.getByRole("status").querySelector("svg") as SVGSVGElement
  const still = svg.innerHTML
  await act(async () => vi.advanceTimersByTime(1800))
  expect(svg.innerHTML).toBe(still)
  expect(vi.getTimerCount()).toBe(0)
})
