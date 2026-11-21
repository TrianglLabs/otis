import {
  FolderSearch,
  Globe,
  Maximize2,
  MessagesSquare,
  PenLine,
  Pin,
  RotateCcw,
  Shield,
  X,
} from "lucide-react"
import {
  type DragEvent,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import type { GlobalSessionPickerItem } from "../../../../app/global-sessions.js"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import type { PaneDrop, PaneSide, PendingPermission, SessionOpResult } from "../../../contracts.js"
import { Button } from "../../components/Button.js"
import { FileTypeIcon } from "../../components/FileTypeIcon.js"
import { Icon } from "../../components/Icon.js"
import { MatrixLoader } from "../../components/MatrixLoader.js"
import { OtisMark } from "../../components/OtisMark.js"
import { formatAge, formatSessionDetail, formatTokenCount, inView } from "../../format.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopSelector, useDesktopState } from "../../runtime.js"
import type { HomeView } from "../../shell/WorkspaceHeader.js"
import { PaneRuntimeContext, useOpenCanvas } from "../canvas/canvas-context.js"
import { FindBar, useFind } from "../canvas/find.js"
import { ProjectsHome } from "../projects/ProjectsHome.js"
import { RoutinesHome } from "../routines/RoutinesHome.js"
import { Composer } from "./Composer.js"
import { TranscriptList } from "./TranscriptList.js"

const emptyEntries: TranscriptEntry[] = []
/**
 * A Mermaid fence as CommonMark reads it: three or more backticks or tildes, closed by a run of
 * the same character at least as long, with no info string. The fence's indentation is taken off
 * each content line.
 */
const MERMAID_FENCE =
  /^([ \t]*)(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*\n([\s\S]*?)\n[ \t]*\2[`~]*[ \t]*$/gim
const noDiffs = { added: 0, removed: 0 }
const emptyPanes: number[] = []
/** The fraction of the conversation's width or height, from each edge, that inserts a session. */
const DROP_BAND = 0.18

/**
 * The drag ghost is a styled clone rather than the browser's snapshot, which paints whatever
 * surrounds the element inside its box: the card behind a header, the drop ring under the pointer.
 */
export function liftGhost(event: DragEvent<HTMLElement>) {
  const source = event.currentTarget
  const ghost = source.cloneNode(true) as HTMLElement
  ghost.classList.add("dragGhost")
  ghost.style.width = `${source.offsetWidth}px`
  document.body.append(ghost)
  event.dataTransfer.setDragImage(ghost, event.nativeEvent.offsetX, event.nativeEvent.offsetY)
  requestAnimationFrame(() => ghost.remove())
}

/** The drag payload of a session chip or card header: its runtime id, dropped onto a half. */
export const RUNTIME_DRAG_TYPE = "application/x-otis-runtime"
/** The drag payload of a palette row: the session's id and store, dropped like a chip. */
export const SESSION_DRAG_TYPE = "application/x-otis-session"

/**
 * The active session's pane, and beside it a second one when a session chip was dropped onto a
 * half: two cards then, the active one lit, over the one composer. A click on a card makes it the
 * active session; the card's × takes it out of the split.
 */
export const ConversationView = memo(function ConversationView({
  installing = false,
  homeView,
  onHomeView,
  findFocus,
}: {
  installing?: boolean
  homeView: HomeView
  onHomeView: (view: HomeView) => void
  /** When find in session was last asked for; a change opens the active pane's find bar. */
  findFocus?: number
}) {
  const { api, store } = useDesktop()
  const state = useDesktopSelector((snapshot) => ({
    focused: snapshot?.runtimes.find((entry) => entry.focused)?.runtime,
    panes: snapshot?.panes ?? emptyPanes,
    axis: snapshot?.paneAxis ?? "row",
    // The home gallery already marks the open sessions.
    home:
      (snapshot?.entries.length ?? 0) === 0 &&
      !snapshot?.permission &&
      (snapshot?.panes.length ?? 1) === 1,
  }))
  // A drop lands in an edge band of the conversation, which puts the session on that side, or on
  // a card, which puts it in that card's place.
  const [drop, setDrop] = useState<PaneDrop>()
  // Why the last dropped palette row, or the last branch, was refused, until the next one.
  const [refused, setRefused] = useState<string>()
  // Branching reads the pane's session when clicked, so no row subscribes to runtime changes.
  const branch = useCallback(
    (runtime: number, turnSeq: number) => {
      const session = store.getState()?.runtimes.find((entry) => entry.runtime === runtime)?.session
      if (!session) return
      void api
        .forkSession(session.id, session.dirName, turnSeq)
        .then((result) => setRefused(result.ok ? undefined : result.reason))
    },
    [api, store],
  )
  const dropOf = (event: DragEvent<HTMLDivElement>): PaneDrop => {
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - left) / width
    const y = (event.clientY - top) / height
    const edges: [PaneSide, number][] = [
      ["left", x],
      ["right", 1 - x],
      ["top", y],
      ["bottom", 1 - y],
    ]
    const [side, distance] = edges.reduce((near, edge) => (edge[1] < near[1] ? edge : near))
    const card = (event.target as Element).closest<HTMLElement>("[data-runtime]")
    if (distance < DROP_BAND || !card) return { side }
    return { replace: Number(card.dataset.runtime) }
  }
  const { home, panes } = state
  // Home's starters put their prompt in the composer through this.
  const compose = useRef<(text: string) => void>(undefined)
  const layout =
    panes.length === 1
      ? ""
      : panes.length === 2
        ? ` conversationPanes-split conversationPanes-${state.axis}`
        : ` conversationPanes-split conversationPanes-grid${panes.length === 3 ? " conversationPanes-3" : ""}`
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the drop target is the panes' shared surface; the chips are the keyboard path.
    <div
      className={`conversationArea${home ? " conversationArea-hero" : ""}`}
      onDragOver={(event) => {
        const { types } = event.dataTransfer
        if (!types.includes(RUNTIME_DRAG_TYPE) && !types.includes(SESSION_DRAG_TYPE)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "move"
        setDrop(dropOf(event))
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(undefined)
      }}
      onDrop={(event) => {
        setDrop(undefined)
        const runtime = Number(event.dataTransfer.getData(RUNTIME_DRAG_TYPE))
        const session = event.dataTransfer.getData(SESSION_DRAG_TYPE)
        if (!runtime && !session) return
        event.preventDefault()
        const target = dropOf(event)
        if (session) {
          const { id, dirName } = JSON.parse(session)
          void api
            .selectSession(id, dirName, target)
            .then((result) => setRefused(result.ok ? undefined : result.reason))
        } else if ("side" in target) void api.openPane(runtime, target.side)
        else void api.replacePane(target.replace, runtime)
      }}
    >
      <div className={`conversationPanes${layout}`}>
        {panes.map((runtime) => (
          <ConversationPane
            key={runtime}
            runtime={runtime}
            active={runtime === state.focused}
            split={panes.length > 1}
            dropTarget={drop !== undefined && "replace" in drop && drop.replace === runtime}
            findFocus={findFocus}
            onBranch={branch}
          />
        ))}
        {drop && "side" in drop ? (
          <div className={`conversationDrop conversationDrop-${drop.side}`} />
        ) : null}
      </div>
      <div className="composerWrap">
        {refused ? (
          <div className="composer-hint">
            <span className="composer-error" role="alert">
              {refused}
            </span>
          </div>
        ) : null}
        {home ? null : <SessionStrip />}
        <Composer installing={installing} composeRef={compose} />
      </div>
      {/* The home screen keeps its headline and composer in place across its views; only what
          sits below them changes. */}
      {home ? (
        <div className="homeBelow">
          {homeView === "routines" ? (
            <RoutinesHome />
          ) : homeView === "projects" ? (
            <ProjectsHome onHome={() => onHomeView("home")} />
          ) : (
            <HomeNext composeRef={compose} />
          )}
        </div>
      ) : null}
    </div>
  )
})

/**
 * One session's transcript. Alone it fills the column and shows the home screen when empty; in a
 * split it is a card with a header naming its session, and an empty one is simply empty. The
 * header drags like the session's chip, so dropping it on an edge moves the card there. The
 * approval card sits in the pane of the session that asked, else in the active one.
 */
const ConversationPane = memo(function ConversationPane({
  runtime,
  active,
  split,
  dropTarget,
  findFocus,
  onBranch,
}: {
  runtime: number
  active: boolean
  split: boolean
  /** A dragged session hovering over this card would take its place. */
  dropTarget: boolean
  findFocus: number | undefined
  onBranch: (runtime: number, turnSeq: number) => void
}) {
  const { api } = useDesktop()
  const branch = useCallback((turnSeq: number) => onBranch(runtime, turnSeq), [onBranch, runtime])
  const { locale, t } = useI18n()
  const state = useDesktopSelector((snapshot) => {
    const own = snapshot?.runtimes.find((entry) => entry.runtime === runtime)
    const permission = snapshot?.permission ?? null
    const asked = permission?.runtime === runtime
    const elsewhere = active && permission !== null && !snapshot?.panes.includes(permission.runtime)
    return {
      entries: (active ? snapshot?.entries : snapshot?.transcripts[runtime]) ?? emptyEntries,
      busy: own?.busy ?? false,
      unseen: own?.unseen ?? false,
      title: own?.session?.title ?? t("session.new"),
      diffs: own?.diffs ?? noDiffs,
      contextTokens: own?.contextTokens ?? 0,
      contextLimit: snapshot?.contextLimit ?? 0,
      // A fresh session in the same runtime remounts the list; a move of focus does not.
      listKey: `${runtime}:${(active ? snapshot?.session : own?.session)?.id ?? ""}`,
      thinkingVisible: snapshot?.thinkingVisible ?? false,
      permission: permission && (asked || elsewhere) ? permission : null,
      waiting: snapshot?.permissionQueue ?? 0,
    }
  })
  // Find in session: ⌘F opens the bar over the active pane's transcript and hands focus back
  // where it came from on close. Every pane sees the request; only the active one with something
  // to search acts on it, and a new session in the pane starts without the bar.
  const finder = useFind()
  const findReturn = useRef<Element | null>(null)
  const seenFindFocus = useRef(findFocus)
  const searchable = active && state.entries.length > 0
  useEffect(() => {
    const previous = seenFindFocus.current
    seenFindFocus.current = findFocus
    if (findFocus === undefined || findFocus === previous || !searchable) return
    if (!finder.finding) findReturn.current = document.activeElement
    finder.open()
  }, [findFocus, searchable, finder.finding, finder.open])
  useEffect(() => finder.close(), [state.listKey, finder.close])
  // A reply's last Mermaid diagram takes the Canvas when the reply finishes, as a written document
  // does. A reply is live when it is seen streaming, or arrives while the pane is working after
  // the session's entries were first seen here; a session opened mid-run opens nothing from its
  // finished replies. Each live reply opens once.
  const openCanvas = useOpenCanvas()
  const replies = useRef({ listKey: "", live: new Map<number, boolean>() })
  useEffect(() => {
    const first = replies.current.listKey !== state.listKey
    if (first) replies.current = { listKey: state.listKey, live: new Map() }
    const { live } = replies.current
    for (const entry of state.entries) {
      if (entry.kind !== "message" || entry.speaker !== "Otis") continue
      if (!live.has(entry.id))
        live.set(entry.id, entry.streaming === true || (!first && state.busy))
      if (entry.streaming || !live.get(entry.id)) continue
      live.set(entry.id, false)
      const fence = [...entry.text.matchAll(MERMAID_FENCE)].at(-1)
      if (!fence) continue
      const indent = fence[1].length
      const source = fence[3]
        .split("\n")
        .map((line) => line.slice(Math.min(indent, line.length - line.trimStart().length)))
        .join("\n")
      if (source.trim()) openCanvas?.(source)
    }
  }, [state.entries, state.listKey, state.busy, openCanvas])
  const closeFind = () => {
    finder.close()
    if (findReturn.current instanceof HTMLElement) findReturn.current.focus()
  }
  // Mounting straight into a split is the card that just opened; it settles in.
  const [entered] = useState(split)
  const footer = useMemo(
    () =>
      state.permission ? (
        <PermissionCard
          permission={state.permission}
          foreign={state.permission.runtime !== runtime}
          waiting={state.waiting}
          onRespond={(id, allow) => void api.respondToPermission(id, allow)}
        />
      ) : null,
    [state.permission, state.waiting, runtime, api],
  )
  const cardClass = split
    ? ` pane-card${active ? " pane-card-active" : ""}${entered ? " pane-card-enter" : ""}`
    : ""

  const className = `conversation${cardClass}${state.busy ? " conversation-busy" : ""}${
    dropTarget ? " conversation-dropTarget" : ""
  }`
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click anywhere in a card makes it the active session; its header button is the keyboard path.
    <div
      className={className}
      data-runtime={runtime}
      onMouseDown={() => {
        if (split && !active) void api.focusSession(runtime)
      }}
    >
      {split ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: the header is the card's drag handle; the strip chips are the keyboard path.
        <div
          className="paneHead"
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(RUNTIME_DRAG_TYPE, String(runtime))
            event.dataTransfer.effectAllowed = "move"
            liftGhost(event)
          }}
        >
          <span className="paneHead-lead">
            {state.busy ? (
              <MatrixLoader title={t("session.working")} />
            ) : (
              <Icon icon={MessagesSquare} size={13} className="paneHead-glyph" />
            )}
            {!state.busy && state.unseen ? (
              <span className="stateDot" title={t("session.finished")} />
            ) : null}
            <button
              type="button"
              className="iconBtn paneHead-close noDrag"
              title={t("pane.close")}
              aria-label={t("pane.close")}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void api.closePane(runtime)}
            >
              <Icon icon={X} size={12} />
            </button>
          </span>
          <span className="paneHead-title">{state.title}</span>
          <button
            type="button"
            className="iconBtn paneHead-solo noDrag"
            title={t("pane.solo")}
            aria-label={t("pane.solo")}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void api.soloPane(runtime)}
          >
            <Icon icon={Maximize2} size={11} />
          </button>
          <span className="paneHead-meta">
            {state.diffs.added + state.diffs.removed > 0 ? (
              <span className="headerDiff" title={t("header.linesChanged")}>
                <span className="headerDiff-add">+{state.diffs.added}</span>
                <span className="headerDiff-remove">−{state.diffs.removed}</span>
              </span>
            ) : null}
            {state.entries.length > 0 ? (
              <span
                className="contextMeter"
                title={t("header.contextTokens", {
                  used: state.contextTokens.toLocaleString(locale),
                  limit: state.contextLimit.toLocaleString(locale),
                })}
              >
                <span className="contextMeter-track">
                  <span
                    className="contextMeter-fill"
                    style={{
                      width: `${Math.min(100, Math.round((state.contextTokens / Math.max(1, state.contextLimit)) * 100))}%`,
                    }}
                  />
                </span>
                <span className="contextMeter-text">{formatTokenCount(state.contextTokens)}</span>
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
      {finder.finding ? (
        <FindBar
          find={finder}
          label={t("transcript.find")}
          placeholder={t("transcript.findPlaceholder")}
          onClose={closeFind}
          className="noDrag"
        />
      ) : null}
      {!split && state.entries.length === 0 && !state.permission ? (
        <EmptyState />
      ) : (
        <PaneRuntimeContext.Provider value={runtime}>
          <TranscriptList
            key={state.listKey}
            entries={state.entries}
            busy={state.busy}
            thinkingVisible={state.thinkingVisible}
            footer={footer}
            find={finder.request}
            onFindCount={finder.setMatchCount}
            rail={!split}
            onBranch={branch}
          />
        </PaneRuntimeContext.Provider>
      )}
    </div>
  )
})

/**
 * The open sessions not on screen, over the composer, in opening order, each carrying its state
 * as a dot. A click shows one in place of the active session; a drag onto a half of the
 * conversation opens it there.
 */
export const SessionStrip = memo(function SessionStrip() {
  const { api } = useDesktop()
  const { t } = useI18n()
  const state = useDesktopState("runtimes", "panes")
  const hidden = state?.runtimes.filter((runtime) => !state.panes.includes(runtime.runtime)) ?? []
  if (hidden.length === 0) return null
  return (
    <nav className="sessionStrip noDrag" aria-label={t("session.open")}>
      {hidden.map((runtime) => (
        <button
          key={runtime.runtime}
          type="button"
          className="sessionStrip-chip"
          title={runtime.session?.title ?? t("session.new")}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(RUNTIME_DRAG_TYPE, String(runtime.runtime))
            event.dataTransfer.effectAllowed = "move"
            liftGhost(event)
          }}
          onClick={() => void api.focusSession(runtime.runtime)}
        >
          {runtime.busy ? (
            <MatrixLoader title={t("session.working")} />
          ) : runtime.unseen ? (
            <span className="stateDot" title={t("session.finished")} />
          ) : null}
          <span className="sessionStrip-title">{runtime.session?.title ?? t("session.new")}</span>
        </button>
      ))}
    </nav>
  )
})

// Home's headline by the part of the day, one of two alternating by date.
const GREETINGS = {
  morning: ["home.greeting.morning", "home.greeting.morning2"],
  afternoon: ["home.greeting.afternoon", "home.greeting.afternoon2"],
  evening: ["home.greeting.evening", "home.greeting.evening2"],
  night: ["home.greeting.night", "home.greeting.night2"],
} as const

/**
 * The top of a quiet home screen: the mark and a headline, or the setup guidance while no model is
 * configured. The composer follows, then Home's next steps, its projects, or its routines.
 */
function EmptyState() {
  const { t } = useI18n()
  const state = useDesktopState("modelState")
  // Picked when Home opens, so it never changes while on screen.
  const [greeting] = useState(() => {
    const now = new Date()
    const hour = now.getHours()
    const part =
      hour < 5
        ? "night"
        : hour < 12
          ? "morning"
          : hour < 17
            ? "afternoon"
            : hour < 22
              ? "evening"
              : "night"
    const day = Math.floor(now.getTime() / 86_400_000 - now.getTimezoneOffset() / 1440)
    return GREETINGS[part][day % 2]
  })
  if (!state) return null
  return (
    <div className="home">
      <OtisMark className="home-logo" solvable />
      {/* A model that could not start is reported once, at the composer. */}
      {state.modelState === "unconfigured" ? (
        <div className="home-setup">
          <p>{t("home.noModel")}</p>
          <p className="home-setupHint">{t("home.setupHint")}</p>
        </div>
      ) : (
        <h1 className="home-greeting">{t(greeting)}</h1>
      )}
    </div>
  )
}

/**
 * One of Home's next steps: what it shows, its full text where the label may be cut, the session
 * it opens, and what choosing it does.
 */
type NextStep = {
  key: string
  icon: ReactNode
  label: ReactNode
  title?: string
  hint?: string
  session?: GlobalSessionPickerItem
  run: () => void
}

/**
 * Home's next steps, under the composer, rebuilt from live state as it changes: first what needs
 * you (a session working, one that finished out of view, one interrupted), then pinned sessions
 * and the latest work, up to three; starters fill the list to four, each putting a prompt in the
 * composer to finish.
 */
function HomeNext({ composeRef }: { composeRef: RefObject<((text: string) => void) | undefined> }) {
  const { api } = useDesktop()
  const { locale, t } = useI18n()
  const state = useDesktopState("sessions", "recentArtifacts")
  const [error, setError] = useState<string>()
  // Hovering a session lights the others it was last on screen with; opening it brings them.
  const [hovered, setHovered] = useState<GlobalSessionPickerItem>()
  if (!state) return null
  const open = async (run: () => Promise<SessionOpResult>) => {
    setError(undefined)
    const result = await run()
    if (!result.ok) setError(result.reason)
  }
  // The verb stays quiet and the session or file it names reads in full, in any word order.
  const phrase = (key: Parameters<typeof t>[0], name: "title" | "name", value: string) => {
    const [before, after] = t(key, { [name]: "\u0000" }).split("\u0000")
    return {
      label: (
        <>
          {before}
          <span className="homeNext-subject">{value}</span>
          {after}
        </>
      ),
      title: t(key, { [name]: value }),
    }
  }
  const shown = new Set<GlobalSessionPickerItem>()
  const sessionStep = (
    session: GlobalSessionPickerItem,
    key: Parameters<typeof t>[0],
    icon: ReactNode,
    hint = formatSessionDetail(session.detail, locale),
  ): NextStep => {
    shown.add(session)
    return {
      key: `${session.dirName}:${session.id}`,
      icon,
      ...phrase(key, "title", session.title),
      hint,
      session,
      run: () => void open(() => api.selectSession(session.id, session.dirName)),
    }
  }
  const pick = (test: (session: GlobalSessionPickerItem) => boolean | undefined) =>
    state.sessions.filter((session) => !session.active && !shown.has(session) && test(session))
  const steps: NextStep[] = [
    ...pick((session) => session.working).map((session) =>
      sessionStep(
        session,
        "home.next.working",
        <MatrixLoader title={t("session.working")} />,
        t("session.working"),
      ),
    ),
    ...pick((session) => session.unseen).map((session) =>
      sessionStep(
        session,
        "home.next.review",
        <span className="stateDot" />,
        t("session.finished"),
      ),
    ),
    ...pick((session) => session.resumable).map((session) =>
      sessionStep(session, "home.next.resume", <Icon icon={RotateCcw} size={14} />),
    ),
    ...pick((session) => session.pinned).map((session) =>
      sessionStep(session, "home.next.continue", <Icon icon={Pin} size={14} />),
    ),
    ...state.recentArtifacts.slice(0, 1).map((document) => {
      const { label, title } = phrase("home.next.open", "name", document.name)
      // The document's opening line says what it is about.
      const opening = document.reference.excerpt?.split("\n").find((line) => line.trim())
      return {
        key: `document:${document.reference.artifactId}`,
        icon: <FileTypeIcon kind={document.kind} name={document.name} size="xs" />,
        label,
        title: opening ? `${title} — ${opening}` : title,
        hint: formatAge(document.updatedAt, locale),
        run: () =>
          void open(async () => {
            const opened = await api.selectSession(document.sessionId, document.dirName)
            return opened.ok ? api.openArtifact(document.reference) : opened
          }),
      }
    }),
    ...pick(() => true)
      .slice(0, 1)
      .map((session) =>
        sessionStep(session, "home.next.continue", <Icon icon={MessagesSquare} size={14} />),
      ),
  ].slice(0, 3)
  const rows: NextStep[] = [
    ...steps,
    ...(
      [
        [Globe, "home.next.web", "home.next.webPrompt"],
        [PenLine, "home.next.write", "home.next.writePrompt"],
        [FolderSearch, "home.next.explain", "home.next.explainPrompt"],
      ] as const
    ).map(([icon, label, prompt]) => ({
      key: label,
      icon: <Icon icon={icon} size={14} />,
      label: t(label),
      run: () => composeRef.current?.(t(prompt)),
    })),
  ].slice(0, 4)

  return (
    <div className="homeNext">
      {rows.map(({ key, icon, label, title, hint, session, run }) => (
        <button
          key={key}
          type="button"
          className={
            session && inView(hovered, session)
              ? "homeNext-row homeNext-row-grouped"
              : "homeNext-row"
          }
          title={title}
          onMouseEnter={session && (() => setHovered(session))}
          onMouseLeave={session && (() => setHovered(undefined))}
          onClick={run}
        >
          <span className="homeNext-icon">{icon}</span>
          <span className="homeNext-label">{label}</span>
          {hint ? <span className="homeNext-hint">{hint}</span> : null}
        </button>
      ))}
      {error ? (
        <span className="home-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Inline approval request pinned to the end of the transcript. Replies reference the request id, so
 * a request that was cancelled or superseded in the main process cannot be approved by a stale
 * card. The head of the shared queue shows whichever session asked; a request from a session other
 * than the one on screen names it.
 */
function PermissionCard({
  permission,
  foreign,
  waiting,
  onRespond,
}: {
  permission: PendingPermission
  foreign: boolean
  waiting: number
  onRespond: (id: number, allow: boolean) => void
}) {
  const { t } = useI18n()
  const titleId = useId()
  const descriptionId = useId()
  const showLabel = permission.kind !== "shell" || permission.resources.length === 0

  return (
    <div
      className="permissionCard"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <div className="permissionCard-head">
        <span className="permissionCard-icon">
          <Icon icon={Shield} size={14} />
        </span>
        <div className="permissionCard-title" id={titleId}>
          {t("permission.title")}
        </div>
        {foreign ? <span className="permissionCard-session">{permission.sessionTitle}</span> : null}
        {waiting > 0 ? (
          <span className="permissionCard-waiting">
            {t("permission.waiting", { count: String(waiting) })}
          </span>
        ) : null}
      </div>
      <div className="permissionCard-detail" id={descriptionId}>
        {showLabel ? <div className="permissionCard-label">{permission.label}</div> : null}
        {permission.resources.length > 0 ? (
          <ul
            className="permissionCard-resources"
            aria-label={t("permission.resources")}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable request details must be keyboard reachable.
            tabIndex={0}
          >
            {permission.resources.map((resource, index) => (
              <li key={`${index}:${resource}`}>
                <code>{resource}</code>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="permissionCard-actions">
        <Button size="sm" onClick={() => onRespond(permission.id, false)}>
          {t("permission.deny")}
        </Button>
        <Button variant="primary" size="sm" onClick={() => onRespond(permission.id, true)}>
          {t("permission.allowOnce")}
        </Button>
      </div>
    </div>
  )
}
