import type { TranscriptEntry } from "../../../app/transcript.js"
import type { ModelPickerChoice, ModelPickerItem } from "../../../inference/picker-catalog.js"
import type {
  DesktopApi,
  DesktopEvent,
  DesktopSnapshot,
  DesktopStatus,
  ModelSelectResult,
  SendPromptResult,
  SessionOpResult,
  ThemeName,
  TranscriptPatchOp,
} from "../../contracts.js"

/**
 * A fixture-backed DesktopApi for UI development (`?demo`). It mirrors real application semantics — admission
 * before acceptance, queued follow-ups, permission round-trips, stop — so the interface is exercised honestly
 * before it is connected to a workspace. Never used when the preload bridge is present without `?demo`.
 */
export function createDemoRuntime(): DesktopApi {
  return new DemoRuntime()
}

type DemoState = DesktopStatus & { entries: TranscriptEntry[] }

const SAMPLE_DIFF = `--- a/src/desktop/renderer/shell/AppShell.tsx
+++ b/src/desktop/renderer/shell/AppShell.tsx
@@ -18,7 +18,10 @@ export function AppShell() {
   useEffect(() => {
-    window.addEventListener("keydown", onKeyDown)
-    return () => window.removeEventListener("keydown", onKeyDown)
+    const target = window
+    target.addEventListener("keydown", onKeyDown)
+    return () => target.removeEventListener("keydown", onKeyDown)
   }, [api])
+
+  const platformClass = state?.platform === "darwin" ? "platform-darwin" : "platform-linux"
 }`

const FINAL_ANSWER = `The shortcut is wired up. Summary of the change:

| Piece | File | What it does |
| --- | --- | --- |
| Key handling | \`AppShell.tsx\` | ⌘B toggles the sidebar, ⌘N starts a new session |
| Cleanup | \`AppShell.tsx\` | The listener is removed when the shell unmounts |
| State | \`Sidebar.tsx\` | Collapse is local UI state; sessions come from the app |

The test suite passes: **214 tests, 0 failures**.`

const DEMO_MODELS: ModelPickerChoice[] = [
  {
    kind: "model",
    provider: "local",
    id: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    displayName: "Qwen3 Coder 30B",
    contextLength: 32_768,
    supportsImageInput: false,
    available: true,
    recommended: true,
    availabilityLabel: "Est. 32K · Q4_K_M · 18.5 GB",
    downloaded: true,
    active: false,
  },
  {
    kind: "model",
    provider: "local",
    id: "openai/gpt-oss-120b",
    displayName: "gpt-oss 120B",
    contextLength: 65_536,
    supportsImageInput: false,
    available: true,
    recommended: false,
    availabilityLabel: "Est. 64K · MXFP4 · 63 GB",
    downloaded: false,
    active: false,
  },
  {
    // Cached on a bigger machine: too large to run here, but the weights can still be deleted.
    kind: "model",
    provider: "local",
    id: "zai-org/GLM-5.3",
    displayName: "GLM-5.3",
    contextLength: 65_536,
    supportsImageInput: false,
    available: false,
    recommended: false,
    availabilityLabel: "Needs 390 GB",
    downloaded: true,
    active: false,
  },
  {
    kind: "model",
    provider: "local",
    id: "openai/gpt-oss-20b",
    displayName: "gpt-oss 20B",
    contextLength: 32_768,
    supportsImageInput: false,
    available: false,
    recommended: false,
    availabilityLabel: "Needs 48 GB",
    downloaded: false,
    active: false,
  },
  {
    kind: "model",
    provider: "pair",
    id: "qwen3:32b",
    displayName: "qwen3:32b",
    baseURL: "http://127.0.0.1:11434",
    engine: "ollama",
    supportsImageInput: false,
    available: true,
    active: false,
    selectionKey: "ollama:qwen3:32b",
  },
  {
    kind: "model",
    provider: "fireworks",
    id: "accounts/fireworks/models/kimi-k2p5-turbo",
    displayName: "Kimi K2.5 Turbo",
    contextLength: 262_144,
    supportsImageInput: false,
    available: true,
    active: true,
  },
  {
    kind: "model",
    provider: "fireworks",
    id: "accounts/fireworks/models/glm-5p1",
    displayName: "GLM 5.1",
    contextLength: 202_752,
    supportsImageInput: false,
    available: true,
    active: false,
  },
]

