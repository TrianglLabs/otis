import { CalendarClock, ChevronLeft, ChevronRight, FolderOpen, Pencil, Plus } from "lucide-react"
import { useEffect, useState } from "react"
import type {
  ModelPickerItem,
  RoutineInput,
  RoutineRun,
  RoutineSchedule,
  RoutineStatus,
  SessionOpResult,
} from "../../../contracts.js"
import { Button, IconButton, Toggle } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { MatrixLoader } from "../../components/MatrixLoader.js"
import { TabStrip } from "../../components/TabStrip.js"
import { TextField } from "../../components/TextField.js"
import { formatAge } from "../../format.js"
import { useI18n } from "../../i18n/index.js"
import type { Translate } from "../../i18n/messages/en.js"
import { useDesktop, useDesktopState } from "../../runtime.js"

/** What a run's line says beyond its time; the mark and the dot already tell the rest. */
function describeRun(run: RoutineRun, locale: string, t: Translate) {
  return [
    t("routine.last", { when: formatAge(run.startedAt, locale) }),
    run.status === "interrupted" ? t("routine.stopped") : "",
    run.status === "error" ? t("routine.failed") : "",
    run.error ?? "",
  ]
    .filter(Boolean)
    .join(" · ")
}

/** A daily `HH:MM` as the locale writes the time of day. */
function formatTime(time: string, locale: string) {
  const [hours, minutes] = time.split(":").map(Number)
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(2026, 0, 1, hours, minutes),
  )
}

/** An interval in the larger unit that fits: "3 hours", "45 minutes". */
function duration(minutes: number, t: Translate) {
  return minutes % 60 === 0
    ? t("routine.hoursCount", { count: minutes / 60 })
    : t("routine.minutesCount", { count: minutes })
}

function scheduleLabel(schedule: RoutineSchedule, locale: string, t: Translate) {
  return schedule.kind === "interval"
    ? t("routine.every", { duration: duration(schedule.minutes, t) })
    : t("routine.dailyAt", { time: formatTime(schedule.time, locale) })
}

const HOURS_24 = Array.from({ length: 24 }, (_, hour) => hour)
const MINUTES = ["00", "15", "30", "45"]
/** Cards per page on the home screen, the New routine card among them. */
const ROUTINES_PAGE = 5
/** Interval presets in minutes; a saved value outside them is listed with them. */
const INTERVALS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]

/** A run that finished and has not been looked at yet. */
export const unseenRun = (routine: RoutineStatus) =>
  routine.lastRun?.finishedAt !== undefined && !routine.lastRun.seen

const blank = (cwd: string): RoutineInput => ({
  name: "",
  prompt: "",
  cwd,
  schedule: { kind: "daily", time: "09:00" },
  auto: false,
  enabled: true,
})

/**
 * The home screen's routines: one card per routine in the recents' style, a card to add one, and
 * the editor for the card that is open. A running routine shows the working mark and can be
 * watched live; a finished one opens its last run.
 */
