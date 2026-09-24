import { Download, FolderOpen } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Button } from "../components/Button.js"
import { Icon } from "../components/Icon.js"
import { CanvasOpenContext, type CanvasView } from "../features/canvas/canvas-context.js"
import { ConversationView } from "../features/conversation/Transcript.js"
import { OnboardingPage } from "../features/onboarding/OnboardingPage.js"
import { CommandPalette } from "../features/palette/CommandPalette.js"
import { SettingsPage } from "../features/settings/SettingsPage.js"
import { useI18n } from "../i18n/index.js"
import { rememberTheme, useDesktop, useDesktopState } from "../runtime.js"
import { WorkspaceHeader } from "./WorkspaceHeader.js"
import { WorkspacePanel } from "./WorkspacePanel.js"

/**
 * The application shell: the conversation column and the delegated-runs rail when the session has
 * subagents. There is no session sidebar — the ⌘K palette is the only session navigation. The
 * header rows double as the window drag region (the macOS title bar is hidden); interactive
 * elements opt out with `noDrag`.
 */
export function AppShell() {
  const { api } = useDesktop()
  const { t } = useI18n()
  const state = useDesktopState(
    "theme",
    "platform",
    "model",
    "needsWorkspace",
    "update",
    "session",
    "artifacts",
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [windowFullscreen, setWindowFullscreen] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [locateError, setLocateError] = useState<string | undefined>(undefined)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // A diagram opened from a card is a Canvas tab of its own until it is closed.
  const [openedCanvas, setOpenedCanvas] = useState<Extract<CanvasView, { runtime?: undefined }>>()
  const nextCanvasId = useRef(0)
  const openCanvas = useCallback((source: string) => {
    const id = ++nextCanvasId.current
    setOpenedCanvas({
      key: `mermaid:${id}`,
      artifact: { kind: "mermaid", id, source },
      activated: Date.now(),
    })
  }, [])
  const artifacts = state?.artifacts
  const views = useMemo<CanvasView[]>(
    () => [
      ...(artifacts ?? []).map((tab) => ({ key: `${tab.runtime}:${tab.artifact.id}`, ...tab })),
      ...(openedCanvas ? [openedCanvas] : []),
    ],
    [artifacts, openedCanvas],
  )
  const closeDiagram = useCallback(() => setOpenedCanvas(undefined), [])
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])

  useEffect(() => {
    let receivedLiveState = false
    let mounted = true
    const unsubscribe = api.subscribeWindowState((windowState) => {
      receivedLiveState = true
      setWindowFullscreen(windowState.fullscreen)
    })
    void api
      .getWindowState()
      .then((windowState) => {
        if (mounted && !receivedLiveState) setWindowFullscreen(windowState.fullscreen)
      })
      .catch(() => {})
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [api])

  const theme = state?.theme ?? "default"
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    rememberTheme(theme)
  }, [theme])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key === "k") {
        event.preventDefault()
        setPaletteOpen((value) => !value)
      } else if (event.key === "n") {
        event.preventDefault()
        void api.startNewSession()
      } else if (event.key === "o") {
        event.preventDefault()
        void api.pickWorkspaceFolder().then(async (path) => {
          if (path) await api.openWorkspace(path)
        })
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [api])

  const readyUpdate = state?.update.status === "ready" ? state.update : undefined
  const platformClass = state?.platform === "darwin" ? "platform-darwin" : "platform-linux"
  const settingsClass = settingsOpen ? " settingsOpen" : ""
  const fullscreenClass = windowFullscreen ? " windowFullscreen" : ""
  const installUpdate = () => {
    if (installing || !readyUpdate) return
    setInstalling(true)
    void api.installUpdate()
  }

  return (
    <CanvasOpenContext.Provider value={openCanvas}>
      <div className={`appShell ${platformClass}${settingsClass}${fullscreenClass}`}>
        {/* The workspace stays mounted behind Settings so drafts, scroll positions, expanded
            cards, and the workspace-panel selection survive the round trip. */}
        <div
          className={`workspaceView${settingsOpen ? " workspaceView-hidden" : ""}`}
          aria-hidden={settingsOpen}
          inert={settingsOpen ? true : undefined}
        >
          <div className="mainColumn">
            {state && state.model === null ? (
              <OnboardingPage onOpenSettings={openSettings} />
            ) : (
              <>
                <WorkspaceHeader
                  hasCanvas={views.length > 0}
                  onOpenPalette={() => setPaletteOpen(true)}
                  onOpenSettings={openSettings}
                />
                {state?.needsWorkspace ? (
                  <div className="workspaceBanner">
                    <span>
                      {t("shell.workspaceMissing")}
                      {locateError ? (
                        <span className="workspaceBanner-error">{locateError}</span>
                      ) : null}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void api.pickWorkspaceFolder().then(async (path) => {
                          if (!path) return
                          const result = await api.locateWorkspace(path)
                          setLocateError(
                            result.ok
                              ? undefined
                              : (result.reason ?? t("shell.couldNotOpenFolder")),
                          )
                        })
                      }
                    >
                      <Icon icon={FolderOpen} size={12} />
                      {t("shell.locateWorkingFolder")}
                    </Button>
                  </div>
                ) : null}
                <ConversationView installing={installing} />
              </>
            )}
            {readyUpdate ? (
              <button
                type="button"
                className="updateFab noDrag"
                disabled={installing}
                title={
                  installing
                    ? t("shell.restartingUpdate")
                    : t("shell.updateReadyTitle", { version: readyUpdate.version })
                }
                onClick={installUpdate}
              >
                <Icon icon={Download} size={12} />
                <span className="updateFab-label">
                  {installing ? t("shell.restarting") : t("shell.update")}
                </span>
              </button>
            ) : null}
          </div>
          {state?.model === null ? null : (
            <WorkspacePanel views={views} onCloseDiagram={closeDiagram} />
          )}
        </div>
        {settingsOpen ? (
          <div className="settingsLayer">
            <SettingsPage
              onClose={closeSettings}
              installing={installing}
              onInstallUpdate={installUpdate}
            />
          </div>
        ) : null}
        {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
      </div>
    </CanvasOpenContext.Provider>
  )
}
