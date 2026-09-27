import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { calculateLocalStats, publishOmarchyUsage } from "../../src/local/stats.js"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("calculateLocalStats", () => {
  it("derives all home-screen stats from local session events across workspaces", async () => {
    const root = await tempDirectory()
    const now = new Date(2026, 6, 16, 12, 0, 0)
    const yesterday = new Date(2026, 6, 15, 12, 0, 0)

    await writeSession(root, "project-a", "session-a", [
      event(1, "session-a", "session_started", localISO(now, -10), { version: 1 }),
      event(2, "session-a", "prompt_admitted", localISO(now, 0), {
        promptId: "prompt-a",
        message: { role: "user", content: "hello" },
      }),
      event(3, "session-a", "usage_recorded", localISO(now, 1), {
        purpose: "agent",
        promptId: "prompt-a",
        provider: "fireworks",
        model: "accounts/fireworks/models/glm",
        modelName: "GLM-5.3",
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }),
      event(4, "session-a", "turn_completed", localISO(now, 120), {
        promptId: "prompt-a",
        messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
      }),
    ])
    await writeSession(root, "project-b", "session-b", [
      event(1, "session-b", "session_started", localISO(yesterday, -10), { version: 1 }),
      event(2, "session-b", "prompt_admitted", localISO(yesterday, 0), {
        promptId: "prompt-b",
        message: { role: "user", content: "hello" },
      }),
      event(3, "session-b", "usage_recorded", localISO(yesterday, 1), {
        purpose: "title",
        usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 },
      }),
      event(4, "session-b", "turn_completed", localISO(yesterday, 60), {
        promptId: "prompt-b",
        messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
      }),
    ])
    await writeSession(root, "project-b", "broken", ["not-json"])

    const stats = await calculateLocalStats({ sessionsRoot: root, now })
    expect(stats).toMatchObject({
      streak: 2,
      totalTokens: 200,
      sessionCount: 2,
      avgTokensPerSession: 100,
      avgSessionSeconds: 90,
      activeDays: 2,
      promptTokens: 140,
      completionTokens: 60,
      promptCount: 2,
      todayPrompts: 1,
      todaySessions: 1,
      todayTokens: 150,
      activeDates: [localDateKey(yesterday), localDateKey(now)],
      // Yesterday's title usage predates model notes, so only today's turn has a model.
      modelUsage: { "GLM-5.3": { hosted: true, promptTokens: 100, completionTokens: 50 } },
      todayTokensByModel: { "GLM-5.3": 150 },
    })
    // Firsts date from the earliest session; noon prompts earn no owl or bird.
    expect(stats.achievements).toEqual({
      "first-session": { at: localISO(yesterday, 0), count: 1 },
      "hosted-model": { at: localISO(now, 1), count: 1 },
    })
    expect(stats.recentActivity).toHaveLength(28)
    expect(stats.recentActivity?.filter((day) => day.tokens > 0)).toEqual([
      { date: localDateKey(yesterday), tokens: 50 },
      { date: localDateKey(now), tokens: 150 },
    ])
  })

  it("counts active turn time including interrupts and skips idle gaps", async () => {
    const root = await tempDirectory()
    const now = new Date(2026, 6, 16, 12, 0, 0)
    const yesterday = new Date(2026, 6, 15, 12, 0, 0)

    await writeSession(root, "project-a", "resumed", [
      event(1, "resumed", "session_started", localISO(yesterday, -10), { version: 1 }),
      event(2, "resumed", "prompt_admitted", localISO(yesterday, 0), {
        promptId: "prompt-a",
        message: { role: "user", content: "hello" },
      }),
      event(3, "resumed", "turn_completed", localISO(yesterday, 20), {
        promptId: "prompt-a",
        messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
      }),
      event(4, "resumed", "prompt_admitted", localISO(now, 0), {
        promptId: "prompt-b",
        message: { role: "user", content: "again" },
      }),
      event(5, "resumed", "turn_interrupted", localISO(now, 15), {
        promptId: "prompt-b",
        messages: [{ role: "assistant", content: [{ type: "text", text: "partial" }] }],
      }),
      event(6, "resumed", "prompt_admitted", localISO(now, 40), {
        promptId: "prompt-c",
        message: { role: "user", content: "unfinished" },
      }),
    ])

    await expect(calculateLocalStats({ sessionsRoot: root, now })).resolves.toMatchObject({
      sessionCount: 1,
      avgSessionSeconds: 35,
    })
  })

  it("returns zeros when no local sessions exist", async () => {
    const stats = await calculateLocalStats({
      sessionsRoot: join(await tempDirectory(), "missing"),
    })
    expect(stats).toMatchObject({
      streak: 0,
      totalTokens: 0,
      sessionCount: 0,
      avgTokensPerSession: 0,
      avgSessionSeconds: 0,
      activeDays: 0,
      promptTokens: 0,
      completionTokens: 0,
      promptCount: 0,
      todayPrompts: 0,
      todaySessions: 0,
      todayTokens: 0,
      activeDates: [],
      providers: [],
      modelUsage: {},
      todayTokensByModel: {},
    })
    expect(stats.recentActivity).toHaveLength(28)
    expect(stats.recentActivity?.every((day) => day.tokens === 0)).toBe(true)
  })

  it("measures execution rather than queue time, including interrupted turns and excluding idle gaps", async () => {
    const root = await tempDirectory()
    const day = new Date(2026, 6, 16, 12)
    const prompt = (promptId: string) => ({ promptId, message: { role: "user", content: "work" } })
    await writeTimeline(root, [
      { type: "prompt_admitted", at: localISO(day, 0), ...prompt("first") },
      { type: "turn_started", at: localISO(day, 10), promptId: "first" },
      { type: "prompt_admitted", at: localISO(day, 20), ...prompt("queued") },
      { type: "turn_completed", at: localISO(day, 70), promptId: "first", messages: [] },
      { type: "turn_started", at: localISO(day, 3_600), promptId: "queued" },
      { type: "turn_interrupted", at: localISO(day, 3_630), promptId: "queued", messages: [] },
      { type: "prompt_admitted", at: localISO(day, 3_640), ...prompt("unfinished") },
      { type: "turn_started", at: localISO(day, 3_650), promptId: "unfinished" },
    ])
    expect(await calculateLocalStats({ sessionsRoot: root, now: day })).toMatchObject({
      sessionCount: 1,
      avgSessionSeconds: 90,
    })
  })

  it("does not double count overlapping queued intervals in older sessions", async () => {
    const root = await tempDirectory()
    const day = new Date(2026, 6, 16, 12)
    await writeTimeline(root, [
      {
        type: "prompt_admitted",
        at: localISO(day, 0),
        promptId: "first",
        message: { role: "user", content: "first" },
      },
      {
        type: "prompt_admitted",
        at: localISO(day, 10),
        promptId: "next",
        message: { role: "user", content: "next" },
      },
      { type: "turn_completed", at: localISO(day, 60), promptId: "first", messages: [] },
      { type: "turn_completed", at: localISO(day, 90), promptId: "next", messages: [] },
    ])
    expect((await calculateLocalStats({ sessionsRoot: root, now: day })).avgSessionSeconds).toBe(90)
  })

  it("counts steering and usage on later days even before an ongoing turn finishes", async () => {
    const root = await tempDirectory()
    const day = (date: number, hour = 12) => new Date(2026, 6, date, hour).toISOString()
    await writeTimeline(root, [
      {
        type: "prompt_admitted",
        at: day(13, 23),
        promptId: "work",
        message: { role: "user", content: "work" },
      },
      { type: "turn_started", at: day(13, 23), promptId: "work" },
      {
        type: "prompt_steered",
        at: day(14),
        promptId: "work",
        message: { role: "user", content: "focus here" },
      },
      {
        type: "usage_recorded",
        at: day(15),
        purpose: "agent",
        promptId: "work",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    ])
    const stats = await calculateLocalStats({ sessionsRoot: root, now: new Date(2026, 6, 15, 13) })
    expect(stats).toMatchObject({ activeDays: 3, streak: 3, sessionCount: 1, totalTokens: 15 })
    expect(stats.recentActivity.filter((day) => day.tokens > 0)).toEqual([
      { date: "2026-07-15", tokens: 15 },
    ])
    expect(
      (await calculateLocalStats({ sessionsRoot: root, now: new Date(2026, 6, 16) })).streak,
    ).toBe(3)
    expect(
      (await calculateLocalStats({ sessionsRoot: root, now: new Date(2026, 6, 17) })).streak,
    ).toBe(0)
  })

  it.each([
    new Date(2026, 6, 13),
    new Date(2026, 2, 7),
    new Date(2026, 9, 31),
  ])("counts local calendar days across midnight and daylight-saving changes from %s", async (day) => {
    const root = await tempDirectory()
    const start = new Date(day)
    start.setHours(23)
    const end = new Date(day)
    end.setDate(end.getDate() + 2)
    end.setHours(1)
    await writeTimeline(root, [
      {
        type: "prompt_admitted",
        at: start.toISOString(),
        promptId: "work",
        message: { role: "user", content: "work" },
      },
      { type: "turn_started", at: start.toISOString(), promptId: "work" },
      { type: "turn_completed", at: end.toISOString(), promptId: "work", messages: [] },
    ])
    const stats = await calculateLocalStats({ sessionsRoot: root, now: end })
    expect(stats).toMatchObject({
      activeDays: 3,
      streak: 3,
      avgSessionSeconds: (end.getTime() - start.getTime()) / 1000,
    })
  })

  it("does not turn a legacy queue delay into days of activity", async () => {
    const root = await tempDirectory()
    await writeTimeline(root, [
      {
        type: "prompt_admitted",
        at: new Date(2026, 6, 10, 12).toISOString(),
        promptId: "queued",
        message: { role: "user", content: "work later" },
      },
      {
        type: "turn_completed",
        at: new Date(2026, 6, 16, 12).toISOString(),
        promptId: "queued",
        messages: [],
      },
    ])
    expect(
      await calculateLocalStats({ sessionsRoot: root, now: new Date(2026, 6, 16, 13) }),
    ).toMatchObject({
      activeDays: 2,
      streak: 1,
    })
  })
})

