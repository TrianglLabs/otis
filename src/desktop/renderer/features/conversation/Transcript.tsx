import { Maximize2, MessagesSquare, Shield, X } from "lucide-react"
import { type DragEvent, memo, useId, useMemo, useState } from "react"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import type { PaneDrop, PaneSide, PendingPermission, SessionOpResult } from "../../../contracts.js"
import { Button } from "../../components/Button.js"
import { FileTypeIcon } from "../../components/FileTypeIcon.js"
import { Icon } from "../../components/Icon.js"
import { OtisMark } from "../../components/OtisMark.js"
import { formatAge, formatSessionDetail, formatTokenCount, inView } from "../../format.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopSelector, useDesktopState } from "../../runtime.js"
import { PaneRuntimeContext } from "../canvas/canvas-context.js"
import { Composer } from "./Composer.js"
import { TranscriptList } from "./TranscriptList.js"

const emptyEntries: TranscriptEntry[] = []
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
}: {
  installing?: boolean
}) {
  const { api } = useDesktop()
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
  // Why the last dropped palette row was refused, until the next drop.
  const [refused, setRefused] = useState<string>()
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
  const layout =
    panes.length === 1
      ? ""
      : panes.length === 2
        ? ` conversationPanes-split conversationPanes-${state.axis}`
        : ` conversationPanes-split conversationPanes-grid${panes.length === 3 ? " conversationPanes-3" : ""}`
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the drop target is the panes' shared surface; the chips are the keyboard path.
    <div
      className="conversationArea"
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
        <Composer installing={installing} />
      </div>
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
}: {
  runtime: number
  active: boolean
  split: boolean
  /** A dragged session hovering over this card would take its place. */
  dropTarget: boolean
}) {
  const { api } = useDesktop()
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
      diffs: own?.diffs ?? { added: 0, removed: 0 },
      contextTokens: own?.contextTokens ?? 0,
      contextLimit: snapshot?.contextLimit ?? 0,
      // A fresh session in the same runtime remounts the list; a move of focus does not.
      listKey: `${runtime}:${(active ? snapshot?.session : own?.session)?.id ?? ""}`,
      thinkingVisible: snapshot?.thinkingVisible ?? false,
      permission: permission && (asked || elsewhere) ? permission : null,
      waiting: snapshot?.permissionQueue ?? 0,
    }
  })
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

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click anywhere in a card makes it the active session; its header button is the keyboard path.
    <div
      className={`conversation${cardClass}${dropTarget ? " conversation-dropTarget" : ""}`}
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
            <Icon icon={MessagesSquare} size={13} className="paneHead-glyph" />
            {state.busy ? (
              <span className="stateDot stateDot-working" title={t("session.working")} />
            ) : state.unseen ? (
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
            <span className="stateDot stateDot-working" title={t("session.working")} />
          ) : runtime.unseen ? (
            <span className="stateDot" title={t("session.finished")} />
          ) : null}
          <span className="sessionStrip-title">{runtime.session?.title ?? t("session.new")}</span>
        </button>
      ))}
    </nav>
  )
})

const RECENT_SESSIONS = 4

/**
 * A quiet home screen centered on the brand mark: the current setup in one line, sessions to pick
 * up first, then recent sessions by workspace and recent Canvas documents. First run — no history
 * anywhere — shows only the mark and any setup guidance.
 */
function EmptyState() {
  const { api } = useDesktop()
  const { locale, t } = useI18n()
  const state = useDesktopState("sessions", "recentArtifacts", "modelState", "modelError")
  const [error, setError] = useState<string>()
  if (!state) return null
  const documents = state.recentArtifacts

  const recents = state.sessions.filter((session) => !session.active).slice(0, RECENT_SESSIONS)
  // Hovering a session lights the others it was last on screen with; opening it brings them.
  const [hovered, setHovered] = useState<(typeof recents)[number]>()
  const open = async (run: () => Promise<SessionOpResult>) => {
    setError(undefined)
    const result = await run()
    if (!result.ok) setError(result.reason)
  }
  const firstRun = recents.length === 0 && documents.length === 0

  return (
    <div className="home">
      <div className="home-center">
        <OtisMark className="home-logo" />
        {state.modelState === "failed" ? (
          <div className="home-setup">
            <p>
              {t("home.modelFailed", { detail: state.modelError ? `: ${state.modelError}` : "." })}
            </p>
            <p className="home-setupHint">{t("home.pickDifferent")}</p>
          </div>
        ) : state.modelState === "unconfigured" ? (
          <div className="home-setup">
            <p>{t("home.noModel")}</p>
            <p className="home-setupHint">{t("home.setupHint")}</p>
          </div>
        ) : null}
      </div>
      {firstRun ? null : (
        <div className="home-gallery">
          {recents.map((session) => (
            <button
              key={`${session.dirName}:${session.id}`}
              type="button"
              className={`home-tile${inView(hovered, session) ? " home-tile-grouped" : ""}`}
              title={session.title}
              onMouseEnter={() => setHovered(session)}
              onMouseLeave={() => setHovered(undefined)}
              onClick={() => void open(() => api.selectSession(session.id, session.dirName))}
            >
              <span className="home-tileHead">
                <span className="home-tileIcon">
                  <Icon icon={MessagesSquare} size={16} />
                  {session.working ? (
                    <span className="stateDot stateDot-working home-tileDot" />
                  ) : session.unseen || session.resumable ? (
                    <span className="stateDot home-tileDot" />
                  ) : null}
                </span>
                <span className="home-tileAge">{formatSessionDetail(session.detail, locale)}</span>
              </span>
              <span className="home-tileName">{session.title}</span>
              <span className="home-tileWorkspace">{session.workspaceLabel}</span>
            </button>
          ))}
          {documents.map((document) => (
            <button
              key={document.reference.artifactId}
              type="button"
              className="home-tile"
              title={document.name}
              onClick={() =>
                void open(async () => {
                  const opened = await api.selectSession(document.sessionId, document.dirName)
                  return opened.ok ? api.openArtifact(document.reference) : opened
                })
              }
            >
              <span className="home-tileHead">
                <span className="home-tileIcon">
                  <FileTypeIcon kind={document.kind} name={document.name} size="sm" />
                </span>
                <span className="home-tileAge">{formatAge(document.updatedAt, locale)}</span>
              </span>
              <span className="home-tileName">{document.name}</span>
              <span className="home-tileWorkspace">{document.workspaceLabel}</span>
            </button>
          ))}
          <span className="home-galleryFooter">
            {error ? (
              <span className="home-error" role="alert">
                {error}
              </span>
            ) : (
              t("home.searchSessions")
            )}
          </span>
        </div>
      )}
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
        <Button variant="outline" size="sm" onClick={() => onRespond(permission.id, false)}>
          {t("permission.deny")}
        </Button>
        <Button variant="primary" size="sm" onClick={() => onRespond(permission.id, true)}>
          {t("permission.allowOnce")}
        </Button>
      </div>
    </div>
  )
}
