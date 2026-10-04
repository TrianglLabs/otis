import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  clearSelectedModel,
  hostedApiKeys,
  initializeLocalSettings,
  loadLocalSettings,
  saveAchievementsSeen,
  saveFastServingSelection,
  saveHiddenModels,
  saveHostedApiKey,
  saveLocalServers,
  saveLocalThinking,
  savePermissionMode,
  savePrimeTeamId,
  saveRemote,
  saveSelectedModel,
  saveSelectedTheme,
  saveSubagentPanelVisible,
  saveTextSize,
  saveThinkingVisible,
  saveUiLanguage,
  saveWorkspacePanelWidth,
} from "../../src/local/settings.js"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("local settings", () => {
  it("keeps the chat text size and rejects sizes it does not know", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveTextSize("large", { file })
    await saveSelectedModel(model("org/first", "First", 65_536), { file })
    expect((await loadLocalSettings({ file, env: {} })).textSize).toBe("large")
    await writeFile(file, JSON.stringify({ version: 1, textSize: "huge" }), "utf8")
    await expect(loadLocalSettings({ file, env: {} })).rejects.toThrow(
      "textSize must be one of small, default, large, larger",
    )
  })
  it("keeps the Prime Intellect team id, lets the environment override it, and clears it", async () => {
    const file = join(await tempDirectory(), "config.json")
    await savePrimeTeamId("team_abc", { file })
    await saveSelectedModel(model("org/first", "First", 65_536), { file })
    expect((await loadLocalSettings({ file, env: {} })).primeintellectTeamId).toBe("team_abc")
    expect(
      (await loadLocalSettings({ file, env: { PRIME_TEAM_ID: " team_env " } }))
        .primeintellectTeamId,
    ).toBe("team_env")
    expect(JSON.parse(await readFile(file, "utf8")).primeintellectTeamId).toBe("team_abc")
    await savePrimeTeamId(undefined, { file })
    expect(JSON.parse(await readFile(file, "utf8")).primeintellectTeamId).toBeUndefined()
  })
  it("saves hidden picker models without duplicates and clears the field when none remain", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveHiddenModels(["together:a/b", "together:a/b", "baseten:c"], { file })
    await saveSelectedModel(model("org/first", "First", 65_536), { file })
    expect((await loadLocalSettings({ file, env: {} })).hiddenModels).toEqual([
      "together:a/b",
      "baseten:c",
    ])
    await saveHiddenModels([], { file })
    expect(JSON.parse(await readFile(file, "utf8")).hiddenModels).toBeUndefined()
    await writeFile(file, JSON.stringify({ version: 1, hiddenModels: "x" }), "utf8")
    await expect(loadLocalSettings({ file, env: {} })).rejects.toThrow(
      "hiddenModels must be an array of strings",
    )
  })
  it("keeps viewed achievements and preferences through model saves and clears", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveAchievementsSeen(["hosted-model"], { file })
    await saveSelectedTheme("nord", { file })
    await saveSelectedModel(model("org/first", "First", 65_536), { file })
    await clearSelectedModel({ file })
    await saveSelectedModel(model("org/second", "Second", 65_536), { file })
    const saved = JSON.parse(await readFile(file, "utf8"))
    expect(saved).toMatchObject({
      achievementsSeen: ["hosted-model"],
      theme: "nord",
      model: "accounts/fireworks/models/org/second",
    })
    expect(saved.fastMode).toBeUndefined()
  })
  it("remembers thinking per model through model changes, reset, and unrelated saves", async () => {
    const file = join(await tempDirectory(), "config.json")
    await Promise.all([
      saveLocalThinking("Qwen/Qwen3.8-27B", "low", { file }),
      saveLocalThinking("prism-ml/Ternary-Bonsai-2-27B-gguf", "medium", { file }),
      saveThinkingVisible(true, { file }),
    ])
    await saveSelectedModel(model("hosted", "Hosted", 65536), { file })
    await clearSelectedModel({ file })
    expect((await loadLocalSettings({ file, env: {} })).localThinking).toEqual({
      "Qwen/Qwen3.8-27B": "low",
      "prism-ml/Ternary-Bonsai-2-27B-gguf": "medium",
    })
    await saveLocalThinking("Qwen/Qwen3.8-27B", "default", { file })
    await expect(
      saveLocalThinking("prism-ml/Ternary-Bonsai-2-27B-gguf", "low", { file }),
    ).rejects.toThrow()
    expect((await loadLocalSettings({ file, env: {} })).localThinking).toEqual({
      "prism-ml/Ternary-Bonsai-2-27B-gguf": "medium",
    })
    expect((await loadLocalSettings({ file, env: {} })).thinkingVisible).toBe(true)
  })
  it("seeds a private independent profile without replacing its later settings", async () => {
    const source = join(await tempDirectory(), "config.json")
    const file = join(await tempDirectory(), "dev", "config.json")
    await saveHostedApiKey(
      "fireworks",
      "fw_fake_import_key",
      model("tool-model", "Tool Model", 131_072),
      {
        file: source,
      },
    )
    await saveThinkingVisible(false, { file: source })
    const original = await readFile(source, "utf8")

    await initializeLocalSettings(source, { file })
    expect(await loadLocalSettings({ file, env: {} })).toEqual(
      await loadLocalSettings({ file: source, env: {} }),
    )
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect((await stat(join(file, ".."))).mode & 0o777).toBe(0o700)
    }

    await saveHostedApiKey("fireworks", "fw_fake_dev_key", undefined, { file })
    await initializeLocalSettings(source, { file })
    expect((await loadLocalSettings({ file, env: {} })).fireworksApiKey).toBe("fw_fake_dev_key")
    expect(await readFile(source, "utf8")).toBe(original)
  })

  it("does not create settings without an installed configuration", async () => {
    const directory = await tempDirectory()
    const file = join(directory, "dev.json")
    await initializeLocalSettings(join(directory, "missing.json"), { file })
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("preserves an existing dev profile even when it has no API key", async () => {
    const directory = await tempDirectory()
    const source = join(directory, "source.json")
    const file = join(directory, "dev.json")
    await saveHostedApiKey("fireworks", "fw_fake_import_key", undefined, { file: source })
    await saveThinkingVisible(false, { file })
    const original = await readFile(file, "utf8")
    await initializeLocalSettings(source, { file })
    expect(await readFile(file, "utf8")).toBe(original)
  })

  it("keeps overlapping whole-file saves from clobbering one another", async () => {
    const file = join(await tempDirectory(), "config", "config.json")
    await saveSubagentPanelVisible(false, { file })

    // Both saves read and rewrite the whole file; fired together they must still each survive.
    await Promise.all([
      saveSelectedModel(
        {
          provider: "local",
          id: "openai/gpt-oss-20b",
          displayName: "gpt-oss 20B",
          contextLength: 32_768,
          supportsImageInput: false,
        },
        { file },
      ),
      saveSubagentPanelVisible(true, { file }),
      saveWorkspacePanelWidth(416, { file }),
    ])

    const saved = await loadLocalSettings({ file })
    expect(saved.model).toBe("openai/gpt-oss-20b")
    expect(saved.subagentPanelVisible).toBe(true)
    expect(saved.workspacePanelWidth).toBe(416)
    await saveWorkspacePanelWidth(undefined, { file })
    expect((await loadLocalSettings({ file })).workspacePanelWidth).toBeUndefined()
  })

  it("stores a Fireworks key without replacing the selected local model", async () => {
    const file = join(await tempDirectory(), "config", "config.json")
    await saveSelectedModel(
      {
        provider: "local",
        id: "openai/gpt-oss-20b",
        displayName: "gpt-oss 20B",
        contextLength: 32_768,
        supportsImageInput: false,
      },
      { file },
    )

    await saveHostedApiKey("fireworks", " fw_test_key ", undefined, { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      fireworksApiKey: "fw_test_key",
      model: "openai/gpt-oss-20b",
      modelProvider: "local",
      modelContextLength: 32_768,
    })
  })

  it("stores the Fireworks key and selected model in a private local file", async () => {
    const file = join(await tempDirectory(), "config", "config.json")
    await saveHostedApiKey(
      "fireworks",
      " fw_test_key ",
      model("tool-model", "Tool Model", 131_072),
      { file },
    )

    await expect(loadLocalSettings({ file, env: {} })).resolves.toEqual({
      fireworksApiKey: "fw_test_key",
      model: "accounts/fireworks/models/tool-model",
      modelDisplayName: "Tool Model",
      modelContextLength: 131_072,
      modelProvider: "fireworks",
      modelSupportsImageInput: false,
    })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      fireworksApiKey: "fw_test_key",
      model: "accounts/fireworks/models/tool-model",
      modelDisplayName: "Tool Model",
      modelContextLength: 131_072,
      modelProvider: "fireworks",
      modelSupportsImageInput: false,
    })
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect((await stat(join(file, ".."))).mode & 0o777).toBe(0o700)
    }
  })

  it("uses FIREWORKS_API_KEY without copying it into a model-only config", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveSelectedModel(model("tool-model", "Tool Model", 131_072), { file })

    await expect(
      loadLocalSettings({ file, env: { FIREWORKS_API_KEY: " fw_env_key " } }),
    ).resolves.toEqual({
      fireworksApiKey: "fw_env_key",
      model: "accounts/fireworks/models/tool-model",
      modelDisplayName: "Tool Model",
      modelContextLength: 131_072,
      modelProvider: "fireworks",
      modelSupportsImageInput: false,
    })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      model: "accounts/fireworks/models/tool-model",
      modelDisplayName: "Tool Model",
      modelContextLength: 131_072,
      modelProvider: "fireworks",
      modelSupportsImageInput: false,
    })
  })

  it("stores one key per hosted provider and keeps every key through model rewrites", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveHostedApiKey("together", " tg_key ", undefined, { file })
    await saveHostedApiKey("baseten", "bt_key", undefined, { file })
    await saveHostedApiKey(
      "primeintellect",
      "pi_key",
      {
        provider: "primeintellect",
        id: "org/model",
        displayName: "Model",
        supportsImageInput: true,
      },
      { file },
    )
    await expect(saveHostedApiKey("together", "  ", undefined, { file })).rejects.toThrow(
      "Together AI API key is required.",
    )

    const loaded = await loadLocalSettings({ file, env: {} })
    expect(loaded).toMatchObject({
      fireworksApiKey: undefined,
      togetherApiKey: "tg_key",
      basetenApiKey: "bt_key",
      primeintellectApiKey: "pi_key",
      model: "org/model",
      modelDisplayName: "Model",
      modelProvider: "primeintellect",
      modelSupportsImageInput: true,
    })
    expect(hostedApiKeys(loaded)).toEqual({
      together: "tg_key",
      baseten: "bt_key",
      primeintellect: "pi_key",
    })

    // Model saves rewrite the whole file; no provider's key may fall out of it.
    await saveSelectedModel(model("new", "New"), { file })
    await saveHostedApiKey("fireworks", "fw_key", undefined, { file })
    await saveSelectedModel(
      {
        provider: "local",
        id: "openai/gpt-oss-20b",
        displayName: "gpt-oss 20B",
        contextLength: 32_768,
        supportsImageInput: false,
      },
      { file },
    )
    await clearSelectedModel({ file })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      fireworksApiKey: "fw_key",
      togetherApiKey: "tg_key",
      basetenApiKey: "bt_key",
      primeintellectApiKey: "pi_key",
    })
    expect(hostedApiKeys(await loadLocalSettings({ file, env: {} }))).toEqual({
      fireworks: "fw_key",
      together: "tg_key",
      baseten: "bt_key",
      primeintellect: "pi_key",
    })
  })

  it("lets each provider's environment variable override its saved key without copying it", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveHostedApiKey("together", "tg_saved", undefined, { file })
    await saveHostedApiKey("baseten", "bt_saved", undefined, { file })
    const env = {
      FIREWORKS_API_KEY: " fw_env ",
      TOGETHER_API_KEY: " tg_env ",
      BASETEN_API_KEY: "",
      PRIME_API_KEY: "pi_env",
    }

    expect(hostedApiKeys(await loadLocalSettings({ file, env }))).toEqual({
      fireworks: "fw_env",
      together: "tg_env",
      baseten: "bt_saved",
      primeintellect: "pi_env",
    })
    expect(hostedApiKeys(await loadLocalSettings({ file, env: {} }))).toEqual({
      together: "tg_saved",
      baseten: "bt_saved",
    })
    await saveSelectedTheme("nord", { file })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      togetherApiKey: "tg_saved",
      basetenApiKey: "bt_saved",
      theme: "nord",
    })
  })

  it("loads a selected model of every hosted provider and rejects an unknown provider", async () => {
    const directory = await tempDirectory()
    for (const provider of ["together", "baseten", "primeintellect"]) {
      const file = join(directory, `${provider}.json`)
      await writeFile(
        file,
        JSON.stringify({ version: 1, model: "org/model", modelProvider: provider }),
        "utf8",
      )
      await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
        model: "org/model",
        modelProvider: provider,
      })
    }
    const unknown = join(directory, "unknown.json")
    await writeFile(
      unknown,
      JSON.stringify({ version: 1, model: "org/model", modelProvider: "openai" }),
      "utf8",
    )
    await expect(loadLocalSettings({ file: unknown, env: {} })).rejects.toThrow(
      "Invalid Otis config: modelProvider is not a known provider.",
    )
    const blankKey = join(directory, "blank-key.json")
    await writeFile(blankKey, JSON.stringify({ version: 1, basetenApiKey: " " }), "utf8")
    await expect(loadLocalSettings({ file: blankKey, env: {} })).rejects.toThrow(
      "Invalid Otis config: basetenApiKey must be a string.",
    )
  })

  it("changes the selected model without replacing a saved key", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveHostedApiKey("fireworks", "fw_test_key", model("old", "Old", 32_768), { file })
    await saveSelectedModel(model("new", "New"), { file })

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      fireworksApiKey: "fw_test_key",
      model: "accounts/fireworks/models/new",
      modelDisplayName: "New",
      modelProvider: "fireworks",
      modelSupportsImageInput: false,
    })
  })

  it("clears only the selected model fields", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveHostedApiKey("fireworks", "fw_test_key", model("tool-model", "Tool Model", 32_768), {
      file,
    })
    await saveSelectedTheme("nord", { file })
    await saveThinkingVisible(true, { file })
    await saveFastServingSelection(model("tool-model", "Tool Model"), false, { file })

    await clearSelectedModel({ file })

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      fireworksApiKey: "fw_test_key",
      theme: "nord",
      thinkingVisible: true,
      fastServingModels: [],
    })
  })

  it.each([
    "graphite",
    "pearl",
    "sage",
    "titanium",
  ] as const)("stores %s without replacing provider settings", async (theme) => {
    const file = join(await tempDirectory(), "config.json")
    await saveHostedApiKey("fireworks", "fw_test_key", model("tool-model", "Tool Model"), { file })
    await saveSelectedTheme(theme, { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({ theme })
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      fireworksApiKey: "fw_test_key",
      theme,
    })
  })

  it("stores the interface language without replacing provider or model settings", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveHostedApiKey("fireworks", "fw_test_key", model("tool-model", "Tool Model"), { file })
    await saveUiLanguage("ja", { file })
    await saveSelectedModel(model("new", "New"), { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      language: "ja",
      fireworksApiKey: "fw_test_key",
      modelDisplayName: "New",
    })
  })

  it("stores subagent panel visibility independently from the selected model", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveHostedApiKey("fireworks", "fw_test_key", model("tool-model", "Tool Model"), { file })
    await saveSubagentPanelVisible(false, { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      subagentPanelVisible: false,
    })
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      fireworksApiKey: "fw_test_key",
      subagentPanelVisible: false,
    })

    await saveSelectedModel(model("accounts/fireworks/models/new", "New"), { file })
    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      subagentPanelVisible: false,
    })
  })

  it("stores thinking visibility independently from reasoning behavior", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveHostedApiKey("fireworks", "fw_test_key", model("tool-model", "Tool Model"), { file })
    await saveThinkingVisible(true, { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      thinkingVisible: true,
    })
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      fireworksApiKey: "fw_test_key",
      thinkingVisible: true,
    })
  })

  it("stores a model's Fast serving path without selecting it", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveSelectedModel(
      {
        provider: "fireworks",
        id: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        supportsImageInput: false,
        fastId: "accounts/fireworks/routers/kimi-k3-fast",
      },
      { file },
    )

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      model: "accounts/fireworks/models/kimi-k3",
      modelFastId: "accounts/fireworks/routers/kimi-k3-fast",
    })

    await saveSelectedModel(model("tool-model", "Tool Model"), { file })
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("modelFastId")
  })

  it("stores Fast serving preferences per model", async () => {
    const file = join(await tempDirectory(), "config.json")
    const alpha = fastModel("alpha", "Alpha")
    const beta = fastModel("beta", "Beta")
    await saveHostedApiKey("fireworks", "fw_test_key", alpha, { file })
    await saveFastServingSelection({ ...alpha, id: alpha.fastId }, true, { file })
    await saveFastServingSelection({ ...beta, id: beta.fastId }, true, { file })
    await saveFastServingSelection(alpha, false, { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      model: alpha.id,
      fastServingModels: [beta.id],
    })
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      fireworksApiKey: "fw_test_key",
      model: alpha.id,
      fastServingModels: [beta.id],
    })
  })

  it("migrates the released global Fast preference to the selected model", async () => {
    const file = join(await tempDirectory(), "config.json")
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        model: "accounts/fireworks/models/alpha",
        modelProvider: "fireworks",
        fastMode: true,
      }),
      "utf8",
    )

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      fastServingModels: ["accounts/fireworks/models/alpha"],
    })

    await saveSelectedModel(model("beta", "Beta"), { file })
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      model: "accounts/fireworks/models/beta",
      fastServingModels: ["accounts/fireworks/models/alpha"],
    })
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("fastMode")
  })

  it("loads and preserves permission policy while changing other settings", async () => {
    const file = join(await tempDirectory(), "config.json")
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        permissions: {
          defaultMode: "ask",
          rules: [{ tool: "bash", resource: "git status", effect: "allow" }],
        },
      }),
      "utf8",
    )

    await saveSelectedTheme("nord", { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      theme: "nord",
      permissions: {
        defaultMode: "ask",
        rules: [{ tool: "bash", resource: "git status", effect: "allow" }],
      },
    })
  })

  it("updates the default permission mode without clearing permission rules", async () => {
    const file = join(await tempDirectory(), "config.json")
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        permissions: {
          defaultMode: "ask",
          rules: [{ tool: "bash", resource: "git status", effect: "allow" }],
        },
      }),
      "utf8",
    )

    await savePermissionMode("auto", { file })

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      permissions: {
        defaultMode: "auto",
        rules: [{ tool: "bash", resource: "git status", effect: "allow" }],
      },
    })
  })

  it("rejects malformed permission policy", async () => {
    const file = join(await tempDirectory(), "config.json")
    await writeFile(
      file,
      JSON.stringify({ version: 1, permissions: { rules: [{ tool: "bash", effect: "maybe" }] } }),
      "utf8",
    )
    await expect(loadLocalSettings({ file, env: {} })).rejects.toThrow("allow, ask, or deny")
  })

  it("stores a selected local model without clearing a saved Fireworks key", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveHostedApiKey("fireworks", "fw_test_key", model("tool-model", "Tool Model"), { file })
    await saveSelectedModel(
      {
        provider: "local",
        id: "openai/gpt-oss-20b",
        displayName: "gpt-oss 20B",
        contextLength: 32_768,
        supportsImageInput: false,
      },
      { file },
    )

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      fireworksApiKey: "fw_test_key",
      model: "openai/gpt-oss-20b",
      modelProvider: "local",
      modelContextLength: 32_768,
    })
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("modelFastId")
  })

  it("stores the selected PAIR engine and preserves configured endpoints across provider changes", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveHostedApiKey("fireworks", "fw_test_key", model("tool-model", "Tool Model"), { file })
    await saveSelectedModel(
      {
        provider: "pair",
        id: "qwen3.5:35b",
        displayName: "Qwen 3.5 35B",
        baseURL: "http://127.0.0.1:11434",
        engine: "ollama",
        nativeContextLength: 262_144,
        supportsImageInput: false,
      },
      { file },
    )

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      fireworksApiKey: "fw_test_key",
      pairEndpoints: { ollama: "http://127.0.0.1:11434" },
      pairEngine: "ollama",
      model: "qwen3.5:35b",
      modelProvider: "pair",
      modelContextLength: undefined,
    })
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("modelContextLength")

    await saveSelectedModel(model("hosted", "Hosted"), { file })
    const hostedSettings = await loadLocalSettings({ file, env: {} })
    expect(hostedSettings).toMatchObject({
      pairEndpoints: { ollama: "http://127.0.0.1:11434" },
      modelProvider: "fireworks",
    })
    expect(hostedSettings.pairEngine).toBeUndefined()
  })

  it("keeps a paused daemon pairing on file and rejects a non-boolean paused flag", async () => {
    const directory = await tempDirectory()
    const file = join(directory, "config.json")
    await saveRemote({ url: "ws://linux-box:7331", token: "secret", paused: true }, { file })
    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      remote: { url: "ws://linux-box:7331", token: "secret", paused: true },
    })
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        remote: { url: "ws://linux-box:7331", token: "secret", paused: "yes" },
      }),
      "utf8",
    )
    await expect(loadLocalSettings({ file, env: {} })).rejects.toThrow(
      "remote.paused must be a boolean",
    )
  })

  it("normalizes saved PAIR endpoints and rejects non-local addresses", async () => {
    const directory = await tempDirectory()
    const local = join(directory, "local.json")
    const remote = join(directory, "remote.json")
    await writeFile(
      local,
      JSON.stringify({ version: 1, pairEndpoints: { ollama: "http://localhost:11434/v1" } }),
      "utf8",
    )
    await writeFile(
      remote,
      JSON.stringify({ version: 1, pairEndpoints: { ollama: "http://192.168.1.10:11434" } }),
      "utf8",
    )

    await expect(loadLocalSettings({ file: local, env: {} })).resolves.toMatchObject({
      pairEndpoints: { ollama: "http://localhost:11434" },
    })
    await expect(loadLocalSettings({ file: remote, env: {} })).rejects.toThrow(
      "Invalid Otis config",
    )
  })

  it("stores every verified PAIR endpoint independently from the selected provider", async () => {
    const file = join(await tempDirectory(), "config.json")
    await saveSelectedModel(model("hosted", "Hosted"), { file })
    await saveLocalServers(
      {
        pairEndpoints: { ollama: "http://127.0.0.1:22111/v1", lmStudio: "http://127.0.0.1:22112" },
      },
      { file },
    )

    await expect(loadLocalSettings({ file, env: {} })).resolves.toMatchObject({
      pairEndpoints: {
        ollama: "http://127.0.0.1:22111",
        lmStudio: "http://127.0.0.1:22112",
      },
      modelProvider: "fireworks",
    })
  })

  it("falls back to the default theme for unrecognized saved names", async () => {
    const directory = await tempDirectory()
    // Aliases must not resolve to a theme, and a removed or unknown name must not block startup.
    for (const alias of ["dark", "gray", "white", "meadow", 42]) {
      const file = join(directory, `${String(alias)}.json`)
      await writeFile(file, JSON.stringify({ version: 1, theme: alias }), "utf8")
      const loaded = await loadLocalSettings({ file, env: {} })
      expect(loaded.theme, String(alias)).toBeUndefined()
    }
  })

  it("returns an empty configuration for a missing file", async () => {
    await expect(
      loadLocalSettings({ file: join(await tempDirectory(), "missing.json"), env: {} }),
    ).resolves.toEqual({
      fireworksApiKey: undefined,
      model: undefined,
      modelDisplayName: undefined,
      modelContextLength: undefined,
      modelSupportsImageInput: undefined,
    })
  })

  it("rejects malformed and unsupported configuration files", async () => {
    const directory = await tempDirectory()
    const malformed = join(directory, "malformed.json")
    const unsupported = join(directory, "unsupported.json")
    const invalidMetadata = join(directory, "invalid-metadata.json")
    const invalidThinking = join(directory, "invalid-thinking.json")
    const invalidSubagentPanel = join(directory, "invalid-subagent-panel.json")
    const invalidPanelWidth = join(directory, "invalid-panel-width.json")
    const invalidFastMode = join(directory, "invalid-fast-mode.json")
    const invalidFastServingModels = join(directory, "invalid-fast-serving-models.json")
    const invalidPairEndpoints = join(directory, "invalid-pair-endpoints.json")
    const invalidPairEngine = join(directory, "invalid-pair-engine.json")
    await writeFile(malformed, "{broken", "utf8")
    await writeFile(unsupported, JSON.stringify({ version: 2 }), "utf8")
    await writeFile(invalidMetadata, JSON.stringify({ version: 1, modelContextLength: -1 }), "utf8")
    await writeFile(
      invalidThinking,
      JSON.stringify({ version: 1, thinkingVisible: "sometimes" }),
      "utf8",
    )
    await writeFile(
      invalidSubagentPanel,
      JSON.stringify({ version: 1, subagentPanelVisible: "sometimes" }),
      "utf8",
    )
    await writeFile(
      invalidPanelWidth,
      JSON.stringify({ version: 1, workspacePanelWidth: -1 }),
      "utf8",
    )
    await writeFile(invalidFastMode, JSON.stringify({ version: 1, fastMode: "sometimes" }), "utf8")
    await writeFile(
      invalidFastServingModels,
      JSON.stringify({ version: 1, fastServingModels: [false] }),
      "utf8",
    )
    await writeFile(invalidPairEndpoints, JSON.stringify({ version: 1, pairEndpoints: [] }), "utf8")
    await writeFile(
      invalidPairEngine,
      JSON.stringify({ version: 1, pairEngine: "llama.cpp" }),
      "utf8",
    )

    await expect(loadLocalSettings({ file: malformed, env: {} })).rejects.toThrow(
      "Invalid Otis config",
    )
    await expect(loadLocalSettings({ file: unsupported, env: {} })).rejects.toThrow(
      "unsupported version",
    )
    await expect(loadLocalSettings({ file: invalidMetadata, env: {} })).rejects.toThrow(
      "positive integer",
    )
    await expect(loadLocalSettings({ file: invalidThinking, env: {} })).rejects.toThrow(
      "thinkingVisible must be",
    )
    await expect(loadLocalSettings({ file: invalidSubagentPanel, env: {} })).rejects.toThrow(
      "subagentPanelVisible must be",
    )
    await expect(loadLocalSettings({ file: invalidPanelWidth, env: {} })).rejects.toThrow(
      "workspacePanelWidth must be",
    )
    await expect(loadLocalSettings({ file: invalidFastMode, env: {} })).rejects.toThrow(
      "fastMode must be",
    )
    await expect(loadLocalSettings({ file: invalidFastServingModels, env: {} })).rejects.toThrow(
      "fastServingModels must be",
    )
    await expect(loadLocalSettings({ file: invalidPairEndpoints, env: {} })).rejects.toThrow(
      "pairEndpoints must be an object",
    )
    await expect(loadLocalSettings({ file: invalidPairEngine, env: {} })).rejects.toThrow(
      "pairEngine must be ollama or lmstudio",
    )
  })
})