class DemoRuntime implements DesktopApi {
  #listeners = new Set<(event: DesktopEvent) => void>()
  #revision = 0
  #nextId = 100
  #timer: ReturnType<typeof setTimeout> | undefined
  #generation = 0
  #queued: string[] = []
  #permissionResolve: ((allow: boolean) => void) | undefined
  #modelTimer: ReturnType<typeof setTimeout> | undefined
  #modelSeq = 0
  #deletedLocalIds = new Set<string>()

  #state: DemoState = {
    busy: false,
    phase: "idle",
    model: { id: "accounts/fireworks/models/kimi-k2p5-turbo", provider: "fireworks", displayName: "Kimi K2.5 Turbo" },
    modelState: "ready",
    modelError: undefined,
    session: { id: "session_demo1", title: "Sidebar keyboard shortcut" },
    needsWorkspace: false,
    workspace: { label: "~/Projects/otis", path: "/Users/dev/Projects/otis" },
    sessions: [
      {
        id: "session_demo1",
        title: "Sidebar keyboard shortcut",
        detail: "Just now",
        active: true,
        dirName: "otis-demo",
        workspaceLabel: "otis",
        workspacePath: "/Users/dev/Projects/otis",
      },
      {
        id: "session_demo2",
        title: "Fix flaky session lock test",
        detail: "3h ago",
        dirName: "otis-demo",
        workspaceLabel: "otis",
        workspacePath: "/Users/dev/Projects/otis",
      },
      {
        id: "session_demo3",
        title: "Refactor GGUF cache cleanup",
        detail: "Yesterday",
        dirName: "otis-demo",
        workspaceLabel: "otis",
        workspacePath: "/Users/dev/Projects/otis",
      },
      {
        id: "session_notes",
        title: "Reading list cleanup",
        detail: "2d ago",
        dirName: "notes-demo",
        workspaceLabel: "notes",
        workspacePath: "/Users/dev/Projects/notes",
      },
      {
        id: "session_old",
        title: "Legacy import dry run",
        detail: "2w ago",
        dirName: "oldstuff-demo",
        workspaceLabel: "oldstuff",
      },
    ],
    contextTokens: 18_420,
    contextLimit: 128_000,
    diffs: { added: 12, removed: 3 },
    permission: null,
    modelLoad: null,
    stats: {
      streak: 12,
      totalTokens: 1_482_300,
      sessionCount: 214,
      avgTokensPerSession: 116_400,
      avgSessionSeconds: 252,
    },
    entries: demoTranscript(),
    agentsPanelVisible: true,
    theme: "default",
    thinkingVisible: true,
    permissionMode: "auto",
    fastServing: { available: true, enabled: false },
    hostedConfigured: true,
    pairConfigured: false,
    pairEndpoints: {},
    debug: false,
    // Showcases the header's update affordance.
    update: { status: "ready", version: "0.2.0" },
    subagents: [
      {
        toolCallId: "demo_agent_1",
        title: "Survey sidebar focus handling",
        status: "complete",
        tools: 2,
        durationMs: 1_900,
      },
    ],
  }

  async setAgentsPanelVisible(visible: boolean): Promise<void> {
    this.#state = { ...this.#state, agentsPanelVisible: visible }
    this.#emitStatus()
  }

  async setThinkingVisible(visible: boolean): Promise<void> {
    this.#state = { ...this.#state, thinkingVisible: visible }
    this.#emitStatus()
  }

  async setPermissionMode(mode: "ask" | "auto"): Promise<void> {
    this.#state = { ...this.#state, permissionMode: mode }
    this.#emitStatus()
  }

  async setTheme(theme: ThemeName): Promise<void> {
    this.#state = { ...this.#state, theme }
    this.#emitStatus()
  }

  async openFireworksKeyPage(): Promise<void> {}

  async setFireworksApiKey(apiKey: string): Promise<ModelSelectResult> {
    if (!apiKey.trim()) return { ok: false, reason: "Fireworks API key is required." }
    this.#state = { ...this.#state, modelState: "starting" }
    this.#emitStatus()
    await new Promise((resolve) => setTimeout(resolve, 700))
    this.#state = { ...this.#state, modelState: "ready", hostedConfigured: true }
    this.#emitStatus()
    return { ok: true }
  }

  async connectPairEndpoints(endpoints: { ollama?: string; lmStudio?: string }): Promise<ModelSelectResult> {
    if (!endpoints.ollama?.trim() && !endpoints.lmStudio?.trim()) {
      return { ok: false, reason: "Enter at least one NVIDIA PAIR endpoint." }
    }
    await new Promise((resolve) => setTimeout(resolve, 900))
    const saved: { ollama?: string; lmStudio?: string } = {}
    if (endpoints.ollama?.trim()) saved.ollama = endpoints.ollama.trim()
    if (endpoints.lmStudio?.trim()) saved.lmStudio = endpoints.lmStudio.trim()
    this.#state = { ...this.#state, pairConfigured: true, pairEndpoints: saved }
    this.#emitStatus()
    return { ok: true }
  }

  async installUpdate(): Promise<void> {}

  async checkForUpdates(): Promise<void> {}

  async setDebugMode(enabled: boolean): Promise<void> {
    this.#state = { ...this.#state, debug: enabled }
    this.#emitStatus()
  }

  /** Pretends to re-select the demo model on its other serving path, chip state pulse included. */
  async setFastServing(fast: boolean): Promise<ModelSelectResult> {
    if (this.#state.busy) return { ok: false, reason: "Finish the current work before changing Fast serving." }
    this.#state = { ...this.#state, modelState: "starting" }
    this.#emitStatus()
    await new Promise((resolve) => setTimeout(resolve, 900))
    this.#state = {
      ...this.#state,
      modelState: "ready",
      fastServing: { available: true, enabled: fast },
      model: {
        id: fast ? "accounts/fireworks/routers/kimi-k2p5-turbo-fast" : "accounts/fireworks/models/kimi-k2p5-turbo",
        provider: "fireworks",
        displayName: "Kimi K2.5 Turbo",
      },
    }
    this.#emitStatus()
    return { ok: true }
  }

  async getSubagentTrace(toolCallId: string): Promise<TranscriptEntry[]> {
    if (!this.#state.subagents.some((run) => run.toolCallId === toolCallId)) return []
    let id = 9_000
    return [
      {
        id: id++,
        kind: "tool",
        speaker: "Tool",
        text: "Searching files: session lock",
        activityKind: "file_search",
        toolCallId: `${toolCallId}_t1`,
      },
      {
        id: id++,
        kind: "tool",
        speaker: "Tool",
        text: "Reading file: src/app/sessions.ts",
        activityKind: "file_read",
        toolCallId: `${toolCallId}_t2`,
      },
      {
        id: id++,
        kind: "message",
        speaker: "Otis",
        text: "The session lock is per-workspace and held for the duration of a turn; switching sessions waits for the lock to drain.",
      },
    ]
  }

  async getSnapshot(): Promise<DesktopSnapshot> {
    return {
      platform: "darwin",
      version: "0.1.35",
      revision: this.#revision,
      entries: [...this.#state.entries],
      ...this.#status(),
    }
  }

  subscribe(listener: (event: DesktopEvent) => void) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async sendPrompt(text: string): Promise<SendPromptResult> {
    if (!text.trim()) return { accepted: false, reason: "The prompt is empty." }
    if (this.#state.busy) {
      this.#queued.push(text)
      this.#push({ ...this.#entry("You", text), delivery: "queued" })
      return { accepted: true, delivery: "queued" }
    }
    this.#push(this.#entry("You", text))
    this.#runTurn(text, ++this.#generation)
    return { accepted: true, delivery: "started" }
  }

  async stop() {
    this.#interrupt()
  }

  async respondToPermission(id: number, allow: boolean) {
    if (this.#state.permission?.id !== id) return
    this.#state = { ...this.#state, permission: null }
    this.#emitStatus()
    this.#permissionResolve?.(allow)
    this.#permissionResolve = undefined
  }

  async searchSessions(query: string) {
    const needle = query.trim().toLowerCase()
    if (!needle) return this.#state.sessions
    return this.#state.sessions.filter((session) => session.title.toLowerCase().includes(needle))
  }

  async openSessionAt(workspacePath: string, sessionId: string): Promise<SessionOpResult> {
    if (workspacePath === this.#state.workspace.path) return this.selectSession(sessionId)
    // Demo: pretend the other workspace exists and reuse the local fixtures.
    const result = await this.selectSession(sessionId)
    if (result.ok) {
      this.#state = {
        ...this.#state,
        workspace: { label: `~/Projects/${workspacePath.split("/").pop()}`, path: workspacePath },
      }
      this.#emit({ type: "status", revision: ++this.#revision, status: this.#status() })
    }
    return result
  }

  async locateWorkspace(_path: string): Promise<SessionOpResult> {
    return { ok: true }
  }

  async openWorkspace(path: string): Promise<SessionOpResult> {
    return this.openSessionAt(path, "session_demo3")
  }

  async pickWorkspaceFolder(): Promise<string | undefined> {
    return undefined
  }

  async refreshSessions(): Promise<void> {}

  async registerWorkspace(_dirName: string, _path: string): Promise<SessionOpResult> {
    return { ok: true }
  }

  async selectSession(id: string): Promise<SessionOpResult> {
    if (this.#state.busy) return { ok: false, reason: "Finish the current work before switching sessions." }
    const target = this.#state.sessions.find((session) => session.id === id)
    if (!target) return { ok: false, reason: "Unknown session." }
    this.#interrupt()
    const entries = id === "session_demo2" ? errorTranscript() : id === "session_demo1" ? demoTranscript() : []
    this.#state = {
      ...this.#state,
      entries,
      session: { id: target.id, title: target.title },
      sessions: this.#state.sessions.map((session) => ({ ...session, active: session.id === id })),
      subagents:
        id === "session_demo1"
          ? [
              {
                toolCallId: "demo_agent_1",
                title: "Survey sidebar focus handling",
                status: "complete",
                tools: 2,
                durationMs: 1_900,
              },
            ]
          : [],
    }
    this.#emitOps([{ op: "reset", entries }])
    this.#emitStatus()
    return { ok: true }
  }

  async startNewSession(): Promise<SessionOpResult> {
    if (this.#state.busy) return { ok: false, reason: "Finish the current work before starting over." }
    this.#interrupt()
    this.#state = { ...this.#state, entries: [], session: null, diffs: { added: 0, removed: 0 }, subagents: [] }
    this.#emitOps([{ op: "reset", entries: [] }])
    this.#emitStatus()
    return { ok: true }
  }

  async deleteSession(id: string): Promise<SessionOpResult> {
    if (this.#state.busy) return { ok: false, reason: "Finish the current work before deleting sessions." }
    const sessions = this.#state.sessions.filter((session) => session.id !== id)
    const deletingActive = this.#state.session?.id === id
    this.#state = {
      ...this.#state,
      sessions,
      ...(deletingActive ? { session: null, entries: [] } : {}),
    }
    if (deletingActive) this.#emitOps([{ op: "reset", entries: [] }])
    this.#emitStatus()
    return { ok: true }
  }

  async listModels(): Promise<ModelPickerItem[]> {
    const current = this.#state.model
    const load = this.#state.modelLoad
    const rows = DEMO_MODELS.map((item): ModelPickerChoice => {
      const key = item.provider === "pair" ? item.selectionKey : item.id
      const active = current?.provider === item.provider && current.id === item.id
      const status = load?.modelId === key ? load.status : undefined
      // Deleted weights are gone from disk: the row returns to its downloadable state.
      const downloaded = "downloaded" in item && item.downloaded && !this.#deletedLocalIds.has(item.id)
      return {
        ...item,
        active,
        ...(status ? { status } : {}),
        ...("downloaded" in item ? { downloaded } : {}),
      }
    })
    return [
      { kind: "header", id: "header-local", displayName: "Local" },
      // Like the real catalog: an over-budget model stays listed while its weights are cached, then
      // disappears once they are deleted.
      ...rows.filter(
        (item) => item.provider === "local" && (item.available || !("downloaded" in item) || item.downloaded),
      ),
      { kind: "header", id: "header-pair", displayName: "NVIDIA PAIR" },
      ...rows.filter((item) => item.provider === "pair"),
      { kind: "header", id: "header-hosted", displayName: "Hosted" },
      ...rows.filter((item) => item.provider === "fireworks"),
    ]
  }

  async selectModel(id: string): Promise<ModelSelectResult> {
    if (this.#state.busy) return { ok: false, reason: "Finish the current work before switching models." }
    const item = (await this.listModels()).find(
      (entry): entry is ModelPickerChoice =>
        entry.kind === "model" && (entry.provider === "pair" ? entry.selectionKey === id : entry.id === id),
    )
    if (!item) return { ok: false, reason: "That model is no longer in the catalog." }
    if (item.active) return { ok: true }
    if (!item.available) {
      return { ok: false, reason: "availabilityLabel" in item ? item.availabilityLabel : "Not available." }
    }
    const seq = ++this.#modelSeq
    // Only a managed local model that still needs its weights shows a visible load, like the real runtime.
    if (item.provider === "local" && "downloaded" in item && !item.downloaded) {
      return this.#simulateModelLoad(item, seq)
    }
    await new Promise((resolve) => setTimeout(resolve, 350))
    if (seq !== this.#modelSeq) return { ok: false, reason: "The selection was superseded." }
    this.#activateModel(item)
    return { ok: true }
  }

  async cancelModelSelection() {
    this.#modelSeq += 1
    if (this.#modelTimer) clearTimeout(this.#modelTimer)
    this.#modelTimer = undefined
    if (this.#state.modelLoad?.status.kind === "progress") {
      this.#state = { ...this.#state, modelLoad: null }
      this.#emitStatus()
    }
  }

  async deleteLocalModel(id: string): Promise<ModelSelectResult> {
    if (this.#state.busy) return { ok: false, reason: "Finish the current work before deleting a model." }
    const known = DEMO_MODELS.some((item) => item.provider === "local" && item.id === id)
    if (!known) return { ok: false, reason: "That model is not in the local catalog." }
    // Slow enough to review the pending state, like deleting hundreds of GBs for real.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    this.#deletedLocalIds.add(id)
    // Deleting the active managed model clears the selection, like the real runtime.
    const deletingActive = this.#state.model?.provider === "local" && this.#state.model.id === id
    if (deletingActive) {
      this.#state = {
        ...this.#state,
        model: null,
        modelState: "unconfigured",
        modelError: undefined,
        modelLoad: null,
      }
    }
    this.#emitStatus()
    return { ok: true }
  }

  #simulateModelLoad(item: ModelPickerChoice, seq: number): Promise<ModelSelectResult> {
    const steps = ["Downloading 12%", "Downloading 45%", "Downloading 78%", "Loading"]
    return new Promise((resolve) => {
      let index = 0
      const step = () => {
        if (seq !== this.#modelSeq) {
          resolve({ ok: false, reason: "The selection was cancelled." })
          return
        }
        if (index < steps.length) {
          this.#state = {
            ...this.#state,
            modelLoad: { modelId: item.id, status: { label: steps[index] as string, kind: "progress" } },
          }
          this.#emitStatus()
          index += 1
          this.#modelTimer = setTimeout(step, 650)
          return
        }
        // The simulated download put the weights back on disk: the row is deletable again.
        this.#deletedLocalIds.delete(item.id)
        this.#activateModel(item)
        resolve({ ok: true })
      }
      step()
    })
  }

  #activateModel(item: ModelPickerChoice) {
    this.#state = {
      ...this.#state,
      model: { id: item.id, provider: item.provider },
      modelState: "ready",
      modelError: undefined,
      modelLoad: null,
    }
    this.#emitStatus()
  }

  // --- Simulation ---

  #runTurn(prompt: string, generation: number) {
    this.#state = { ...this.#state, busy: true, phase: "thinking" }
    this.#emitStatus()

    const reply = cannedReply(prompt)
    this.#after(generation, 450, () => {
      const reasoning = this.#push({
        id: this.#nextId++,
        kind: "reasoning",
        speaker: "Thinking",
        text: "",
        streaming: true,
        reasoningId: `demo-${generation}`,
        startedAt: new Date().toISOString(),
      })
      this.#streamText(reasoning.id, reply.reasoning, generation, () => {
        this.#patch(reasoning.id, { streaming: false, endedAt: new Date().toISOString(), durationMs: 1200 })
        this.#after(generation, 250, () => {
          this.#streamText(this.#pushAssistant("", true).id, reply.intro, generation, () => {
            this.#runTools(generation, reply)
          })
        })
      })
    })
  }

  #runTools(generation: number, reply: CannedReply) {
    this.#state = { ...this.#state, phase: "working" }
    this.#emitStatus()
    const agentId = `demo_agent_turn_${generation}`
    this.#after(generation, 250, () => {
      this.#state = {
        ...this.#state,
        subagents: [
          ...this.#state.subagents,
          { toolCallId: agentId, title: "Check session lock behavior", status: "running", tools: 0 },
        ],
      }
      this.#emitStatus()
      this.#after(generation, 900, () => {
        this.#state = {
          ...this.#state,
          subagents: this.#state.subagents.map((run) => (run.toolCallId === agentId ? { ...run, tools: 1 } : run)),
        }
        this.#emitStatus()
      })
      this.#after(generation, 2400, () => {
        this.#state = {
          ...this.#state,
          subagents: this.#state.subagents.map((run) =>
            run.toolCallId === agentId ? { ...run, status: "complete" as const, durationMs: 2_600 } : run,
          ),
        }
        this.#emitStatus()
      })
    })
    this.#after(generation, 400, () => {
      this.#push({
        id: this.#nextId++,
        kind: "tool",
        speaker: "Tool",
        text: "Searching files: keydown",
        activityKind: "file_search",
        toolCallId: `call_${generation}_1`,
      })
      this.#after(generation, 450, () => {
        this.#push({
          id: this.#nextId++,
          kind: "tool",
          speaker: "Tool",
          text: "Reading files: src/desktop/renderer/shell/AppShell.tsx",
          activityKind: "file_read",
          toolCallId: `call_${generation}_2`,
        })
        this.#after(generation, 450, () => {
          this.#push({
            id: this.#nextId++,
            kind: "tool",
            speaker: "Tool",
            text: "Running command: bun run typecheck",
            activityKind: "shell",
            toolCallId: `call_${generation}_3`,
          })
          this.#after(generation, 500, () => {
            this.#push({
              id: this.#nextId++,
              kind: "tool",
              speaker: "Tool",
              text: "Editing file: src/desktop/renderer/shell/AppShell.tsx",
              activityKind: "file_edit",
              toolCallId: `call_${generation}_4`,
              diff: SAMPLE_DIFF,
            })
            this.#state = {
              ...this.#state,
              diffs: { added: this.#state.diffs.added + 5, removed: this.#state.diffs.removed + 2 },
            }
            this.#emitStatus()
            this.#requestPermission(generation, reply)
          })
        })
      })
    })
  }

  #requestPermission(generation: number, reply: CannedReply) {
    this.#after(generation, 600, () => {
      this.#state = {
        ...this.#state,
        permission: { id: generation, label: "Running command: bun test", kind: "shell", resources: ["bun test"] },
      }
      this.#emitStatus()
      new Promise<boolean>((resolve) => {
        this.#permissionResolve = resolve
      }).then((allow) => {
        if (generation !== this.#generation) return
        if (allow) {
          this.#push({
            id: this.#nextId++,
            kind: "tool",
            speaker: "Tool",
            text: "Running command: bun test",
            activityKind: "shell",
            toolCallId: `call_${generation}_5`,
          })
          this.#after(generation, 700, () => this.#finishTurn(generation, reply.final))
        } else {
          this.#finishTurn(generation, `${reply.denied}\n\n${reply.final}`)
        }
      })
    })
  }

  #finishTurn(generation: number, text: string) {
    this.#streamText(this.#pushAssistant("", true).id, text, generation, () => {
      this.#state = {
        ...this.#state,
        busy: false,
        phase: "idle",
        contextTokens: (this.#state.contextTokens ?? 0) + 3_800,
      }
      this.#emitStatus()
      const queued = this.#queued.shift()
      if (queued) this.#activateQueued(queued)
    })
  }

  /** Moves the queued message into the active position (like transcript.activatePendingUserMessage) and runs it. */
  #activateQueued(text: string) {
    const queuedEntry = this.#state.entries.find((entry) => entry.delivery === "queued")
    if (queuedEntry) {
      const active: TranscriptEntry = { ...queuedEntry }
      delete active.delivery
      this.#state = {
        ...this.#state,
        entries: [...this.#state.entries.filter((entry) => entry.id !== queuedEntry.id), active],
      }
      this.#emitOps([
        { op: "remove", id: queuedEntry.id },
        { op: "upsert", entry: active },
      ])
    }
    this.#runTurn(text, ++this.#generation)
  }

  #interrupt() {
    this.#generation += 1
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#state.permission) {
      this.#state = { ...this.#state, permission: null }
      this.#permissionResolve?.(false)
      this.#permissionResolve = undefined
    }
    if (!this.#state.busy) return
    const streaming = this.#state.entries.find((entry) => entry.streaming)
    if (streaming) this.#patch(streaming.id, { streaming: false })
    this.#push(this.#entry("Otis", "_Interrupted._"))
    this.#state = { ...this.#state, busy: false, phase: "idle" }
    this.#emitStatus()
    // Like the real runtime, stopping one turn hands the next queued follow-up to the conversation.
    const queued = this.#queued.shift()
    if (queued) this.#activateQueued(queued)
  }

  #streamText(entryId: number, text: string, generation: number, done: () => void) {
    let index = 0
    const step = () => {
      if (generation !== this.#generation) return
      index = Math.min(text.length, index + 14)
      this.#patch(entryId, { text: text.slice(0, index), streaming: index < text.length })
      if (index < text.length) this.#after(generation, 36, step)
      else done()
    }
    step()
  }

  // --- Plumbing ---

  #entry(speaker: "You" | "Otis", text: string): TranscriptEntry {
    return { id: this.#nextId++, kind: "message", speaker, text }
  }

  #pushAssistant(text: string, streaming: boolean): TranscriptEntry {
    return this.#push({ id: this.#nextId++, kind: "message", speaker: "Otis", text, streaming })
  }

  #push(entry: TranscriptEntry): TranscriptEntry {
    this.#state = { ...this.#state, entries: [...this.#state.entries, entry] }
    this.#emitOps([{ op: "upsert", entry }])
    return entry
  }

  #patch(id: number, patch: Partial<TranscriptEntry>) {
    const entry = this.#state.entries.find((candidate) => candidate.id === id)
    if (!entry) return
    const updated = { ...entry, ...patch }
    this.#state = {
      ...this.#state,
      entries: this.#state.entries.map((candidate) => (candidate.id === id ? updated : candidate)),
    }
    this.#emitOps([{ op: "upsert", entry: updated }])
  }

  #after(generation: number, delay: number, fn: () => void) {
    this.#timer = setTimeout(() => {
      if (generation !== this.#generation) return
      fn()
    }, delay)
  }

  #status(): DesktopStatus {
    const { entries: _entries, ...status } = this.#state
    return status
  }

  #emitOps(ops: TranscriptPatchOp[]) {
    this.#emit({ type: "transcript", revision: ++this.#revision, ops })
  }

  #emitStatus() {
    this.#emit({ type: "status", revision: ++this.#revision, status: this.#status() })
  }

  #emit(event: DesktopEvent) {
    for (const listener of this.#listeners) listener(event)
  }
}

