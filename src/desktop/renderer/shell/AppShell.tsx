import { Download, FolderOpen } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Button } from "../components/Button.js"
import { Icon } from "../components/Icon.js"
import { UnlockBanners } from "../features/achievements/Achievements.js"
import { CanvasOpenContext, type CanvasView } from "../features/canvas/canvas-context.js"
import { ConversationView } from "../features/conversation/Transcript.js"
import { OnboardingPage } from "../features/onboarding/OnboardingPage.js"
import { CommandPalette } from "../features/palette/CommandPalette.js"
import { SettingsPage, type SettingsTab } from "../features/settings/SettingsPage.js"
import { useI18n } from "../i18n/index.js"
import {
  DesktopProvider,
  LIGHT_THEMES,
  rememberTheme,
  useDesktop,
  useDesktopState,
} from "../runtime.js"
import { APP_SHORTCUTS } from "./shortcuts.js"
import { WorkspaceHeader } from "./WorkspaceHeader.js"
import { WorkspacePanel } from "./WorkspacePanel.js"

/**
 * The application shell: the conversation column and the delegated-runs rail when the session has
 * subagents. There is no session sidebar — the ⌘K palette is the only session navigation. The
 * header rows double as the window drag region (the macOS title bar is hidden); interactive
 * elements opt out with `noDrag`.
 */
export function AppShell() {
  const { api: bridge, store } = useDesktop()
  const { t } = useI18n()
  const state = useDesktopState(
    "theme",
    "textSize",
    "platform",
    "remote",
    "model",
    "needsWorkspace",
    "update",
    "session",
    "artifacts",
    "terminal",
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>()
  const [windowFullscreen, setWindowFullscreen] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [locateError, setLocateError] = useState<string | undefined>(undefined)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // On a daemon, the native folder picker would only show this machine's folders: the path is
  // typed instead, and every "open folder" in the window goes through this one prompt.
  const [folderPrompt, setFolderPrompt] = useState<(path: string | undefined) => void>()
  const remote = state?.remote
  const api = useMemo(
    () =>
      remote
        ? {
            ...bridge,
            pickWorkspaceFolder: () =>
              new Promise<string | undefined>((resolve) => setFolderPrompt(() => resolve)),
          }
        : bridge,
    [bridge, remote],
  )
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
  // A diagram belongs to the conversation it was opened from; another session, or a fresh one,
  // drops it.
  const sessionId = state?.session?.id
  useEffect(() => setOpenedCanvas(undefined), [sessionId])
  const artifacts = state?.artifacts
  const views = useMemo<CanvasView[]>(
    () => [
      ...(artifacts ?? []).map((tab) => ({ key: `${tab.runtime}:${tab.artifact.id}`, ...tab })),
      ...(openedCanvas ? [openedCanvas] : []),
    ],
    [artifacts, openedCanvas],
  )
  const closeDiagram = useCallback(() => setOpenedCanvas(undefined), [])
  // The shell runs in the main process and outlives the renderer; the stamp is when it was last
  // asked for here, so asking again brings its tab forward and focuses it.
  const [terminalFocus, setTerminalFocus] = useState<number>()
  // A daemon has no shell to offer yet; the header hides the button and the shortcut stays quiet.
  const openTerminal = useCallback(() => {
    if (remote) return
    void api.openTerminal()
    setTerminalFocus(Date.now())
  }, [api, remote])
  const openSettingsTab = useCallback((tab: SettingsTab | undefined) => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }, [])
  const openSettings = useCallback(() => openSettingsTab(undefined), [openSettingsTab])
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
  const textSize = state?.textSize ?? "default"
  useLayoutEffect(() => {
    document.documentElement.dataset.textSize = textSize
  }, [textSize])
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    // Components that draw their own pixels, such as the thinking orb, read light or dark here.
    const light = LIGHT_THEMES.has(theme)
    document.documentElement.classList.toggle("light", light)
    document.documentElement.classList.toggle("dark", !light)
  }, [theme])
  useEffect(() => {
    rememberTheme(theme)
  }, [theme])

  useEffect(() => {
    const onKeyDown = async (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (!APP_SHORTCUTS.has(key)) return
      event.preventDefault()
      if (key === "k") setPaletteOpen((value) => !value)
      else if (key === "`") openTerminal()
      else {
        if (key === "n") {
          if (!(await api.startNewSession()).ok) return
        } else {
          const path = await api.pickWorkspaceFolder()
          if (!path || !(await api.openWorkspace(path)).ok) return
        }
        setSettingsOpen(false)
        setPaletteOpen(false)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [api, openTerminal])

  const readyUpdate = state?.update.status === "ready" ? state.update : undefined
  const platformClass = state?.platform === "darwin" ? "platform-darwin" : "platform-linux"
  const settingsClass = settingsOpen ? " settingsOpen" : ""
  const fullscreenClass = windowFullscreen ? " windowFullscreen" : ""
  const installUpdate = () => {
    if (installing || !readyUpdate) return
    setInstalling(true)
    void api.installUpdate()
  }

  const desktop = useMemo(() => ({ api, store }), [api, store])
  return (
    <DesktopProvider value={desktop}>
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
                    hasViews={views.length > 0 || Boolean(state?.terminal)}
                    onOpenPalette={() => setPaletteOpen(true)}
                    onOpenSettings={openSettings}
                    onOpenServer={() => openSettingsTab("general")}
                    onOpenTerminal={openTerminal}
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
              <UnlockBanners onOpen={() => openSettingsTab("achievements")} />
            </div>
            {state?.model === null ? null : (
              <WorkspacePanel
                views={views}
                onCloseDiagram={closeDiagram}
                terminalFocus={terminalFocus}
              />
            )}
          </div>
          {settingsOpen ? (
            <div className="settingsLayer">
              <SettingsPage
                onClose={closeSettings}
                installing={installing}
                onInstallUpdate={installUpdate}
                initialTab={settingsTab}
              />
            </div>
          ) : null}
          {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
          {folderPrompt && remote ? (
            <RemoteFolderPrompt
              host={remote}
              onClose={(path) => {
                folderPrompt(path)
                setFolderPrompt(undefined)
              }}
            />
          ) : null}
        </div>
      </CanvasOpenContext.Provider>
    </DesktopProvider>
  )
}

function RemoteFolderPrompt({
  host,
  onClose,
}: {
  host: string
  onClose: (path: string | undefined) => void
}) {
  const { t } = useI18n()
  const [path, setPath] = useState("")
  const label = t("shell.remoteFolder", { host })
  return (
    <>
      <button
        type="button"
        className="overlayBackdrop"
        aria-label={t("common.cancel")}
        onClick={() => onClose(undefined)}
      />
      <form
        className="pathPrompt noDrag"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onSubmit={(event) => {
          event.preventDefault()
          onClose(path.trim() || undefined)
        }}
      >
        <label className="pathPrompt-label" htmlFor="pathPrompt-input">
          {label}
        </label>
        <input
          id="pathPrompt-input"
          className="pathPrompt-input"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/home/you/project"
          // biome-ignore lint/a11y/noAutofocus: the prompt opens to type into this field
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
        <p className="pathPrompt-hint">{t("shell.remoteFolderHint")}</p>
        <div className="pathPrompt-actions">
          <Button variant="ghost" size="sm" onClick={() => onClose(undefined)}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" size="sm" type="submit" disabled={!path.trim()}>
            {t("common.open")}
          </Button>
        </div>
      </form>
    </>
  )
}