export function RoutinesHome() {
  const { api } = useDesktop()
  const { locale, t } = useI18n()
  const state = useDesktopState("routines", "workspace")
  const [editing, setEditing] = useState<RoutineInput>()
  const [error, setError] = useState<string>()
  // Why a card had nothing to open: it has not run, or its run failed before it had a session.
  // Said once, then gone.
  const [notice, setNotice] = useState<string>()
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(undefined), 4000)
    return () => clearTimeout(timer)
  }, [notice])
  const [pageIndex, setPage] = useState(0)
  if (!state) return null
  const routines = state.routines
  const pages = Math.max(1, Math.ceil(routines.length / ROUTINES_PAGE))
  const page = Math.min(pageIndex, pages - 1)
  const shown = routines.slice(page * ROUTINES_PAGE, (page + 1) * ROUTINES_PAGE)
  // A time today reads as a time; a later one carries its day.
  const when = (iso: string) => {
    const date = new Date(iso)
    const today = date.toDateString() === new Date().toDateString()
    return new Intl.DateTimeFormat(locale, {
      ...(today ? {} : { month: "short", day: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
    }).format(date)
  }
  const act = async (run: () => Promise<SessionOpResult> | Promise<void>) => {
    setError(undefined)
    const result = await run()
    if (result && !result.ok) setError(result.reason)
    return !result || result.ok
  }
  const open = (routine: RoutineStatus) =>
    setEditing({
      id: routine.id,
      name: routine.name,
      prompt: routine.prompt,
      cwd: routine.cwd,
      schedule: routine.schedule,
      auto: routine.auto,
      enabled: routine.enabled,
    })
  // The saved routine behind the editor, if it is not a new one.
  const saved = editing && routines.find((entry) => entry.id === editing.id)

  return (
    <div className="home-recents">
      <span className="home-heading">
        {t("home.routines")}
        {pages > 1 ? (
          <span className="home-pager">
            <IconButton
              icon={ChevronLeft}
              label={t("home.previousPage")}
              size={22}
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            />
            {t("home.page", { page: page + 1, pages })}
            <IconButton
              icon={ChevronRight}
              label={t("home.nextPage")}
              size={22}
              disabled={page === pages - 1}
              onClick={() => setPage(page + 1)}
            />
          </span>
        ) : null}
      </span>
      <div className="home-grid home-grid-sessions">
        <button
          type="button"
          className="home-card home-card-add"
          onClick={() => setEditing(blank(state.workspace.path))}
        >
          <span className="home-cardTile">
            <Icon icon={Plus} size={15} />
          </span>
          <span className="home-cardText">
            <span className="home-cardTitle">{t("home.newRoutine")}</span>
            <span className="home-cardMeta">{t("home.newRoutineHint")}</span>
          </span>
        </button>
        {shown.map((routine) => {
          const running = routine.runtime !== undefined
          const last = routine.lastRun
          // The tile's dot: a hollow ring for a paused routine, red for a failed run, the accent
          // for a finished run not looked at yet.
          const dot = !routine.enabled
            ? "stateDot-paused"
            : last?.status === "error"
              ? "stateDot-failed"
              : unseenRun(routine)
                ? ""
                : undefined
          const grouped = editing?.id === routine.id
          const story = [
            last ? describeRun(last, locale, t) : t("routine.never"),
            !running && routine.nextRunAt
              ? t("routine.next", { when: when(routine.nextRunAt) })
              : "",
          ]
            .filter(Boolean)
            .join(" · ")
          // The card opens the run on now or the last one; the pencil opens its settings.
          const openRun = () => {
            setNotice(undefined)
            if (routine.runtime !== undefined) return void api.focusSession(routine.runtime)
            const run = routine.lastRun
            if (run?.sessionId)
              void act(() => api.openSessionAt(routine.cwd, run.sessionId as string, run.dirName))
            else setNotice(run ? describeRun(run, locale, t) : t("routine.notRunYet"))
          }
          return (
            <div
              key={routine.id}
              className={`home-card home-card-routine${grouped ? " home-card-grouped" : ""}`}
            >
              <button
                type="button"
                className="home-cardOpen"
                title={`${routine.prompt}\n${story}`}
                onClick={openRun}
              >
                <span className="home-cardTile">
                  {running ? <MatrixLoader /> : <Icon icon={CalendarClock} size={15} />}
                  {!running && dot !== undefined ? (
                    <span className={`stateDot home-cardDot ${dot}`} />
                  ) : null}
                </span>
                <span className="home-cardText">
                  <span className="home-cardTitle">{routine.name}</span>
                  <span className="home-cardMeta">
                    {routine.folder} · {scheduleLabel(routine.schedule, locale, t)}
                  </span>
                </span>
              </button>
              <IconButton
                icon={Pencil}
                label={t("routine.edit")}
                className="home-cardEdit"
                onClick={() => open(routine)}
              />
            </div>
          )
        })}
      </div>
      {editing ? (
        <RoutineEditor
          routine={editing}
          status={saved}
          onChange={setEditing}
          onClose={() => setEditing(undefined)}
          onSave={() =>
            void act(() => api.saveRoutine(editing)).then((ok) => ok && setEditing(undefined))
          }
          onDelete={() =>
            saved && void act(() => api.deleteRoutine(saved.id)).then(() => setEditing(undefined))
          }
          onRun={() => saved && void act(() => api.runRoutine(saved.id))}
          onStop={() => saved && void act(() => api.cancelRoutine(saved.id))}
          onWatch={(runtime) => void api.focusSession(runtime)}
          onPickFolder={() =>
            void api
              .pickWorkspaceFolder()
              .then((path) => path && setEditing({ ...editing, cwd: path }))
          }
        />
      ) : null}
      {error ? (
        <span className="home-error" role="alert">
          {error}
        </span>
      ) : notice ? (
        <span className="home-error home-notice" role="status">
          {notice}
        </span>
      ) : null}
    </div>
  )
}

/**
 * The editor as a sheet over the home screen, in the folder prompt's frame: a label above each
 * field, the schedule as a segmented control beside its time, and the two switches last. Saved
 * routines carry their run controls on the left of the actions.
 */
function RoutineEditor({
  routine,
  status,
  onChange,
  onClose,
  onSave,
  onDelete,
  onRun,
  onStop,
  onWatch,
  onPickFolder,
}: {
  routine: RoutineInput
  status: RoutineStatus | undefined
  onChange: (routine: RoutineInput) => void
  onClose: () => void
  onSave: () => void
  onDelete: () => void
  onRun: () => void
  onStop: () => void
  onWatch: (runtime: number) => void
  onPickFolder: () => void
}) {
  const { api } = useDesktop()
  const { locale, t } = useI18n()
  const { schedule } = routine
  const hour24 = schedule.kind === "daily" ? Number(schedule.time.slice(0, 2)) : 0
  const setHour = (hour: number) =>
    schedule.kind === "daily" &&
    onChange({
      ...routine,
      schedule: {
        kind: "daily",
        time: `${String(hour).padStart(2, "0")}${schedule.time.slice(2)}`,
      },
    })
  const ready = routine.name.trim() && routine.prompt.trim() && routine.cwd.trim()
  const title = status ? routine.name || status.name : t("home.newRoutine")
  // The models a run can be put on: the picker's rows that are available on this machine.
  const [models, setModels] = useState<ModelPickerItem[]>([])
  useEffect(() => {
    void api.listModels().then(setModels, () => setModels([]))
  }, [api])
  const choices = models.flatMap((item) =>
    item.kind === "model" && item.available
      ? [{ key: "selectionKey" in item ? item.selectionKey : item.id, label: item.displayName }]
      : [],
  )
  // The hour select follows the locale's clock: 1 to 12 with a day period, or 0 to 23.
  const twelveHour =
    new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12 === true
  const dayPeriods = [9, 21].map(
    (hour) =>
      new Intl.DateTimeFormat(locale, { hour: "numeric", hour12: true })
        .formatToParts(new Date(2026, 0, 1, hour))
        .find((part) => part.type === "dayPeriod")?.value ?? (hour < 12 ? "AM" : "PM"),
  )
  const hours = twelveHour ? [12, ...Array.from({ length: 11 }, (_, i) => i + 1)] : HOURS_24
  const last = status?.lastRun
  const summary = last && describeRun(last, locale, t)
  return (
    <>
      <button
        type="button"
        className="overlayBackdrop"
        aria-label={t("common.cancel")}
        onClick={onClose}
      />
      <div
        className="routineSheet noDrag"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose()
        }}
      >
        <h2 className="routineSheet-title">{title}</h2>
        {summary ? <p className="routineSheet-summary">{summary}</p> : null}
        <label className="routineSheet-label" htmlFor="routine-name">
          {t("routine.name")}
        </label>
        <TextField
          id="routine-name"
          icon={CalendarClock}
          value={routine.name}
          onChange={(event) => onChange({ ...routine, name: event.target.value })}
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
        <label className="routineSheet-label" htmlFor="routine-folder">
          {t("routine.folder")}
        </label>
        <div className="routineSheet-folder">
          <TextField
            id="routine-folder"
            icon={FolderOpen}
            value={routine.cwd}
            onChange={(event) => onChange({ ...routine, cwd: event.target.value })}
            spellCheck={false}
            autoComplete="off"
          />
          <Button size="sm" onClick={onPickFolder}>
            {t("routine.chooseFolder")}
          </Button>
        </div>
        <label className="routineSheet-label" htmlFor="routine-prompt">
          {t("routine.prompt")}
        </label>
        <textarea
          id="routine-prompt"
          className="field routineSheet-prompt"
          value={routine.prompt}
          rows={4}
          onChange={(event) => onChange({ ...routine, prompt: event.target.value })}
          spellCheck={false}
        />
        <span className="routineSheet-label">{t("routine.schedule")}</span>
        <div className="routineSheet-schedule">
          <TabStrip
            tabs={[
              ["daily", t("routine.daily")],
              ["interval", t("routine.interval")],
            ]}
            selected={schedule.kind}
            onSelect={(kind) =>
              onChange({
                ...routine,
                schedule: kind === "daily" ? { kind, time: "09:00" } : { kind, minutes: 60 },
              })
            }
          />
          {schedule.kind === "daily" ? (
            <div className="routineSheet-time">
              <select
                className="settingsSelect routineSheet-select"
                aria-label={t("routine.hour")}
                value={twelveHour ? hour24 % 12 || 12 : hour24}
                onChange={(event) => {
                  const picked = Number(event.target.value)
                  setHour(twelveHour ? (picked % 12) + (hour24 < 12 ? 0 : 12) : picked)
                }}
              >
                {hours.map((hour) => (
                  <option key={hour} value={hour}>
                    {twelveHour ? hour : String(hour).padStart(2, "0")}
                  </option>
                ))}
              </select>
              <span className="routineSheet-colon">:</span>
              <select
                className="settingsSelect routineSheet-select"
                aria-label={t("routine.minute")}
                value={schedule.time.slice(3)}
                onChange={(event) =>
                  onChange({
                    ...routine,
                    schedule: {
                      kind: "daily",
                      time: `${schedule.time.slice(0, 3)}${event.target.value}`,
                    },
                  })
                }
              >
                {MINUTES.map((minute) => (
                  <option key={minute} value={minute}>
                    {minute}
                  </option>
                ))}
              </select>
              {twelveHour ? (
                <select
                  className="settingsSelect routineSheet-select"
                  aria-label={t("routine.dayPeriod")}
                  value={hour24 < 12 ? 0 : 1}
                  onChange={(event) => setHour((hour24 % 12) + Number(event.target.value) * 12)}
                >
                  {dayPeriods.map((period, index) => (
                    <option key={period} value={index}>
                      {period}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          ) : (
            <select
              className="settingsSelect routineSheet-select routineSheet-select-interval"
              aria-label={t("routine.minutes")}
              value={schedule.minutes}
              onChange={(event) =>
                onChange({
                  ...routine,
                  schedule: { kind: "interval", minutes: Number(event.target.value) },
                })
              }
            >
              {(INTERVALS.includes(schedule.minutes)
                ? INTERVALS
                : [...INTERVALS, schedule.minutes].sort((a, b) => a - b)
              ).map((minutes) => (
                <option key={minutes} value={minutes}>
                  {duration(minutes, t)}
                </option>
              ))}
            </select>
          )}
        </div>
        <label className="routineSheet-label" htmlFor="routine-model">
          {t("routine.model")}
        </label>
        <select
          id="routine-model"
          className="settingsSelect routineSheet-model"
          value={routine.model ?? ""}
          onChange={(event) => onChange({ ...routine, model: event.target.value || undefined })}
        >
          <option value="">{t("routine.modelCurrent")}</option>
          {routine.model && !choices.some((choice) => choice.key === routine.model) ? (
            <option value={routine.model}>{routine.model}</option>
          ) : null}
          {choices.map((choice) => (
            <option key={choice.key} value={choice.key}>
              {choice.label}
            </option>
          ))}
        </select>
        <div className="routineSheet-switch">
          <Toggle
            label={t("routine.enabled")}
            checked={routine.enabled}
            onChange={(enabled) => onChange({ ...routine, enabled })}
          />
          <span>{t("routine.enabled")}</span>
        </div>
        <div className="routineSheet-switch">
          <Toggle
            label={t("routine.auto")}
            checked={routine.auto}
            onChange={(auto) => onChange({ ...routine, auto })}
          />
          <span>
            {t("routine.auto")}
            <span className="routineSheet-hint">{t("routine.autoHint")}</span>
          </span>
        </div>
        <div className="routineSheet-actions">
          {status ? (
            <>
              {status.runtime !== undefined ? (
                <>
                  <Button size="sm" onClick={() => onWatch(status.runtime as number)}>
                    {t("routine.watch")}
                  </Button>
                  <Button size="sm" onClick={onStop}>
                    {t("routine.stop")}
                  </Button>
                </>
              ) : (
                <Button size="sm" onClick={onRun}>
                  {t("routine.run")}
                </Button>
              )}
              <Button size="sm" variant="danger" onClick={onDelete}>
                {t("routine.delete")}
              </Button>
            </>
          ) : null}
          <span className="routineSheet-spacer" />
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" size="sm" disabled={!ready} onClick={onSave}>
            {t("common.save")}
          </Button>
        </div>
      </div>
    </>
  )
}