type CannedReply = { reasoning: string; intro: string; denied: string; final: string }

function cannedReply(prompt: string): CannedReply {
  return {
    reasoning: `The user wants: “${prompt.slice(0, 80)}”. I should find the keyboard handling, make the change, and run the tests before reporting back.`,
    intro: "I'll find the keyboard handling first, then make the change.",
    denied: "Understood — I won't run the tests.",
    final: FINAL_ANSWER,
  }
}

let fixtureId = 1
const fixture = (entry: Omit<TranscriptEntry, "id">): TranscriptEntry => ({ id: fixtureId++, ...entry })

function demoTranscript(): TranscriptEntry[] {
  fixtureId = 1
  return [
    fixture({
      kind: "message",
      speaker: "You",
      text: "Wire ⌘B to toggle the sidebar and make sure the listener is cleaned up",
    }),
    fixture({
      kind: "reasoning",
      speaker: "Thinking",
      text: "The shell already owns keyboard shortcuts. I'll look at AppShell, add the toggle there, and check the effect cleanup.",
      reasoningId: "r1",
      startedAt: "2026-09-07T10:00:00Z",
      endedAt: "2026-09-07T10:00:01Z",
      durationMs: 1150,
    }),
    fixture({ kind: "message", speaker: "Otis", text: "Let me look at the shell's keyboard handling first." }),
    fixture({
      kind: "tool",
      speaker: "Tool",
      text: "Searching files: keydown",
      activityKind: "file_search",
      toolCallId: "c1",
    }),
    fixture({
      kind: "tool",
      speaker: "Tool",
      text: "Reading files: src/desktop/renderer/shell/AppShell.tsx",
      activityKind: "file_read",
      toolCallId: "c2",
    }),
    fixture({
      kind: "tool",
      speaker: "Tool",
      text: "Editing file: src/desktop/renderer/shell/AppShell.tsx",
      activityKind: "file_edit",
      toolCallId: "c3",
      diff: SAMPLE_DIFF,
    }),
    fixture({
      kind: "tool",
      speaker: "Tool",
      text: "Running command: bun test tests/desktop",
      activityKind: "shell",
      toolCallId: "c4",
    }),
    fixture({
      kind: "message",
      speaker: "Otis",
      text: `Done. The shortcut lives in \`AppShell\` and the effect now returns a cleanup that removes exactly the listener it added.

\`\`\`tsx
useEffect(() => {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey && event.key === "b") setSidebarCollapsed((value) => !value)
  }
  window.addEventListener("keydown", onKeyDown)
  return () => window.removeEventListener("keydown", onKeyDown)
}, [])
\`\`\`

All 214 tests pass.`,
    }),
    fixture({ kind: "message", speaker: "You", text: "Also collapse it automatically below 900px window width" }),
    fixture({
      kind: "message",
      speaker: "Otis",
      text: "Good call for narrow windows. I'll add a `matchMedia` listener in `AppShell` that collapses the sidebar under 900px, but only collapses automatically — it never re-expands on its own, so the user's explicit choice stays sticky.",
    }),
  ]
}

function errorTranscript(): TranscriptEntry[] {
  fixtureId = 50
  return [
    fixture({ kind: "message", speaker: "You", text: "Why is the session lock test flaky on CI?" }),
    fixture({
      kind: "tool",
      speaker: "Tool",
      text: "Searching files: acquireSessionLock",
      activityKind: "file_search",
      toolCallId: "e1",
    }),
    fixture({
      kind: "message",
      speaker: "Otis",
      text: "Error: Fireworks request failed with HTTP 429: rate limit exceeded. The turn was interrupted before I could finish.",
    }),
  ]
}