async function tempDirectory() {
  const path = await mkdtemp(join(tmpdir(), "otis-settings-"))
  tempDirectories.push(path)
  return path
}

function model(name: string, displayName: string, contextLength?: number) {
  return {
    provider: "fireworks" as const,
    id: `accounts/fireworks/models/${name}`,
    displayName,
    supportsImageInput: false,
    ...(contextLength ? { contextLength } : {}),
  }
}

function fastModel(name: string, displayName: string) {
  return {
    ...model(name, displayName),
    fastId: `accounts/fireworks/routers/${name}-fast`,
  }
}

describe("settings write path pinning", () => {
  it("resolves the target file before queueing, so an OTIS_HOME flip mid-write cannot redirect it", async () => {
    const first = await tempDirectory()
    const second = await tempDirectory()
    process.env.OTIS_HOME = first
    try {
      const { saveLastWorkspace } = await import("../../src/local/settings.js")
      // Not awaited: the write runs while the environment flips to another home.
      const pending = saveLastWorkspace(join(first, "workspace"))
      process.env.OTIS_HOME = second
      await pending
      // The save must land entirely in the home that was active when it was requested.
      const written = JSON.parse(await readFile(join(first, "config.json"), "utf8"))
      expect(written.lastWorkspace).toBe(join(first, "workspace"))
      await expect(readFile(join(second, "config.json"), "utf8")).rejects.toThrow()
    } finally {
      delete process.env.OTIS_HOME
    }
  })
})
