import { OtisMark } from "../../components/OtisMark.js"
import { useDesktop, useDesktopState } from "../../runtime.js"

/** A quiet home screen centered on the brand mark, with guidance when inference is not usable. */
export function EmptyState() {
  const { api } = useDesktop()
  const state = useDesktopState("sessions", "modelState", "modelError")
  if (!state) return null

  const recents = state.sessions.filter((session) => !session.active).slice(0, 3)

  return (
    <div className="home">
      <OtisMark className="home-logo" />
      {state.modelState === "starting" ? (
        <p className="home-setup">The selected model is starting…</p>
      ) : state.modelState === "failed" ? (
        <div className="home-setup">
          <p>The selected model could not start{state.modelError ? `: ${state.modelError}` : "."}</p>
          <p className="home-setupHint">Pick a different model from the model menu in the composer.</p>
        </div>
      ) : state.modelState === "unconfigured" ? (
        <div className="home-setup">
          <p>No model is configured yet.</p>
          <p className="home-setupHint">
            Run <code>otis</code> in this workspace once to set up inference — the desktop app uses the same
            configuration and sessions.
          </p>
        </div>
      ) : null}
      {recents.length > 0 ? (
        <div className="home-recents">
          {recents.map((session) => (
            <button
              key={session.id}
              type="button"
              className="home-recentRow"
              onClick={() => void api.selectSession(session.id)}
            >
              <span className="home-recentTitle">{session.title}</span>
              <span className="home-recentDetail">{session.detail}</span>
            </button>
          ))}
          <span className="home-hint">⌘K to search all sessions</span>
        </div>
      ) : null}
    </div>
  )
}
