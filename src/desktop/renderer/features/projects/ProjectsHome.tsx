import {
  ChevronLeft,
  FolderOpen,
  Folders,
  MessagesSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { GlobalSessionPickerItem } from "../../../../app/global-sessions.js"
import type { ProjectSummary, SessionOpResult } from "../../../contracts.js"
import { Button, IconButton, Pager, usePage } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { MatrixLoader } from "../../components/MatrixLoader.js"
import { TextField } from "../../components/TextField.js"
import { formatAge, formatSessionDetail } from "../../format.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import "./projects.css"

// Projects and a project's sessions show four cards a page, as Home's rows do.
const PAGE = 4

type Act = (run: () => Promise<SessionOpResult>) => Promise<void>

/**
 * A session as a home card: its state in the tile, its title and a line of detail, and its pin
 * at the edge. Hovering it can light the sessions it was last on screen with.
 */
export function SessionCard({
  session,
  meta,
  grouped = false,
  onHover,
  onOpen,
}: {
  session: GlobalSessionPickerItem
  meta: string
  grouped?: boolean
  onHover?: (session: GlobalSessionPickerItem | undefined) => void
  onOpen: () => void
}) {
  const { api } = useDesktop()
  const { t } = useI18n()
  return (
    <div className={`home-card home-card-split${grouped ? " home-card-grouped" : ""}`}>
      <button
        type="button"
        className="home-cardOpen"
        title={session.title}
        onMouseEnter={onHover && (() => onHover(session))}
        onMouseLeave={onHover && (() => onHover(undefined))}
        onClick={onOpen}
      >
        <span className="home-cardTile">
          {session.working ? <MatrixLoader /> : <Icon icon={MessagesSquare} size={15} />}
          {!session.working && (session.unseen || session.resumable) ? (
            <span className="stateDot home-cardDot" />
          ) : null}
        </span>
        <span className="home-cardText">
          <span className="home-cardTitle">{session.title}</span>
          <span className="home-cardMeta">{meta}</span>
        </span>
      </button>
      <IconButton
        icon={session.pinned ? PinOff : Pin}
        label={t(session.pinned ? "common.unpin" : "common.pin")}
        className="home-cardEdit"
        onClick={() => void api.pinSession(session.id, session.dirName, !session.pinned)}
      />
    </div>
  )
}

/**
 * The home screen's projects: every workspace with a session store, pinned ones in a row of
 * their own, as cards in the recents' style, each with its pin at the edge. A card opens the
 * project's page: its name and the instructions Otis reads in that folder on one card, and its
 * sessions as cards, four a page.
 */
export function ProjectsHome({ onHome }: { onHome: () => void }) {
  const { api } = useDesktop()
  const { locale, t } = useI18n()
  const state = useDesktopState("projects", "sessions")
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState<string>()
  const projects = state?.projects ?? []
  const pinned = usePage(
    projects.filter((entry) => entry.pinned),
    PAGE,
  )
  const rest = usePage(
    projects.filter((entry) => !entry.pinned),
    PAGE,
  )
  if (!state) return null
  const act: Act = async (run) => {
    setError(undefined)
    const result = await run()
    if (!result.ok) setError(result.reason)
  }
  // Opening a folder is a fresh session in it, which Home shows with the composer ready.
  const start = (path: string) =>
    act(async () => {
      const opened = await api.openWorkspace(path)
      if (opened.ok) onHome()
      return opened
    })
  const project = state.projects.find((entry) => entry.dirName === selected)
  if (project) {
    return (
      <ProjectPage
        key={project.dirName}
        project={project}
        sessions={state.sessions.filter((session) => session.dirName === project.dirName)}
        act={act}
        error={error}
        onBack={() => setSelected(undefined)}
        onStart={() => void start(project.path)}
      />
    )
  }
  const card = (entry: ProjectSummary) => (
    <div key={entry.dirName} className="home-card home-card-split" title={entry.path}>
      <button type="button" className="home-cardOpen" onClick={() => setSelected(entry.dirName)}>
        <span className="home-cardTile">
          <Icon icon={Folders} size={15} />
          {entry.open ? <span className="stateDot home-cardDot" /> : null}
        </span>
        <span className="home-cardText">
          <span className="home-cardTitle">{entry.label}</span>
          <span className="home-cardMeta">
            {t("projects.sessionsCount", { count: entry.sessions })}
            {entry.updatedAt ? ` · ${formatAge(entry.updatedAt, locale)}` : ""}
          </span>
        </span>
      </button>
      <IconButton
        icon={entry.pinned ? PinOff : Pin}
        label={t(entry.pinned ? "common.unpin" : "common.pin")}
        className="home-cardEdit"
        onClick={() => void api.setProject(entry.dirName, { pinned: !entry.pinned })}
      />
    </div>
  )
  return (
    <div className="home-recents">
      {pinned.shown.length ? (
        <>
          <span className="home-heading">
            {t("home.pinned")}
            <Pager {...pinned.pager} />
          </span>
          <div className="home-grid home-grid-sessions">{pinned.shown.map(card)}</div>
        </>
      ) : null}
      <span className="home-heading">
        {t("home.projects")}
        <span className="project-tools">
          <Pager {...rest.pager} />
          <Button
            variant="ghost"
            size="sm"
            icon={FolderOpen}
            onClick={() =>
              void api.pickWorkspaceFolder().then((path) => {
                if (path) void start(path)
              })
            }
          >
            {t("projects.openFolder")}
          </Button>
        </span>
      </span>
      {rest.shown.length === 0 ? (
        <p className="project-hint">{t("projects.empty")}</p>
      ) : (
        <div className="home-grid home-grid-sessions">{rest.shown.map(card)}</div>
      )}
      {error ? <p className="home-error">{error}</p> : null}
    </div>
  )
}

function ProjectPage({
  project,
  sessions,
  act,
  error,
  onBack,
  onStart,
}: {
  project: ProjectSummary
  sessions: GlobalSessionPickerItem[]
  act: Act
  error: string | undefined
  onBack: () => void
  onStart: () => void
}) {
  const { api } = useDesktop()
  const { locale, t } = useI18n()
  // The name being typed, while the title is a field; the instructions as saved, once read; the
  // draft being edited, while the sheet is open. Keyed by project, so a different folder starts
  // afresh.
  const [name, setName] = useState<string>()
  // A rename settles once: Enter and Escape both unmount the field, whose blur must not rename
  // again, or at all after Escape.
  const settled = useRef(false)
  const [saved, setSaved] = useState<string>()
  const [draft, setDraft] = useState<string>()
  const { shown, pager } = usePage(sessions, PAGE)
  const editor = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    let live = true
    void api.readProjectInstructions(project.dirName).then((text) => {
      if (live) setSaved(text)
    })
    return () => {
      live = false
    }
  }, [api, project.dirName])
  useEffect(() => {
    if (draft !== undefined) editor.current?.focus()
  }, [draft !== undefined])
  const rename = () => {
    if (settled.current || name === undefined) return
    settled.current = true
    if (name.trim() !== project.label) void api.setProject(project.dirName, { name })
    setName(undefined)
  }
  const saveInstructions = () => {
    if (draft !== undefined && draft !== saved) {
      void api.writeProjectInstructions(project.dirName, draft)
      setSaved(draft)
    }
    setDraft(undefined)
  }
  return (
    <div className="home-recents">
      <span className="home-heading">
        <button type="button" className="backLink" onClick={onBack}>
          <Icon icon={ChevronLeft} size={13} />
          {t("home.projects")}
        </button>
      </span>
      <div className="project-head">
        <div className="project-headRow">
          <span className="home-cardTile project-tile">
            <Icon icon={Folders} size={18} />
          </span>
          <div className="project-title">
            {name === undefined ? (
              <h2 className="project-name">
                {project.label}
                <IconButton
                  icon={Pencil}
                  label={t("projects.rename")}
                  size={22}
                  className="project-edit"
                  onClick={() => {
                    settled.current = false
                    setName(project.label)
                  }}
                />
              </h2>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  rename()
                }}
              >
                <TextField
                  aria-label={t("projects.name")}
                  value={name}
                  autoFocus
                  onChange={(event) => setName(event.target.value)}
                  onBlur={rename}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return
                    settled.current = true
                    setName(undefined)
                  }}
                />
              </form>
            )}
            <span className="project-path">{project.path}</span>
          </div>
          <span className="project-actions">
            <Button variant="primary" size="sm" icon={Plus} onClick={onStart}>
              {t("projects.newSession")}
            </Button>
          </span>
        </div>
        <div className="project-headRow project-brief">
          <span className="project-briefLabel">
            {t("projects.instructions")}
            <span className="project-briefMeta">
              {saved?.trim().split("\n")[0] || t("projects.instructionsNone")}
            </span>
          </span>
          <Button size="sm" disabled={saved === undefined} onClick={() => setDraft(saved)}>
            {t("projects.edit")}
          </Button>
        </div>
      </div>
      <span className="home-heading">
        {t("projects.sessions")}
        <Pager {...pager} />
      </span>
      {sessions.length === 0 ? (
        <p className="project-hint">{t("projects.noSessions")}</p>
      ) : (
        <div className="home-grid home-grid-sessions">
          {shown.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              meta={formatSessionDetail(session.detail, locale)}
              onOpen={() => void act(() => api.selectSession(session.id, session.dirName))}
            />
          ))}
        </div>
      )}
      {error ? <p className="home-error">{error}</p> : null}
      {draft !== undefined ? (
        <>
          <button
            type="button"
            className="overlayBackdrop"
            aria-label={t("common.cancel")}
            onClick={() => setDraft(undefined)}
          />
          <div
            className="sheet noDrag"
            role="dialog"
            aria-modal="true"
            aria-label={t("projects.instructions")}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDraft(undefined)
            }}
          >
            <h2 className="sheet-title">{t("projects.instructions")}</h2>
            <textarea
              ref={editor}
              className="field sheet-textarea"
              aria-label={t("projects.instructions")}
              placeholder={t("projects.instructionsPlaceholder")}
              rows={8}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <p className="sheet-hint">{t("projects.instructionsHint")}</p>
            <div className="sheet-actions">
              <span className="sheet-spacer" />
              <Button variant="ghost" size="sm" onClick={() => setDraft(undefined)}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" size="sm" onClick={saveInstructions}>
                {t("common.save")}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
