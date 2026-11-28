//! The Otis runtime this UI drives: `rpc`, the desktop API as newline-delimited wire frames
//! (src/desktop/wire.ts) on its stdin and stdout. Calls go out by method name with an id; answers
//! come back by id, and the runtime's event stream arrives between them.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{Value, json};

/// The runtime: `OTIS_RUNTIME` when set, else the one a release build carries, else the
/// TypeScript source run with Bun. `otis update` replaces this binary, not the runtime it runs.
pub fn runtime_command() -> std::io::Result<Command> {
    let mut command = match std::env::var_os("OTIS_RUNTIME") {
        Some(path) => Command::new(path),
        None => bundled()?,
    };
    if let Ok(exe) = std::env::current_exe() {
        command.env("OTIS_UPDATE_TARGET", exe);
    }
    Ok(command)
}

/// The embedded runtime, unpacked once into Otis' data folder (as src/local/paths.ts resolves it)
/// under a name its contents decide, with copies other versions left there removed.
#[cfg(embedded_runtime)]
fn bundled() -> std::io::Result<Command> {
    use std::path::PathBuf;
    static RUNTIME: &[u8] = include_bytes!(env!("OTIS_RUNTIME_PAYLOAD"));
    let var =
        |name: &str| std::env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from);
    let home = std::env::home_dir().unwrap_or_default();
    let data = if let Some(otis_home) = var("OTIS_HOME") {
        otis_home
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support/otis")
    } else if cfg!(windows) {
        var("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local")).join("otis")
    } else {
        var("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local/share")).join("otis")
    };
    let folder = data.join("runtime");
    let name =
        format!("otis-runtime-{}{}", env!("OTIS_RUNTIME_DIGEST"), std::env::consts::EXE_SUFFIX);
    let path = folder.join(&name);
    if !path.is_file() {
        std::fs::create_dir_all(&folder)?;
        // Written aside and renamed, so a second Otis starting at once never runs half a file.
        let partial = folder.join(format!(".{name}.{}", std::process::id()));
        std::fs::write(&partial, RUNTIME)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(&partial, &path)?;
        // A copy another Otis still runs may refuse removal; the next start tries again.
        for old in std::fs::read_dir(&folder)?.flatten() {
            if old.file_name() != name.as_str()
                && !old.file_name().to_string_lossy().starts_with('.')
            {
                let _ = std::fs::remove_file(old.path());
            }
        }
    }
    Ok(Command::new(path))
}

#[cfg(not(embedded_runtime))]
fn bundled() -> std::io::Result<Command> {
    let entry = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/cli/index.ts");
    let mut command = Command::new("bun");
    command.arg("run").arg(entry);
    Ok(command)
}

pub enum Incoming {
    Reply {
        id: u64,
        result: Result<Value, String>,
    },
    Event(Value),
    /// A session finished, for a cue while the UI is not in front.
    Notify,
    /// The runtime's stdout closed: it exited, with the last of what it wrote to stderr.
    Exited(String),
}

pub struct Runtime {
    child: Child,
    stdin: Option<ChildStdin>,
    next_id: u64,
}

impl Runtime {
    pub fn spawn(deliver: impl Fn(Incoming) + Send + 'static) -> std::io::Result<Self> {
        let mut child = runtime_command()?
            .arg("rpc")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        // The terminal belongs to the UI, so diagnostics are kept for when the runtime dies. Read
        // as bytes: a line that is not UTF-8 must not stop the draining, or the runtime blocks.
        let tail = Arc::new(Mutex::new(VecDeque::new()));
        let kept = tail.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).split(b'\n').map_while(Result::ok) {
                let mut tail = kept.lock().unwrap();
                if tail.len() == 20 {
                    tail.pop_front();
                }
                tail.push_back(String::from_utf8_lossy(&line).into_owned());
            }
        });
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(incoming) = incoming(frame) {
                    deliver(incoming);
                }
            }
            let tail: Vec<String> = tail.lock().unwrap().iter().cloned().collect();
            deliver(Incoming::Exited(tail.join("\n")));
        });
        let stdin = child.stdin.take();
        Ok(Self { child, stdin, next_id: 0 })
    }

    /// Sends a call and returns its id; a runtime that has gone answers through `Exited`.
    pub fn call(&mut self, method: &str, args: Vec<Value>) -> u64 {
        self.next_id += 1;
        let frame = json!({ "id": self.next_id, "method": method, "args": args });
        if let Some(stdin) = &mut self.stdin {
            let _ = writeln!(stdin, "{frame}").and_then(|()| stdin.flush());
        }
        self.next_id
    }

    /// Closes the runtime's stdin, which ends it, and waits while it stops its local models.
    pub fn shutdown(mut self) {
        self.stdin = None;
        let _ = self.child.wait();
    }
}

