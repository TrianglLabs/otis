import { RGBA } from "@opentui/core"
import { describe, expect, it } from "vitest"
import { colors, selectTheme } from "../../src/cli/theme.js"
import { mixHex } from "../../src/cli/ui/color-pulse.js"
import {
  ACTIVITY_DAYS,
  ACTIVITY_WIDTH,
  activityArt,
  MARK_SIZE,
  markArt,
  markDots,
} from "../../src/cli/ui/panels.js"

const EMPTY = 0
const TOP = 1
const LEFT = 2
const FRONT = 3

describe("mark art", () => {
  const dots = markDots()
  const faces = (row: number) => new Set(dots[row].filter((face) => face !== EMPTY))

  it("draws a square dot grid with the top face above the left and front faces", () => {
    expect(dots).toHaveLength(MARK_SIZE)
    expect(dots.every((row) => row.length === MARK_SIZE)).toBe(true)
    expect(faces(1)).toEqual(new Set([TOP]))
    expect(faces(MARK_SIZE - 1)).toEqual(new Set([LEFT, FRONT]))
    const shoulder = dots.findIndex((row) => row.includes(LEFT))
    expect(faces(shoulder)).toEqual(new Set([TOP, LEFT, FRONT]))
  })

  it("mirrors the side faces except for the O cut from the front", () => {
    const count = (face: number) =>
      dots.reduce((sum, row) => sum + row.filter((dot) => dot === face).length, 0)
    expect(count(LEFT) - count(FRONT)).toBe(25)
    const [first, last] = [dots.findIndex((row) => row.includes(FRONT)), MARK_SIZE - 1]
    const mirrored = dots.every((row, y) =>
      y < first || y > last || row[0] === EMPTY || row[MARK_SIZE - 1] === EMPTY
        ? true
        : row.filter((dot) => dot === LEFT).length >= row.filter((dot) => dot === FRONT).length,
    )
    expect(mirrored).toBe(true)
  })

  it("inks the O face with the accent and the rest with washed text, fading downward", () => {
    selectTheme("matrix")
    try {
      const art = markArt()
      const lines = art.chunks.filter((chunk) => chunk.text === "\n")
      expect(lines).toHaveLength(MARK_SIZE / 4 - 1)
      expect(art.chunks.every((chunk) => chunk.text.length === 1)).toBe(true)
      const rows = art.chunks
        .map((chunk) => chunk.text)
        .join("")
        .split("\n")
      expect(rows.every((row) => row.length === MARK_SIZE / 2)).toBe(true)
      expect(rows.join("")).toMatch(/^[ ⠀-⣿]+$/)
      const inks = art.chunks
        .filter((chunk) => /[⠀-⣿]/.test(chunk.text))
        .map((chunk) => (chunk.fg as RGBA).toInts())
      const nearest = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
        return Math.min(...inks.map(([x, y, z]) => Math.hypot(x - r, y - g, z - b)))
      }
      expect(nearest(colors.accent)).toBeLessThan(nearest(colors.text))
      expect(nearest(mixHex(colors.background, colors.text, 0.7))).toBeLessThan(8)
      expect(
        inks.some(
          ([r, g, b]) =>
            `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}` ===
            colors.text.toLowerCase(),
        ),
      ).toBe(false)
    } finally {
      selectTheme("default")
    }
  })
})

describe("activity art", () => {
  const block = /[\u2581-\u2588]/
  const rows = (days: { tokens: number }[], grown: number | number[] = 1) => {
    const art = activityArt(
      days,
      typeof grown === "number" ? Array(ACTIVITY_DAYS).fill(grown) : grown,
    )
    const lines = art.chunks
      .map((chunk) => chunk.text)
      .join("")
      .split("\n")
    return { lines, chunks: art.chunks }
  }
  const column = (lines: string[], day: number) => lines.map((line) => line[day * 2])

  it("draws three rows of 28 right-aligned days, padding a short history on the left", () => {
    const { lines } = rows([{ tokens: 10 }, { tokens: 5 }])
    expect(lines).toHaveLength(3)
    expect(lines.every((line) => line.length === ACTIVITY_WIDTH)).toBe(true)
    expect(column(lines, 0)).toEqual([" ", " ", "▁"])
    expect(column(lines, ACTIVITY_DAYS - 2)).toEqual(["▇", "█", "█"])
    expect(column(lines, ACTIVITY_DAYS - 1)).toEqual([" ", "▄", "█"])
    expect(lines.every((line) => /^(.\s)+.$/.test(line))).toBe(true)
  })

  it("stubs empty days in the border colour and keeps bars in the accent", () => {
    const days = Array.from({ length: ACTIVITY_DAYS }, (_, day) => ({ tokens: day % 2 ? 100 : 0 }))
    const { chunks } = rows(days)
    const inks = chunks.filter((chunk) => block.test(chunk.text)).map((chunk) => chunk.fg as RGBA)
    const border = RGBA.fromHex(colors.border)
    const accent = RGBA.fromHex(colors.accent)
    expect(inks.some((ink) => ink.equals(border))).toBe(true)
    expect(inks.some((ink) => ink.equals(accent))).toBe(true)
    expect(inks.every((ink) => ink.equals(border) || !ink.equals(RGBA.fromHex(colors.text)))).toBe(
      true,
    )
  })

  it("grows every bar from the baseline as the count-up runs", () => {
    const days = Array.from({ length: ACTIVITY_DAYS }, () => ({ tokens: 100 }))
    const start = rows(days, 0).lines
    const end = rows(days, 1).lines
    expect(start[0].trim()).toBe("")
    expect(start[1].trim()).toBe("")
    expect(end[0].trim()).not.toBe("")
    const half = rows(
      days,
      Array.from({ length: ACTIVITY_DAYS }, (_, day) => (day < 14 ? 1 : 0)),
    ).lines
    expect(half[0].slice(0, 28).trim()).not.toBe("")
    expect(half[0].slice(28).trim()).toBe("")
  })
})