describe("achievements", () => {
  it("earns firsts once and repeatable ones each time, from sessions and the skill install", async () => {
    const root = await tempDirectory()
    const now = new Date(2026, 6, 16, 12, 0, 0)
    const at = (day: number, hour: number, minute = 0) =>
      new Date(2026, 6, day, hour, minute).toISOString()
    const document = {
      source: "published",
      artifactId: "0f9c2b7e-4c1d-4f2a-9b3e-1a2b3c4d5e6f",
      version: 1,
      sha256: "a".repeat(64),
      name: "plan.docx",
      kind: "docx",
      sourcePath: "/tmp/plan.docx",
    }
    // A night prompt whose turn ran ninety minutes and delegated, then published a document.
    await writeSession(root, "project-a", "night", [
      event(1, "night", "session_started", at(1, 1, 50), { version: 1 }),
      event(2, "night", "prompt_admitted", at(1, 2), {
        promptId: "p1",
        message: { role: "user", content: "hello" },
      }),
      event(3, "night", "turn_started", at(1, 2, 1), { promptId: "p1" }),
      event(4, "night", "usage_recorded", at(1, 2, 5), {
        purpose: "agent",
        promptId: "p1",
        provider: "local",
        model: "qwen",
        modelName: "Qwen",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
      event(5, "night", "turn_completed", at(1, 3, 31), {
        promptId: "p1",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_call", toolCall: { id: "call_1", name: "agent", arguments: "{}" } },
              { type: "tool_call", toolCall: { id: "call_2", name: "write", arguments: "{}" } },
            ],
          },
          { role: "tool", toolCallId: "call_1", content: "agent: Survey\n\nDone." },
          { role: "tool", toolCallId: "call_2", content: "written" },
          { role: "assistant", content: [{ type: "text", text: "hi" }] },
        ],
        subagents: [{ toolCallId: "call_1", title: "Survey", status: "complete", messages: [] }],
        toolActivities: [
          {
            toolCallId: "call_2",
            activityKind: "file_edit",
            label: "plan.docx",
            artifact: document,
          },
        ],
      }),
    ])
    // Early mornings from day 2: with day 1's night, a run of eight, a gap, then a run of seven.
    for (let day = 2; day <= 16; day += 1) {
      if (day === 9) continue
      await writeSession(root, "project-b", `dawn-${day}`, [
        event(1, `dawn-${day}`, "session_started", at(day, 4, 55), { version: 1 }),
        event(2, `dawn-${day}`, "prompt_admitted", at(day, 5), {
          promptId: "p",
          message: { role: "user", content: "morning" },
        }),
        event(3, `dawn-${day}`, "turn_completed", at(day, 5, 1), {
          promptId: "p",
          messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
        }),
      ])
    }

    const stats = await calculateLocalStats({
      sessionsRoot: root,
      now,
      skillInstalledAt: at(3, 9),
    })
    expect(stats.achievements).toEqual({
      "first-session": { at: at(1, 2), count: 1 },
      "local-model": { at: at(1, 2, 5), count: 1 },
      coworker: { at: at(1, 3, 31), count: 1 },
      document: { at: at(1, 3, 31), count: 1 },
      skill: { at: at(3, 9), count: 1 },
      "deep-work": { at: at(1, 3, 31), count: 1 },
      "night-owl": { at: at(1, 2), count: 1 },
      "early-bird": { at: at(2, 5), count: 14 },
      "week-streak": { at: new Date(2026, 6, 7).toISOString(), count: 2 },
    })
  })

  it("earns the workspace and active-day thresholds on the day they are crossed", async () => {
    const root = await tempDirectory()
    const now = new Date(2026, 8, 1, 12, 0, 0)
    for (let index = 0; index < 30; index += 1) {
      const day = new Date(2026, 6, 1 + index, 12, 0, 0)
      await writeSession(root, `project-${index % 11}`, `s${index}`, [
        event(1, `s${index}`, "session_started", localISO(day, -5), { version: 1 }),
        event(2, `s${index}`, "prompt_admitted", localISO(day, 0), {
          promptId: "p",
          message: { role: "user", content: "hi" },
        }),
      ])
    }
    const { achievements } = await calculateLocalStats({ sessionsRoot: root, now })
    // The tenth distinct workspace opens on the tenth day; the thirtieth active day is the last.
    expect(achievements["ten-workspaces"]).toEqual({
      at: localISO(new Date(2026, 6, 10), 0),
      count: 1,
    })
    expect(achievements["thirty-days"]).toEqual({
      at: new Date(2026, 6, 30).toISOString(),
      count: 1,
    })
    expect(achievements["week-streak"]?.count).toBe(4)
  })
})

