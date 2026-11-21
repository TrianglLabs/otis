import {
  ChevronLeft,
  Folders,
  type LucideIcon,
  MessagesSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  ScrollText,
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

// Five rows a page, one of them the New row, as Routines shows New routine and four routines; a
// project's page adds its instructions to New session and four sessions.
const PAGE = 5

type Act = (run: () => Promise<SessionOpResult>) => Promise<void>

/** A row that acts rather than opens: a glyph, its title, and a quiet hint at the end. */
export function HomeRow({
  icon,
  title,
  hint,
  disabled,
  onClick,
}: {
  icon: LucideIcon
  title: string
  hint: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className="home-card" disabled={disabled} onClick={onClick}>
      <span className="home-cardTile">
        <Icon icon={icon} size={16} />
      </span>
      <span className="home-cardText">
        <span className="home-cardTitle">{title}</span>
        <span className="home-cardMeta">{hint}</span>
      </span>
    </button>
  )
}

/**
 * A session as a home row: its state in the glyph, its title and its detail, and its pin at the
 * end. Hovering it can light the sessions it was last on screen with.
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
          {session.working ? <MatrixLoader /> : <Icon icon={MessagesSquare} size={16} />}
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
 * The home screen's projects: New project, which opens a folder, then every workspace with a
 * session store as one list, pinned ones first under a pin, the rest by last activity, each row
 * with its pin at the end. A row opens the project's page: its name in the heading, then New
 * session and the instructions Otis reads in that folder over its sessions, all as rows.
 */
export function ProjectsHome({ onHome }: { onHome: () => void }) {
  const { api } = useDesktop()
  const { locale, t } = useI18n()
  const state = useDesktopState("projects", "sessions")
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState<string>()
  const projects = state?.projects ?? []
  const { shown, pager } = usePage(
    [...projects.filter((entry) => entry.pinned), ...projects.filter((entry) => !entry.pinned)],
    PAGE - 1,
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
          <Icon icon={entry.pinned ? Pin : Folders} size={16} />
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
      <span className="home-heading">
        {t("home.projects")}
        <Pager {...pager} />
      </span>
      <div className="home-grid">
        <HomeRow
          icon={Plus}
          title={t("projects.new")}
          hint={t("projects.newHint")}
          onClick={() =>
            void api.pickWorkspaceFolder().then((path) => {
              if (path) void start(path)
            })
          }
        />
        {shown.map(card)}
      </div>
      {shown.length === 0 ? <p className="project-hint">{t("projects.empty")}</p> : null}
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
  const { shown, pager } = usePage(sessions, PAGE - 1)
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
      {/* One line: the way back, the project's name with the pencil that renames it, and the
        pager. */}
      <span className="home-heading">
        <span className="project-crumb">
          <button type="button" className="backLink" onClick={onBack}>
            <Icon icon={ChevronLeft} size={13} />
            {t("home.projects")}
          </button>
          <span className="project-crumbSep">/</span>
          {name === undefined ? (
            <h2 className="project-name" title={project.path}>
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
        </span>
        <Pager {...pager} />
      </span>
      {/* New session, with the folder it opens in, and the instructions Otis reads here, with
        their first line, lead the project's sessions. */}
      <div className="home-grid">
        <HomeRow
          icon={Plus}
          title={t("projects.newSession")}
          hint={project.path}
          onClick={onStart}
        />
        <HomeRow
          icon={ScrollText}
          title={t("projects.instructions")}
          hint={saved?.trim().split("\n")[0] || t("projects.instructionsNone")}
          disabled={saved === undefined}
          onClick={() => setDraft(saved)}
        />
        {shown.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            meta={formatSessionDetail(session.detail, locale)}
            onOpen={() => void act(() => api.selectSession(session.id, session.dirName))}
          />
        ))}
      </div>
      {sessions.length === 0 ? <p className="project-hint">{t("projects.noSessions")}</p> : null}
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