fn incoming(mut frame: Value) -> Option<Incoming> {
    undefined_to_null(&mut frame);
    let frame = frame.as_object_mut()?;
    if let Some(event) = frame.remove("event") {
        return Some(Incoming::Event(event));
    }
    if frame.contains_key("notify") {
        return Some(Incoming::Notify);
    }
    let id = frame.get("id")?.as_u64()?;
    let result = match frame.remove("error") {
        Some(error) => Err(error.as_str().unwrap_or("The runtime failed.").to_string()),
        None => Ok(frame.remove("result").unwrap_or(Value::Null)),
    };
    Some(Incoming::Reply { id, result })
}

/// The wire's marker for a field set to undefined, which JSON has no word for, becomes null: a
/// status field cleared, or an entry field absent.
fn undefined_to_null(value: &mut Value) {
    match value {
        Value::Object(map)
            if map.len() == 1 && map.get("$undefined") == Some(&Value::Bool(true)) =>
        {
            *value = Value::Null
        }
        Value::Object(map) => map.values_mut().for_each(undefined_to_null),
        Value::Array(items) => items.iter_mut().for_each(undefined_to_null),
        _ => {}
    }
}

/// Bytes ride the wire as base64 under `$bytes`.
pub fn bytes(data: &[u8]) -> Value {
    use base64::Engine;
    json!({ "$bytes": base64::engine::general_purpose::STANDARD.encode(data) })
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[default]
    Message,
    Reasoning,
    Tool,
    Debug,
    Notice,
}

/// One transcript entry (src/app/transcript.ts), with the fields a terminal shows.
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Entry {
    pub id: u64,
    pub kind: Kind,
    pub speaker: String,
    pub text: String,
    pub activity_kind: Option<String>,
    pub activity_action: Option<String>,
    pub activity_subject: Option<String>,
    pub duration_ms: Option<f64>,
    pub diff: Option<String>,
    pub outcome: Option<String>,
    pub artifact: Option<Artifact>,
    pub artifact_display: Option<String>,
    pub artifacts: Option<Vec<Artifact>>,
    pub message_text: Option<String>,
    pub images: Option<Vec<String>>,
    pub network: Option<String>,
    pub streaming: bool,
    pub delivery: Option<String>,
}

