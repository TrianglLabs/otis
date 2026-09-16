import { OtisMark } from "../../components/OtisMark.js"
import { formatSessionDetail } from "../../format.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopState } from "../../runtime.js"

/** A quiet home screen centered on the brand mark, with guidance when inference is not usable. */
export function EmptyState() {
  const { api } = useDesktop()
  const { locale, t } = useI18n()
  const state = useDesktopState("sessions", "modelState", "modelError")
  if (!state) return null

  const recents = state.sessions.filter((session) => !session.active).slice(0, 3)

  return (
    <div className="home">
      <OtisMark className="home-logo" />
      {state.modelState === "starting" ? (
        <p className="home-setup">{t("home.modelStarting")}</p>
      ) : state.modelState === "failed" ? (
        <div className="home-setup">
          <p>{t("home.modelFailed", { detail: state.modelError ? `: ${state.modelError}` : "." })}</p>
          <p className="home-setupHint">{t("home.pickDifferent")}</p>
        </div>
      ) : state.modelState === "unconfigured" ? (
        <div className="home-setup">
          <p>{t("home.noModel")}</p>
          <p className="home-setupHint">{t("home.setupHint")}</p>
        </div>
      ) : null}
      {recents.length > 0 ? (
        <div className="home-recents">
          {recents.map((session) => (
            <button
              key={`${session.dirName}:${session.id}`}
              type="button"
              className="home-recentRow"
              onClick={() => void api.selectSession(session.id, session.dirName)}
            >
              <span className="home-recentTitle">{session.title}</span>
              <span className="home-recentDetail">{formatSessionDetail(session.detail, locale)}</span>
            </button>
          ))}
          <span className="home-hint">{t("home.searchSessions")}</span>
        </div>
      ) : null}
    </div>
  )
}