async function writeTimeline(
  root: string,
  timeline: Array<{ type: string; at: string } & Record<string, unknown>>,
) {
  await writeSession(
    root,
    "project",
    "timeline",
    timeline.map(({ type, at, ...fields }, index) =>
      event(index + 1, "timeline", type, at, fields),
    ),
  )
}

describe.runIf(process.platform === "linux")("publishOmarchyUsage", () => {
  const original = process.env.XDG_STATE_HOME
  afterEach(() => {
    if (original === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = original
  })

  it("writes Otis' record for the agents bar panel in the shape the panel reads", async () => {
    const state = await tempDirectory()
    process.env.XDG_STATE_HOME = state
    await mkdir(join(state, "omarchy"))
    const root = await tempDirectory()
    const now = new Date(2026, 6, 16, 12, 0, 0)
    await writeSession(root, "project-a", "session-a", [
      event(1, "session-a", "session_started", localISO(now, -10), { version: 1 }),
      event(2, "session-a", "prompt_admitted", localISO(now, 0), {
        promptId: "prompt-a",
        message: { role: "user", content: "hello" },
      }),
      event(3, "session-a", "usage_recorded", localISO(now, 1), {
        purpose: "agent",
        promptId: "prompt-a",
        provider: "local",
        model: "openai/gpt-oss-20b",
        modelName: "gpt-oss 20B",
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }),
      event(4, "session-a", "turn_completed", localISO(now, 120), {
        promptId: "prompt-a",
        messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
      }),
    ])

    // The label follows what served usage, not the current selection.
    const file = await publishOmarchyUsage("fireworks", { sessionsRoot: root, now })
    expect(file).toBe(join(state, "omarchy", "agents", "usage", "otis.json"))
    expect((await stat(file as string)).mode & 0o777).toBe(0o600)
    const record = JSON.parse(await readFile(file as string, "utf8"))
    expect(record).toMatchObject({
      id: "otis",
      name: "Otis",
      ready: true,
      tierLabel: "Local",
      scope: "device",
      limits: [],
      todayPrompts: 1,
      todaySessions: 1,
      todayTotalTokens: 150,
      // Rows show the picker name; the panel prints its keys as given.
      todayTokensByModel: { "gpt-oss 20B": 150 },
      totalPrompts: 1,
      totalSessions: 1,
      activeDays: 1,
      activeDates: [localDateKey(now)],
      modelUsage: { "gpt-oss 20B": { inputTokens: 100, outputTokens: 50 } },
    })
    expect(record.recentDays).toHaveLength(7)
    expect(record.recentDays.at(-1)).toEqual({ date: localDateKey(now), messageCount: 150 })

    await writeSession(root, "project-a", "session-b", [
      event(1, "session-b", "session_started", localISO(now, -10), { version: 1 }),
      event(2, "session-b", "prompt_admitted", localISO(now, 0), {
        promptId: "prompt-b",
        message: { role: "user", content: "hello" },
      }),
      event(3, "session-b", "usage_recorded", localISO(now, 1), {
        purpose: "agent",
        promptId: "prompt-b",
        provider: "fireworks",
        model: "accounts/fireworks/models/glm",
        modelName: "GLM-5.3",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    ])
    // The same picker name on another server adds up under one row.
    await writeSession(root, "project-a", "session-c", [
      event(1, "session-c", "session_started", localISO(now, -10), { version: 1 }),
      event(2, "session-c", "prompt_admitted", localISO(now, 0), {
        promptId: "prompt-c",
        message: { role: "user", content: "hello" },
      }),
      event(3, "session-c", "usage_recorded", localISO(now, 1), {
        purpose: "agent",
        promptId: "prompt-c",
        provider: "omlx",
        model: "mlx-community/gpt-oss-20b",
        modelName: "gpt-oss 20B",
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      }),
    ])
    await publishOmarchyUsage(undefined, { sessionsRoot: root, now })
    expect(JSON.parse(await readFile(file as string, "utf8"))).toMatchObject({
      tierLabel: "Local + Hosted",
      todayTokensByModel: { "gpt-oss 20B": 180, "GLM-5.3": 15 },
      modelUsage: {
        "gpt-oss 20B": { inputTokens: 120, outputTokens: 60 },
        "GLM-5.3": { inputTokens: 10, outputTokens: 5 },
      },
    })
  })

  it("writes nothing on a machine without Omarchy", async () => {
    const state = await tempDirectory()
    process.env.XDG_STATE_HOME = state
    await expect(
      publishOmarchyUsage("fireworks", { sessionsRoot: await tempDirectory() }),
    ).resolves.toBeUndefined()
    await expect(stat(join(state, "omarchy"))).rejects.toThrow()
  })
})

function event(
  seq: number,
  sessionId: string,
  type: string,
  at: string,
  fields: Record<string, unknown>,
) {
  return JSON.stringify({ seq, sessionId, at, type, ...fields })
}

function localISO(day: Date, seconds: number) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0, seconds).toISOString()
}

function localDateKey(day: Date) {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`
}

async function writeSession(root: string, project: string, session: string, lines: string[]) {
  const directory = join(root, project)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${session}.jsonl`), `${lines.join("\n")}\n`, "utf8")
}

async function tempDirectory() {
  const path = await mkdtemp(join(tmpdir(), "otis-stats-"))
  tempDirectories.push(path)
  return path
}