impl Entry {
    pub fn by_user(&self) -> bool {
        self.speaker == "You"
    }
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Artifact {
    pub source: String,
    pub kind: String,
    pub path: Option<String>,
    pub name: Option<String>,
}

impl Artifact {
    pub fn title(&self) -> &str {
        match &self.path {
            Some(path) if self.source == "workspace" => path.rsplit('/').next().unwrap_or(path),
            _ => self.name.as_deref().unwrap_or("document"),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Op {
    Reset { entries: Vec<Entry> },
    Upsert { entry: Box<Entry> },
    Append { id: u64, at: usize, text: String },
    Remove { id: u64 },
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Status {
    pub busy: bool,
    pub phase: String,
    pub speed: Option<Speed>,
    pub model: Option<Model>,
    pub model_state: String,
    pub model_error: Option<String>,
    pub session: Option<Session>,
    pub needs_workspace: bool,
    pub sessions: Vec<SessionItem>,
    pub workspace: Workspace,
    pub context_tokens: Option<f64>,
    pub context_limit: f64,
    pub permission: Option<Permission>,
    pub permission_queue: u32,
    pub model_load: Option<ModelLoad>,
    pub theme: String,
    pub thinking_visible: bool,
    pub permission_mode: String,
    pub hosted_configured: HashMap<String, bool>,
    /// Picker rows the user favorited, by their selection keys.
    pub favorite_models: Vec<String>,
    /// Models kept out of the picker, by `provider:id`.
    pub hidden_models: Vec<String>,
    pub notify_on_completion: bool,
    pub keep_awake: bool,
    pub offline_fallback: bool,
    pub debug: bool,
    pub offline: Option<Value>,
    /// Local usage statistics; absent until the first scan of the history completes.
    pub stats: Option<Stats>,
    /// The thinking effort the active local model offers, when it offers one.
    pub local_thinking: Option<LocalThinking>,
    /// The session's delegated runs, oldest first.
    pub subagents: Vec<Subagent>,
    pub pair_endpoints: PairEndpoints,
    /// The connected user-managed servers, by provider.
    pub servers: HashMap<String, Server>,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalThinking {
    pub model_id: String,
    pub selected: String,
    pub levels: Vec<String>,
    pub default_level: String,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Subagent {
    pub tool_call_id: String,
    pub title: String,
    pub status: String,
    pub duration_ms: Option<f64>,
    pub tools: u32,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct PairEndpoints {
    pub ollama: Option<String>,
    pub lm_studio: Option<String>,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Server {
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub model: Option<String>,
    pub context_length: Option<u64>,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Stats {
    pub streak: f64,
    pub total_tokens: f64,
    pub avg_tokens_per_session: f64,
    pub avg_session_seconds: f64,
    pub today_tokens: f64,
    pub recent_activity: Vec<Day>,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Day {
    pub date: String,
    pub tokens: f64,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Speed {
    pub tokens_per_second: f64,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Model {
    pub id: String,
    pub provider: String,
    pub display_name: Option<String>,
    pub supports_image_input: bool,
}

impl Model {
    pub fn name(&self) -> &str {
        self.display_name.as_deref().unwrap_or(&self.id)
    }
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Session {
    pub id: String,
    pub title: String,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionItem {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub dir_name: String,
    pub workspace_label: String,
    pub workspace_path: Option<String>,
    pub snippet: Option<String>,
    pub working: Option<bool>,
    pub active: Option<bool>,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Workspace {
    pub label: String,
    pub path: String,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Permission {
    pub id: u64,
    pub label: String,
    pub kind: String,
    pub resources: Vec<String>,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelLoad {
    pub model_id: String,
    pub status: LoadStatus,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct LoadStatus {
    pub label: String,
    pub kind: String,
    pub percent: Option<f64>,
}

/// The focused session as the runtime streams it: the status fields merged as they change, and the
/// transcript patched in revision order.
#[derive(Default)]
pub struct State {
    /// The status fields as last merged, an object the status deserializes from in place.
    fields: Value,
    pub status: Status,
    pub entries: Vec<Entry>,
    pub version: String,
    revision: u64,
    /// Bumped by every reset, so the UI knows the entries it printed are no longer these.
    pub resets: u64,
    /// The snapshot has arrived.
    pub loaded: bool,
    early: Vec<Value>,
}

impl State {
    /// Seeds from `getSnapshot`; events that arrived before it apply after it, if newer.
    pub fn load(&mut self, snapshot: Value) {
        let Value::Object(mut snapshot) = snapshot else {
            return;
        };
        self.revision = snapshot.remove("revision").and_then(|r| r.as_u64()).unwrap_or(0);
        self.version = snapshot
            .remove("version")
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default();
        self.entries = entries_from(snapshot.remove("entries").unwrap_or_default());
        // The other panes' transcripts are a desktop window's; this UI shows the focused session.
        snapshot.remove("transcripts");
        snapshot.retain(|_, value| !value.is_null());
        self.fields = Value::Object(snapshot);
        self.status = Status::deserialize(&self.fields).unwrap_or_default();
        self.resets += 1;
        self.loaded = true;
        for event in std::mem::take(&mut self.early) {
            self.apply(event);
        }
    }

    pub fn apply(&mut self, event: Value) {
        if !self.loaded {
            self.early.push(event);
            return;
        }
        let Value::Object(mut event) = event else {
            return;
        };
        let revision = event.get("revision").and_then(Value::as_u64).unwrap_or(0);
        if revision <= self.revision {
            return;
        }
        self.revision = revision;
        if let (Some(Value::Object(changed)), Some(fields)) =
            (event.remove("status"), self.fields.as_object_mut())
        {
            for (key, value) in changed {
                if value.is_null() {
                    fields.remove(&key);
                } else {
                    fields.insert(key, value);
                }
            }
            // A field that fails to read keeps the last good status rather than blanking all of it.
            if let Ok(status) = Status::deserialize(&self.fields) {
                self.status = status;
            }
        }
        let Some(Value::Array(ops)) = event.remove("ops") else {
            return;
        };
        for mut op in ops {
            strip_nulls(&mut op);
            match serde_json::from_value(op) {
                Ok(Op::Reset { entries }) => {
                    self.entries = entries;
                    self.resets += 1;
                }
                Ok(Op::Upsert { entry }) => {
                    match self.entries.iter_mut().find(|e| e.id == entry.id) {
                        Some(existing) => *existing = *entry,
                        None => self.entries.push(*entry),
                    }
                }
                Ok(Op::Append { id, at, text }) => {
                    if let Some(entry) = self.entries.iter_mut().find(|e| e.id == id) {
                        entry.text.truncate(utf16_to_byte(&entry.text, at));
                        entry.text.push_str(&text);
                    }
                }
                Ok(Op::Remove { id }) => self.entries.retain(|e| e.id != id),
                Err(_) => {}
            }
        }
    }
}

/// Transcript entries from the wire, as a snapshot or a delegated run's trace carries them.
pub fn entries_from(mut entries: Value) -> Vec<Entry> {
    strip_nulls(&mut entries);
    serde_json::from_value(entries).unwrap_or_default()
}

/// An absent field and one set to undefined read the same on an entry.
fn strip_nulls(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|_, v| !v.is_null());
            map.values_mut().for_each(strip_nulls);
        }
        Value::Array(items) => items.iter_mut().for_each(strip_nulls),
        _ => {}
    }
}

/// The byte index of a JavaScript string offset, which counts UTF-16 code units.
fn utf16_to_byte(text: &str, offset: usize) -> usize {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        if units >= offset {
            return index;
        }
        units += ch.len_utf16();
    }
    text.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loaded() -> State {
        let mut state = State::default();
        state.load(json!({
            "revision": 3,
            "version": "0.3.4",
            "entries": [{ "id": 1, "kind": "message", "speaker": "You", "text": "hi" }],
            "busy": false,
            "modelState": "ready",
        }));
        state
    }

    #[test]
    fn patches_the_transcript_in_revision_order() {
        let mut state = loaded();
        let entry = json!({ "id": 2, "speaker": "Otis", "text": "Hé", "streaming": true });
        state.apply(json!({ "type": "transcript", "revision": 4, "ops": [
            { "op": "upsert", "entry": entry },
            { "op": "append", "id": 2, "at": 2, "text": "llo" },
        ]}));
        // An event the snapshot already covered changes nothing.
        state.apply(
            json!({ "type": "transcript", "revision": 2, "ops": [{ "op": "remove", "id": 1 }] }),
        );
        let texts: Vec<_> = state.entries.iter().map(|e| e.text.as_str()).collect();
        assert_eq!(texts, ["hi", "Héllo"]);
        assert!(state.entries[1].streaming);
    }

    #[test]
    fn appends_at_utf16_offsets() {
        let mut text = String::from("😀ab");
        text.truncate(utf16_to_byte(&text, 3));
        assert_eq!(text, "😀a");
    }

    #[test]
    fn merges_status_fields_and_clears_undefined_ones() {
        let mut state = loaded();
        let frame = json!({ "event": { "type": "status", "revision": 4, "status": {
            "busy": true, "modelError": "Out of credit",
        }}});
        let Some(Incoming::Event(event)) = incoming(frame) else { panic!() };
        state.apply(event);
        assert!(state.status.busy);
        assert_eq!(state.status.model_error.as_deref(), Some("Out of credit"));
        let frame = json!({ "event": { "type": "status", "revision": 5, "status": {
            "modelError": { "$undefined": true },
        }}});
        let Some(Incoming::Event(event)) = incoming(frame) else { panic!() };
        state.apply(event);
        assert_eq!(state.status.model_error, None);
        assert!(state.status.busy);
    }

    #[test]
    fn holds_events_that_arrive_before_the_snapshot() {
        let mut state = State::default();
        state.apply(json!({ "type": "status", "revision": 2, "status": { "busy": true } }));
        state.apply(json!({ "type": "status", "revision": 9, "status": { "phase": "working" } }));
        state.load(json!({ "revision": 5, "entries": [], "busy": false }));
        assert!(!state.status.busy);
        assert_eq!(state.status.phase, "working");
    }

    #[test]
    fn reads_replies_by_id() {
        let Some(Incoming::Reply { id, result }) = incoming(json!({ "id": 7, "error": "No." }))
        else {
            panic!()
        };
        assert_eq!((id, result), (7, Err("No.".to_string())));
    }
}
