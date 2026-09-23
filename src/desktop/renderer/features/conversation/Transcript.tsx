import { MessagesSquare, Shield } from "lucide-react"
import { memo, useId, useMemo, useState } from "react"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import type { PendingPermission, SessionOpResult } from "../../../contracts.js"
import { Button } from "../../components/Button.js"
import { FileTypeIcon } from "../../components/FileTypeIcon.js"
import { Icon } from "../../components/Icon.js"
import { OtisMark } from "../../components/OtisMark.js"
import { formatAge, formatSessionDetail } from "../../format.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopSelector, useDesktopState } from "../../runtime.js"
import { Composer } from "./Composer.js"
import { TranscriptList } from "./TranscriptList.js"

const emptyEntries: TranscriptEntry[] = []

/**
 * The transcript and composer subscribe independently, so streamed text doesn't redraw the input.
 */
export const ConversationView = memo(function ConversationView({
  installing = false,
}: {
  installing?: boolean
}) {
  const { api } = useDesktop()
  const state = useDesktopSelector((snapshot) => ({
    entries: snapshot?.entries ?? emptyEntries,
    busy: snapshot?.busy ?? false,
    thinkingVisible: snapshot?.thinkingVisible ?? false,
    permission: snapshot?.permission ?? null,
    sessionKey: `${snapshot?.workspace.path ?? ""}:${snapshot?.session?.id ?? ""}`,
  }))
  const footer = useMemo(
    () =>
      state.permission ? (
        <PermissionCard
          permission={state.permission}
          onRespond={(id, allow) => void api.respondToPermission(id, allow)}
        />
      ) : null,
    [state.permission, api],
  )

  return (
    <div className="conversation">
      {state.entries.length === 0 && !state.permission ? (
        <EmptyState />
      ) : (
        <TranscriptList
          key={state.sessionKey}
          entries={state.entries}
          busy={state.busy}
          thinkingVisible={state.thinkingVisible}
          footer={footer}
        />
      )}
      <div className="composerWrap">
        <Composer installing={installing} />
      </div>
    </div>
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
              className="home-tile"
              title={session.title}
              onClick={() => void open(() => api.selectSession(session.id, session.dirName))}
            >
              <span className="home-tileHead">
                <span className="home-tileIcon">
                  <Icon icon={MessagesSquare} size={16} />
                  {session.resumable ? <span className="home-tileDot" /> : null}
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
 * card.
 */
function PermissionCard({
  permission,
  onRespond,
}: {
  permission: PendingPermission
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
