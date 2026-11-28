//! The terminal UI over the runtime: what the user types, what the runtime streams back, and the
//! live region drawn from both under the transcript's scrollback.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::composer::Composer;
use crate::home::{self, Home};
use crate::protocol::{self, Incoming, Kind, Runtime, State, Status};
use crate::screen::Screen;
use crate::text::{self, fill, lead, wrap};
use crate::theme::{Terminal, Theme};
use crate::transcript::{self, Look, MARGIN, indented, margin};

/// The commands and what each does. `/queue`, `/effort`, `/agents`, and `/locate` are offered only
/// when they apply.
const COMMANDS: [(&str, &str); 17] = [
    ("/new", "Start a new session"),
    ("/history", "Open a past session"),
    ("/fork", "Branch this session into a new one"),
    ("/model", "Choose a model"),
    ("/connect", "Add a provider's API key or a local model server"),
    ("/queue", "Run a separate follow-up after this turn: /queue <prompt>"),
    ("/copy", "Copy the last answer to the clipboard"),
    ("/effort", "Set the local model's thinking effort"),
    ("/agents", "Read a delegated run's whole trace"),
    ("/locate", "Point this session at its moved folder: /locate <path>"),
    ("/compact", "Summarize older turns to free context"),
    ("/thinking", "Show or hide thinking traces"),
    ("/settings", "Theme, permissions, notifications, and more"),
    ("/skills", "List skills, or install, update, or remove a collection"),
    ("/memory", "See what Otis remembers, or remember or forget a fact"),
    ("/feedback", "Email the developer a bug or an idea"),
    ("/exit", "Quit Otis"),
];

const PROVIDERS: [(&str, &str); 6] = [
    ("openrouter", "OpenRouter"),
    ("fireworks", "Fireworks AI"),
    ("together", "Together AI"),
    ("baseten", "Baseten"),
    ("primeintellect", "Prime Intellect"),
    ("river", "River AI"),
];

/// The user-managed servers on loopback, by their key in `connectLocalServers`: name and the
/// address each listens on by default.
const SERVERS: [(&str, &str, &str); 4] = [
    ("ollama", "NVIDIA PAIR · Ollama", "http://127.0.0.1:11434"),
    ("lmStudio", "NVIDIA PAIR · LM Studio", "http://127.0.0.1:1234"),
    ("omlx", "oMLX", "http://127.0.0.1:8000"),
    ("custom", "Custom server", "http://127.0.0.1:8080"),
];

const THEMES: [&str; 15] = [
    "default",
    "nord",
    "bright",
    "matrix",
    "midnight",
    "graphite",
    "beige",
    "vice",
    "eagan",
    "pearl",
    "ember",
    "titanium",
    "porcelain",
    "arcade",
    "handheld",
];

const IMAGE_TYPES: [(&str, &str); 8] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("bmp", "image/bmp"),
    ("tif", "image/tiff"),
    ("tiff", "image/tiff"),
    ("ppm", "image/x-portable-pixmap"),
];

const DOCUMENT_EXTENSIONS: [&str; 45] = [
    "txt", "text", "md", "markdown", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml",
    "xml", "html", "htm", "css", "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "py", "rb",
    "go", "rs", "java", "c", "cc", "cpp", "h", "hh", "hpp", "sh", "zsh", "fish", "sql", "ini",
    "cfg", "conf", "env", "pdf", "docx",
];

/// Rows the composer grows to before it scrolls.
const COMPOSER_ROWS: usize = 10;
/// Rows a picker shows at once.
const PICKER_ROWS: usize = 12;
/// How long a first Ctrl+C waits for the second that quits.
const QUIT_WINDOW: Duration = Duration::from_millis(1500);
/// Rejections that are the user's own doing, never worth a notice.
const QUIET_REASONS: [&str; 2] = ["The selection was cancelled.", "The selection was superseded."];

/// What a reply to a call is for.
enum Reply {
    Snapshot,
    /// Anything whose only answer worth showing is a refusal's reason.
    Op,
    /// A model selection, which closes the picker once it lands.
    Select,
    /// A provider key or local server saved, which opens the models it brought.
    Connected,
    /// A local model's files removed, which relists the catalog.
    Deleted,
    Models,
    Skills {
        print: bool,
    },
    Memory,
    Release,
    Feedback,
    /// A delegated run's transcript, with its title.
    Trace(String),
}

struct Attachment {
    name: String,
    mime: &'static str,
    bytes: Vec<u8>,
}

#[derive(PartialEq, Clone, Copy)]
enum PickerKind {
    Model,
    Session,
    Provider,
    Theme,
    Settings,
    Effort,
    Agents,
}

#[derive(Default, Clone)]
struct Row {
    key: String,
    label: String,
    detail: String,
    header: bool,
    active: bool,
    favorite: bool,
    disabled: bool,
    /// A downloaded managed-local model, by the id `deleteLocalModel` takes.
    deletable: Option<String>,
    /// A session's workspace folder and session store.
    path: Option<String>,
    dir: String,
}

impl Row {
    fn header(key: &str, label: &str) -> Self {
        Self { key: key.into(), label: label.into(), header: true, ..Self::default() }
    }
}

struct Picker {
    kind: PickerKind,
    title: &'static str,
    query: String,
    rows: Vec<Row>,
    /// The selected row's key, kept across refreshes and filtering.
    selected: Option<String>,
    loading: bool,
}

impl Picker {
    fn new(kind: PickerKind, title: &'static str, rows: Vec<Row>) -> Self {
        let selected = rows.iter().find(|row| row.active && !row.header).map(|row| row.key.clone());
        Self { kind, title, query: String::new(), rows, selected, loading: false }
    }

    /// The rows the query matches, each section's header kept above its matches.
    fn visible(&self) -> Vec<&Row> {
        let query = self.query.to_lowercase();
        let mut shown = Vec::new();
        let mut header: Option<&Row> = None;
        for row in &self.rows {
            if row.header {
                header = Some(row);
            } else if format!("{} {}", row.label, row.detail).to_lowercase().contains(&query) {
                shown.extend(header.take());
                shown.push(row);
            }
        }
        shown
    }

    fn current(&self) -> Option<&Row> {
        let rows: Vec<&Row> = self.visible().into_iter().filter(|row| !row.header).collect();
        let found = rows.iter().find(|row| Some(&row.key) == self.selected.as_ref());
        found.or(rows.first()).copied()
    }

    fn step(&mut self, by: isize) {
        let rows: Vec<&Row> = self.visible().into_iter().filter(|row| !row.header).collect();
        if rows.is_empty() {
            return;
        }
        let index =
            rows.iter().position(|row| Some(&row.key) == self.selected.as_ref()).unwrap_or(0);
        let next = (index as isize + by).clamp(0, rows.len() as isize - 1) as usize;
        self.selected = Some(rows[next].key.clone());
    }
}

/// A line typed in for a hosted provider's API key, or a local server's address, by its key.
enum Field {
    Key(&'static str, String),
    Server(&'static str, String),
}

enum Overlay {
    Picker(Picker),
    Field(Field),
}

pub struct App {
    runtime: Runtime,
    state: State,
    terminal: Terminal,
    theme: Theme,
    /// The colors last given to the terminal, so a theme repaints it only when it changes.
    painted: String,
    screen: Screen,
    size: (u16, u16),
    composer: Composer,
    attachments: Vec<Attachment>,
    pending: HashMap<u64, Reply>,
    /// Lines waiting to go into the scrollback with the next draw.
    scroll: Vec<Line<'static>>,
    /// The home screen is live: the session is empty and nothing has printed under it yet.
    home: bool,
    /// When the home screen's figures started counting up.
    counted_from: Option<Instant>,
    /// The entries printed to the scrollback; they never redraw.
    printed: HashSet<u64>,
    resets: u64,
    session: Option<String>,
    overlay: Option<Overlay>,
    /// The model catalog as last listed, before favorites are arranged.
    catalog: Vec<Row>,
    menu_index: usize,
    menu_dismissed: bool,
    skills: Option<Vec<(String, String)>>,
    notice: Option<(String, bool)>,
    frame: usize,
    turn_started: Option<Instant>,
    quit_armed: Option<Instant>,
    focused: bool,
    release: Option<String>,
    /// Images pasted so far, which name the next.
    pasted: usize,
    /// Why the runtime ended on its own, for the message after the terminal is restored.
    pub exited: Option<String>,
    pub done: bool,
}

impl App {
    pub fn new(runtime: Runtime, terminal: Terminal, size: (u16, u16)) -> Self {
        let mut app = Self {
            runtime,
            state: State::default(),
            terminal,
            theme: Theme::new("default", terminal),
            painted: String::new(),
            screen: Screen::new(),
            size,
            composer: Composer::default(),
            attachments: Vec::new(),
            pending: HashMap::new(),
            scroll: Vec::new(),
            home: true,
            counted_from: None,
            printed: HashSet::new(),
            resets: 0,
            session: None,
            overlay: None,
            catalog: Vec::new(),
            menu_index: 0,
            menu_dismissed: false,
            skills: None,
            notice: None,
            frame: 0,
            turn_started: None,
            quit_armed: None,
            focused: true,
            release: None,
            pasted: 0,
            exited: None,
            done: false,
        };
        app.call("getSnapshot", vec![], Reply::Snapshot);
        app.call("latestRelease", vec![], Reply::Release);
        app
    }

    pub fn shutdown(self) {
        self.runtime.shutdown();
    }

    /// Whether something on screen moves, so the loop ticks rather than waits.
    pub fn animating(&self) -> bool {
        let status = &self.state.status;
        let counting = self.home
            && self.counted_from.is_some_and(|at| home::counting(at.elapsed().as_millis() as f64));
        !self.state.loaded
            || status.busy
            || status.model_state == "starting"
            || status.model_load.is_some()
            || counting
    }

    pub fn tick(&mut self) {
        self.frame = self.frame.wrapping_add(1);
        if self.quit_armed.is_some_and(|at| at.elapsed() > QUIT_WINDOW) {
            self.quit_armed = None;
        }
    }

    fn call(&mut self, method: &str, args: Vec<Value>, reply: Reply) {
        let id = self.runtime.call(method, args);
        self.pending.insert(id, reply);
    }

    fn op(&mut self, method: &str, args: Vec<Value>) {
        self.call(method, args, Reply::Op);
    }

    fn tell(&mut self, text: impl Into<String>, error: bool) {
        self.notice = Some((text.into(), error));
    }

    fn picker(&mut self, kind: PickerKind, title: &'static str, rows: Vec<Row>) {
        self.overlay = Some(Overlay::Picker(Picker::new(kind, title, rows)));
    }

    /// The open picker of a kind, if that is what holds the keyboard.
    fn open_picker(&mut self, kind: PickerKind) -> Option<&mut Picker> {
        match &mut self.overlay {
            Some(Overlay::Picker(picker)) if picker.kind == kind => Some(picker),
            _ => None,
        }
    }

    fn look(&self) -> Look<'_> {
        Look {
            theme: &self.theme,
            width: self.size.0 as usize,
            thinking_visible: self.state.status.thinking_visible,
            frame: self.frame,
        }
    }

    pub fn incoming(&mut self, incoming: Incoming) {
        match incoming {
            Incoming::Reply { id, result } => {
                let Some(reply) = self.pending.remove(&id) else { return };
                // Offline, the release check fails quietly; without a snapshot there is no UI.
                match (result, reply) {
                    (Ok(value), reply) => self.reply(reply, value),
                    (Err(_), Reply::Release) => {}
                    (Err(reason), Reply::Snapshot) => {
                        self.exited = Some(format!("Otis could not start: {reason}"));
                        self.done = true;
                    }
                    (Err(reason), Reply::Models) => {
                        self.overlay = None;
                        self.tell(reason, true);
                    }
                    (Err(reason), _) => self.tell(reason, true),
                }
            }
            Incoming::Event(event) => {
                let was_busy = self.state.status.busy;
                let asked = self.state.status.permission.as_ref().map(|p| p.id);
                self.state.apply(event);
                self.after_change(was_busy, asked);
            }
            Incoming::Notify => self.bell(),
            Incoming::Exited(stderr) if !self.done => {
                let detail = if stderr.is_empty() { String::new() } else { format!(":\n{stderr}") };
                self.exited = Some(format!("The Otis runtime stopped{detail}"));
                self.done = true;
            }
            Incoming::Exited(_) => {}
        }
    }

    fn reply(&mut self, reply: Reply, value: Value) {
        let theme = self.theme;
        let width = self.size.0 as usize;
        let accepted = value.get("accepted").or(value.get("ok")).and_then(Value::as_bool);
        let reason = value.get("reason").and_then(Value::as_str).unwrap_or_default().to_string();
        match reply {
            Reply::Snapshot => {
                self.state.load(value);
                self.after_change(false, None);
            }
            Reply::Op | Reply::Select | Reply::Connected | Reply::Deleted
                if accepted == Some(false) =>
            {
                if !QUIET_REASONS.contains(&reason.as_str()) {
                    self.tell(reason, true);
                }
            }
            Reply::Op => {}
            // The model picker closes once the chosen model is the one in use.
            Reply::Select => {
                if self.open_picker(PickerKind::Model).is_some() {
                    self.overlay = None;
                }
            }
            Reply::Connected => {
                self.notice = None;
                self.open_models();
            }
            Reply::Deleted => {
                if let Some(picker) = self.open_picker(PickerKind::Model) {
                    picker.loading = true;
                    self.call("listModels", vec![], Reply::Models);
                }
            }
            Reply::Models => {
                #[derive(Deserialize, Default)]
                #[serde(rename_all = "camelCase", default)]
                struct Item {
                    kind: String,
                    id: String,
                    provider: String,
                    display_name: String,
                    selection_key: Option<String>,
                    available: bool,
                    availability_label: Option<String>,
                    context_length: Option<u64>,
                    supports_image_input: bool,
                    has_downloaded_packing: bool,
                    active: bool,
                }
                let items: Vec<Item> = serde_json::from_value(value).unwrap_or_default();
                self.catalog = items
                    .into_iter()
                    .map(|item| {
                        if item.kind == "header" {
                            return Row::header(&item.id, &item.display_name);
                        }
                        let mut detail = match item.availability_label {
                            Some(label) if !label.is_empty() => vec![label],
                            _ => item.context_length.map(context_window).into_iter().collect(),
                        };
                        detail
                            .push(if item.supports_image_input { "Vision" } else { "Text" }.into());
                        let local = item.provider == "local" && item.has_downloaded_packing;
                        Row {
                            key: item
                                .selection_key
                                .unwrap_or_else(|| format!("{}:{}", item.provider, item.id)),
                            label: item.display_name,
                            detail: detail.join(" · "),
                            active: item.active,
                            disabled: !item.available,
                            deletable: local.then_some(item.id),
                            ..Row::default()
                        }
                    })
                    .collect();
                if let Some(Overlay::Picker(picker)) = &mut self.overlay
                    && picker.kind == PickerKind::Model
                {
                    picker.rows = model_rows(&self.catalog, &self.state.status.favorite_models);
                    picker.loading = false;
                    if picker.selected.is_none() {
                        picker.selected =
                            picker.rows.iter().find(|row| row.active).map(|row| row.key.clone());
                    }
                }
            }
            Reply::Skills { print } => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Skill {
                    name: String,
                    description: String,
                    hidden: bool,
                    user_invocable: bool,
                }
                #[derive(Deserialize)]
                struct Source {
                    id: String,
                    url: String,
                }
                let field = |name: &str| value.get(name).cloned().unwrap_or_default();
                let skills: Vec<Skill> =
                    serde_json::from_value(field("skills")).unwrap_or_default();
                let sources: Vec<Source> =
                    serde_json::from_value(field("sources")).unwrap_or_default();
                if print {
                    let mut lines = vec![heading("Skills", &theme)];
                    if skills.is_empty() {
                        lines.push(dim_line("No skills yet. /skills install <git url>", &theme));
                    }
                    for skill in &skills {
                        let mut spans = vec![Span::styled(
                            format!("/{}", skill.name),
                            Style::new().fg(theme.accent_ink),
                        )];
                        if skill.hidden {
                            spans.push(Span::styled(" (hidden)", Style::new().fg(theme.faint)));
                        }
                        let about = format!("  {}", first_sentence(&skill.description));
                        spans.push(Span::styled(about, Style::new().fg(theme.dim)));
                        lines.extend(indented(&spans, width, "  "));
                    }
                    if !sources.is_empty() {
                        lines.push(Line::default());
                        lines.push(heading("Collections", &theme));
                        for source in &sources {
                            lines.push(Line::from(vec![
                                margin(),
                                Span::styled(source.id.clone(), Style::new().fg(theme.text)),
                                Span::styled(
                                    format!("  {}", source.url),
                                    Style::new().fg(theme.dim),
                                ),
                            ]));
                        }
                        let hint = "/skills update <id> or /skills remove <id>";
                        lines.push(dim_line(hint, &theme));
                    }
                    self.print(lines);
                }
                let invocable = skills.into_iter().filter(|s| s.user_invocable && !s.hidden);
                let menu =
                    invocable.map(|s| (format!("/{}", s.name), first_sentence(&s.description)));
                self.skills = Some(menu.collect());
            }
            Reply::Memory => {
                #[derive(Deserialize)]
                struct Fact {
                    scope: String,
                    text: String,
                }
                let facts: Vec<Fact> = serde_json::from_value(value).unwrap_or_default();
                let mut lines = vec![heading("Memory", &theme)];
                if facts.is_empty() {
                    lines.push(dim_line("Nothing yet. /memory remember <fact>", &theme));
                }
                for fact in facts {
                    let spans = [
                        Span::styled(format!("{} ", fact.scope), Style::new().fg(theme.faint)),
                        Span::styled(fact.text, Style::new().fg(theme.text)),
                    ];
                    lines.extend(indented(&spans, width, ""));
                }
                self.print(lines);
            }
            Reply::Release => {
                if value.get("available").and_then(Value::as_bool) == Some(true) {
                    self.release = value.get("version").and_then(Value::as_str).map(String::from);
                }
            }
            Reply::Feedback => {
                let address = value.get("address").and_then(Value::as_str).unwrap_or_default();
                match value.get("opened").and_then(Value::as_bool) {
                    Some(true) => self.tell("A feedback draft is open in your email app.", false),
                    _ => self.tell(format!("Write to {address} with your feedback."), false),
                }
            }
            Reply::Trace(title) => {
                let entries =
                    protocol::entries_from(value.get("entries").cloned().unwrap_or_default());
                let mut lines = vec![rule(&format!("Delegated · {title}"), width, &theme)];
                lines.push(Line::default());
                lines.extend(transcript::render(&entries, &self.look(), false));
                self.scroll.extend(lines);
            }
        }
    }

    /// Prints lines into the scrollback with a blank line after.
    fn print(&mut self, lines: Vec<Line<'static>>) {
        self.scroll.extend(lines);
        self.scroll.push(Line::default());
    }

    /// Follows a change in the runtime's state: the theme, history, and what deserves a bell.
    fn after_change(&mut self, was_busy: bool, asked: Option<u64>) {
        self.theme = Theme::new(&self.state.status.theme, self.terminal);
        // The next draw's flush sends it on.
        let paint = self.theme.paint();
        if paint != self.painted {
            print!("{paint}");
            self.painted = paint;
        }
        let status = &self.state.status;
        if self.counted_from.is_none() && status.stats.is_some() {
            self.counted_from = Some(Instant::now());
        }
        if status.busy && !was_busy {
            self.turn_started = Some(Instant::now());
        }
        // A finished turn rings through the runtime's notice; a question rings here.
        if status.permission.as_ref().is_some_and(|p| Some(p.id) != asked) {
            self.bell();
        }
        match &mut self.overlay {
            Some(Overlay::Picker(p)) if p.kind == PickerKind::Settings => {
                p.rows = settings_rows(status)
            }
            Some(Overlay::Picker(p)) if p.kind == PickerKind::Model && !p.loading => {
                p.rows = model_rows(&self.catalog, &status.favorite_models)
            }
            _ => {}
        }
        if self.state.resets != self.resets {
            let prompts =
                self.state.entries.iter().filter(|e| e.by_user() && e.kind == Kind::Message);
            let texts = prompts.map(|e| e.message_text.clone().unwrap_or_else(|| e.text.clone()));
            self.composer.remember(texts);
        }
    }

    /// Rings the terminal's bell while it is not in front, the way the desktop sounds a cue.
    fn bell(&self) {
        if !self.focused {
            print!("\x07");
        }
    }

    pub fn event(&mut self, event: Event) {
        match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => self.key(key),
            Event::Paste(text) => match self.overlay.as_mut() {
                Some(Overlay::Field(Field::Key(_, input) | Field::Server(_, input))) => {
                    input.push_str(text.trim())
                }
                Some(Overlay::Picker(picker)) => {
                    picker.query.push_str(text.lines().next().unwrap_or(""))
                }
                // A terminal pastes nothing for a clipboard that holds only an image.
                None if text.trim().is_empty() => self.paste_clipboard(),
                None => match pasted_paths(&text) {
                    Some(paths) => {
                        for path in paths {
                            match attachment(&path) {
                                Ok(attachment) => self.attachments.push(attachment),
                                Err(reason) => self.tell(reason, true),
                            }
                        }
                    }
                    None => self.composer.insert(&text),
                },
            },
            Event::Resize(width, height) => {
                let _ = self.screen.resized(width);
                self.size = (width, height);
            }
            Event::FocusGained => self.focused = true,
            Event::FocusLost => self.focused = false,
            _ => {}
        }
    }

    fn key(&mut self, key: KeyEvent) {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        // Ctrl+C closes what is open, else clears the draft, else stops the turn, and quits on a
        // second press.
        if ctrl && key.code == KeyCode::Char('c') {
            if self.open_picker(PickerKind::Model).is_some() {
                self.op("cancelModelSelection", vec![]);
            }
            if self.overlay.take().is_some() {
                return;
            }
            if !self.composer.is_empty() || !self.attachments.is_empty() {
                self.composer.set("");
                self.attachments.clear();
                return;
            }
            if self.state.status.busy {
                self.op("stop", vec![]);
            }
            match self.quit_armed {
                Some(_) => self.done = true,
                None => self.quit_armed = Some(Instant::now()),
            }
            return;
        }
        self.quit_armed = None;
        if self.overlay.is_some() {
            return self.overlay_key(key);
        }
        if let Some(permission) = &self.state.status.permission {
            let id = permission.id;
            let allow = match key.code {
                KeyCode::Char('y') | KeyCode::Enter => true,
                KeyCode::Char('n') | KeyCode::Esc => false,
                _ => return,
            };
            return self.op("respondToPermission", vec![json!(id), json!(allow)]);
        }
        self.notice = None;
        let menu = self.menu();
        self.menu_index = self.menu_index.min(menu.len().saturating_sub(1));
        let chosen = menu.get(self.menu_index).map(|(name, _)| name.clone());
        let newline = key.modifiers.intersects(KeyModifiers::SHIFT | KeyModifiers::ALT);
        match key.code {
            KeyCode::Char('d') if ctrl && self.composer.is_empty() => self.done = true,
            KeyCode::Char('v') if ctrl => self.paste_clipboard(),
            KeyCode::Char('t') if ctrl => {
                let visible = self.state.status.thinking_visible;
                self.op("setThinkingVisible", vec![json!(!visible)]);
            }
            KeyCode::BackTab => {
                let auto = self.state.status.permission_mode == "auto";
                self.op("setPermissionMode", vec![json!(if auto { "ask" } else { "auto" })]);
            }
            KeyCode::Esc if chosen.is_some() => self.menu_dismissed = true,
            KeyCode::Esc if self.state.status.busy => self.op("stop", vec![]),
            KeyCode::Up if chosen.is_some() => self.menu_index = self.menu_index.saturating_sub(1),
            KeyCode::Down if chosen.is_some() => {
                self.menu_index = (self.menu_index + 1).min(menu.len() - 1)
            }
            KeyCode::Tab if let Some(name) = &chosen => self.composer.set(&format!("{name} ")),
            KeyCode::Enter if !newline && let Some(name) = &chosen => {
                self.composer.set(name);
                self.submit();
            }
            KeyCode::Enter if newline => self.composer.insert("\n"),
            KeyCode::Char('j') if ctrl => self.composer.insert("\n"),
            // A line that ends in a backslash continues on the next.
            KeyCode::Enter if let Some(text) = self.composer.text().strip_suffix('\\') => {
                let text = format!("{text}\n");
                self.composer.set(&text);
            }
            KeyCode::Enter => self.submit(),
            KeyCode::Backspace if self.composer.is_empty() => {
                self.attachments.pop();
            }
            KeyCode::Backspace if ctrl || alt => self.composer.delete_word(),
            KeyCode::Backspace => self.composer.backspace(),
            KeyCode::Delete => self.composer.delete(),
            KeyCode::Char('w') if ctrl => self.composer.delete_word(),
            KeyCode::Char('u') if ctrl => self.composer.delete_to_start(),
            KeyCode::Char('k') if ctrl => self.composer.delete_to_end(),
            KeyCode::Char('a') if ctrl => self.composer.home(),
            KeyCode::Char('e') if ctrl => self.composer.end(),
            KeyCode::Char('b') if alt => self.composer.word_left(),
            KeyCode::Char('f') if alt => self.composer.word_right(),
            KeyCode::Left if ctrl || alt => self.composer.word_left(),
            KeyCode::Right if ctrl || alt => self.composer.word_right(),
            KeyCode::Left => self.composer.left(),
            KeyCode::Right => self.composer.right(),
            KeyCode::Home => self.composer.home(),
            KeyCode::End => self.composer.end(),
            KeyCode::Up | KeyCode::Down => {
                let down = key.code == KeyCode::Down;
                if !self.composer.vertical(down, self.composer_width()) {
                    self.composer.recall(!down);
                }
            }
            KeyCode::Char(ch) if !ctrl => self.composer.insert(ch.encode_utf8(&mut [0; 4])),
            _ => {}
        }
        if !self.composer.text().starts_with('/') {
            self.menu_index = 0;
            self.menu_dismissed = false;
        } else if self.skills.is_none() {
            self.call("listSkills", vec![], Reply::Skills { print: false });
        }
    }

    /// The clipboard's image as a PNG attachment, else its text into the draft.
    fn paste_clipboard(&mut self) {
        let Ok(mut clipboard) = arboard::Clipboard::new() else {
            return self.tell("This terminal's clipboard cannot be read.", true);
        };
        let Ok(image) = clipboard.get_image() else {
            if let Ok(text) = clipboard.get_text() {
                self.composer.insert(&text);
            }
            return;
        };
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, image.width as u32, image.height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        if let Err(error) =
            encoder.write_header().and_then(|mut png| png.write_image_data(&image.bytes))
        {
            return self.tell(format!("Could not attach the pasted image: {error}"), true);
        }
        self.pasted += 1;
        let name = format!("pasted-image-{}.png", self.pasted);
        self.attachments.push(Attachment { name, mime: "image/png", bytes });
    }

    fn overlay_key(&mut self, key: KeyEvent) {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if let Some(Overlay::Field(field)) = &mut self.overlay {
            let (Field::Key(_, input) | Field::Server(_, input)) = field;
            match key.code {
                KeyCode::Esc => self.overlay = None,
                KeyCode::Backspace => {
                    input.pop();
                }
                KeyCode::Char('o') if ctrl => {
                    if let Field::Key(provider, _) = field {
                        let provider = *provider;
                        self.op("openHostedKeyPage", vec![json!(provider)]);
                    }
                }
                KeyCode::Char(ch) if !ctrl => input.push(ch),
                KeyCode::Enter if !input.trim().is_empty() => {
                    let Some(Overlay::Field(field)) = self.overlay.take() else { unreachable!() };
                    let (method, args, doing) = match field {
                        Field::Key(provider, key) => (
                            "setHostedApiKey",
                            vec![json!(provider), json!(key.trim())],
                            format!("Checking the {} key…", provider_name(provider)),
                        ),
                        Field::Server(server, address) => (
                            "connectLocalServers",
                            vec![server_inputs(&self.state.status, server, address.trim())],
                            format!("Connecting to {}…", address.trim()),
                        ),
                    };
                    self.tell(doing, false);
                    self.call(method, args, Reply::Connected);
                }
                _ => {}
            }
            return;
        }
        let Some(Overlay::Picker(picker)) = &mut self.overlay else { return };
        match key.code {
            KeyCode::Esc => {
                if picker.kind == PickerKind::Model {
                    self.op("cancelModelSelection", vec![]);
                }
                self.overlay = None;
            }
            KeyCode::Up => picker.step(-1),
            KeyCode::Down => picker.step(1),
            KeyCode::Char('p') if ctrl => picker.step(-1),
            KeyCode::Char('n') if ctrl => picker.step(1),
            KeyCode::PageUp => picker.step(-(PICKER_ROWS as isize)),
            KeyCode::PageDown => picker.step(PICKER_ROWS as isize),
            KeyCode::Backspace => {
                picker.query.pop();
            }
            KeyCode::Char('f') if ctrl && picker.kind == PickerKind::Model => {
                let row = picker.current().filter(|row| row.key != "connect");
                if let Some((key, favorite)) = row.map(|row| (row.key.clone(), row.favorite)) {
                    self.op("setModelFavorite", vec![json!(key), json!(!favorite)]);
                }
            }
            KeyCode::Char('x') if ctrl && picker.kind == PickerKind::Model => {
                let deletable = picker.current().and_then(|row| row.deletable.clone());
                if let Some(id) = deletable {
                    self.call("deleteLocalModel", vec![json!(id)], Reply::Deleted);
                }
            }
            KeyCode::Char(ch) if !ctrl => picker.query.push(ch),
            KeyCode::Enter => {
                let kind = picker.kind;
                let Some(row) = picker.current().filter(|row| !row.disabled).cloned() else {
                    return;
                };
                match kind {
                    PickerKind::Model if row.key == "connect" => self.open_providers(),
                    // The picker stays while a download or load reports progress, and closes when
                    // the selection lands.
                    PickerKind::Model => {
                        picker.selected = Some(row.key.clone());
                        self.call("selectModel", vec![json!(row.key)], Reply::Select);
                    }
                    PickerKind::Provider => {
                        let server = SERVERS
                            .iter()
                            .find(|(id, ..)| Some(*id) == row.key.strip_prefix("server:"));
                        self.overlay = Some(Overlay::Field(match server {
                            Some((id, ..)) => Field::Server(id, row.detail.clone()),
                            None => {
                                let provider = PROVIDERS.iter().find(|(id, _)| *id == row.key);
                                Field::Key(provider.expect("a listed provider").0, String::new())
                            }
                        }));
                    }
                    PickerKind::Session => {
                        self.overlay = None;
                        let here = &self.state.status.workspace.path;
                        match row.path.filter(|path| path != here) {
                            Some(path) => self.op(
                                "openSessionAt",
                                vec![json!(path), json!(row.key), json!(row.dir)],
                            ),
                            None => self.op("selectSession", vec![json!(row.key), json!(row.dir)]),
                        }
                    }
                    PickerKind::Theme => {
                        self.overlay = None;
                        self.op("setTheme", vec![json!(row.key)]);
                    }
                    PickerKind::Effort => {
                        self.overlay = None;
                        let model =
                            self.state.status.local_thinking.as_ref().map(|t| t.model_id.clone());
                        self.op("setLocalThinking", vec![json!(model), json!(row.key)]);
                    }
                    PickerKind::Agents => {
                        self.overlay = None;
                        self.call(
                            "getSubagentTrace",
                            vec![json!(row.key)],
                            Reply::Trace(row.label),
                        );
                    }
                    PickerKind::Settings => {
                        let status = &self.state.status;
                        let auto = status.permission_mode == "auto";
                        let (method, value) = match row.key.as_str() {
                            "theme" => {
                                let rows = THEMES.iter().map(|name| Row {
                                    key: name.to_string(),
                                    label: capitalized(name),
                                    active: *name == status.theme,
                                    ..Row::default()
                                });
                                return self.picker(PickerKind::Theme, "Theme", rows.collect());
                            }
                            "thinking" => ("setThinkingVisible", json!(!status.thinking_visible)),
                            "permissions" => {
                                ("setPermissionMode", json!(if auto { "ask" } else { "auto" }))
                            }
                            "notify" => {
                                ("setNotifyOnCompletion", json!(!status.notify_on_completion))
                            }
                            "awake" => ("setKeepAwake", json!(!status.keep_awake)),
                            "offline" => ("setOfflineFallback", json!(!status.offline_fallback)),
                            _ => ("setDebugMode", json!(!status.debug)),
                        };
                        self.op(method, vec![value]);
                    }
                }
            }
            _ => {}
        }
    }

    /// The commands and skills the draft's `/word` matches.
    fn menu(&self) -> Vec<(String, String)> {
        let text = self.composer.text();
        if self.menu_dismissed || !text.starts_with('/') || text.contains(char::is_whitespace) {
            return Vec::new();
        }
        let status = &self.state.status;
        let applies = |name: &str| match name {
            "/queue" => status.busy,
            "/effort" => status.local_thinking.is_some(),
            "/agents" => !status.subagents.is_empty(),
            "/locate" => status.needs_workspace,
            _ => true,
        };
        let builtin = COMMANDS.iter().filter(|(name, _)| applies(name));
        let builtin = builtin.map(|(name, about)| (name.to_string(), about.to_string()));
        let skills = self.skills.iter().flatten().cloned();
        let skills = skills.filter(|(name, _)| !COMMANDS.iter().any(|(taken, _)| taken == name));
        builtin.chain(skills).filter(|(name, _)| name.starts_with(text)).collect()
    }

    fn submit(&mut self) {
        let text = self.composer.text().trim().to_string();
        if text.is_empty() && self.attachments.is_empty() {
            return;
        }
        let (command, argument) =
            text.split_once(' ').map_or((text.as_str(), ""), |(c, a)| (c, a.trim()));
        let action = argument.split_once(' ').map(|(action, rest)| (action, rest.trim()));
        // A prompt, or with /queue one that waits for the running turn rather than steering it.
        let queue = command == "/queue";
        if queue && argument.is_empty() {
            return self.tell("Write the follow-up after it: /queue <prompt>", true);
        }
        if queue || !COMMANDS.iter().any(|(name, _)| *name == command) {
            if self.state.status.model_state == "unconfigured" {
                self.tell("Choose a model first.", true);
                return self.open_models();
            }
            let attachments: Vec<Value> = self
                .attachments
                .drain(..)
                .map(|a| {
                    let bytes = protocol::bytes(&a.bytes);
                    json!({ "name": a.name, "mimeType": a.mime, "bytes": bytes })
                })
                .collect();
            let prompt = if queue { argument } else { text.as_str() };
            let args = vec![json!(prompt), json!(attachments), json!(queue)];
            self.composer.take();
            return self.op("sendPrompt", args);
        }
        self.composer.take();
        let status = &self.state.status;
        match command {
            "/new" => self.op("startNewSession", vec![]),
            "/history" => {
                let rows = status
                    .sessions
                    .iter()
                    .map(|item| Row {
                        key: item.id.clone(),
                        label: if item.title.is_empty() {
                            "Untitled".into()
                        } else {
                            item.title.clone()
                        },
                        detail: [item.workspace_label.as_str(), item.detail.as_str()]
                            .into_iter()
                            .filter(|part| !part.is_empty())
                            .collect::<Vec<_>>()
                            .join(" · "),
                        active: status.session.as_ref().is_some_and(|s| s.id == item.id),
                        path: item.workspace_path.clone(),
                        dir: item.dir_name.clone(),
                        ..Row::default()
                    })
                    .collect();
                self.picker(PickerKind::Session, "Sessions", rows);
            }
            "/fork" => match status.session.as_ref().map(|s| s.id.clone()) {
                Some(id) => self.op("forkSession", vec![json!(id)]),
                None => self.tell("There is no session to branch yet.", true),
            },
            "/model" => self.open_models(),
            "/connect" => self.open_providers(),
            // Through the terminal's clipboard escape, so it reaches the clipboard of the computer
            // the terminal runs on, over SSH too.
            "/copy" => {
                let answers = self.state.entries.iter().rev().filter(|e| e.kind == Kind::Message);
                let answer = answers.filter(|e| !e.by_user()).find(|e| !e.text.trim().is_empty());
                match answer.map(|answer| answer.text.trim()) {
                    Some(text) => {
                        use base64::Engine;
                        let encoded = base64::engine::general_purpose::STANDARD.encode(text);
                        print!("\x1b]52;c;{encoded}\x07");
                        self.tell("Copied the last answer.", false);
                    }
                    None => self.tell("There is no answer to copy yet.", true),
                }
            }
            "/effort" => match &status.local_thinking {
                Some(thinking) => {
                    let level = |key: &str, label: String, detail: &str| Row {
                        key: key.into(),
                        label,
                        detail: detail.into(),
                        active: thinking.selected == key,
                        ..Row::default()
                    };
                    let mut rows =
                        vec![level("default", "Model default".into(), &thinking.default_level)];
                    rows.extend(thinking.levels.iter().map(|l| level(l, capitalized(l), "")));
                    self.picker(PickerKind::Effort, "Thinking effort", rows);
                }
                None => self.tell("This model has no thinking effort to set.", true),
            },
            "/agents" => {
                let rows = status
                    .subagents
                    .iter()
                    .map(|run| {
                        let progress = match run.duration_ms {
                            Some(ms) if run.status != "running" => transcript::elapsed(ms),
                            _ => run.status.clone(),
                        };
                        Row {
                            key: run.tool_call_id.clone(),
                            label: run.title.clone(),
                            detail: format!("{} tools · {progress}", run.tools),
                            ..Row::default()
                        }
                    })
                    .collect();
                self.picker(PickerKind::Agents, "Delegated runs", rows);
            }
            "/locate" if argument.is_empty() => self.tell("Name the folder: /locate <path>", true),
            "/locate" => {
                let home = std::env::home_dir().unwrap_or_default();
                let path = match argument.strip_prefix("~/") {
                    Some(rest) => home.join(rest),
                    None => PathBuf::from(argument),
                };
                self.op("locateWorkspace", vec![json!(path)]);
            }
            "/compact" => {
                let instructions = (!argument.is_empty()).then(|| argument.to_string());
                self.op("compact", vec![json!(instructions)]);
            }
            "/thinking" => {
                let visible = status.thinking_visible;
                self.op("setThinkingVisible", vec![json!(!visible)]);
            }
            "/settings" => {
                let rows = settings_rows(status);
                self.picker(PickerKind::Settings, "Settings", rows);
            }
            "/skills" => match action {
                Some(("install", url)) => self.op("installSkills", vec![json!(url)]),
                Some(("update", id)) => self.op("updateSkills", vec![json!(id)]),
                Some(("remove", id)) => self.op("removeSkills", vec![json!(id)]),
                _ => self.call("listSkills", vec![], Reply::Skills { print: true }),
            },
            "/memory" => match action {
                Some(("remember", fact)) => {
                    self.op("rememberFact", vec![json!("workspace"), json!(fact)])
                }
                Some(("forget", fact)) => {
                    self.op("forgetFact", vec![json!("workspace"), json!(fact)])
                }
                _ => self.call("listMemory", vec![], Reply::Memory),
            },
            "/feedback" => self.call("sendFeedback", vec![], Reply::Feedback),
            _ => self.done = true,
        }
    }

    fn open_models(&mut self) {
        let mut picker = Picker::new(PickerKind::Model, "Choose a model", Vec::new());
        picker.loading = true;
        self.overlay = Some(Overlay::Picker(picker));
        self.call("listModels", vec![], Reply::Models);
    }

    /// The hosted providers by key, then the servers on this computer by address.
    fn open_providers(&mut self) {
        let status = &self.state.status;
        let mut rows: Vec<Row> = PROVIDERS
            .iter()
            .map(|(id, name)| {
                let saved = status.hosted_configured.get(*id) == Some(&true);
                Row {
                    key: id.to_string(),
                    label: name.to_string(),
                    detail: if saved { "Key saved · replace it" } else { "Add an API key" }.into(),
                    active: saved,
                    ..Row::default()
                }
            })
            .collect();
        rows.insert(0, Row::header("hosted", "Hosted"));
        rows.push(Row::header("local", "On this computer"));
        for (id, name, default) in SERVERS {
            let saved = match id {
                "ollama" => status.pair_endpoints.ollama.clone(),
                "lmStudio" => status.pair_endpoints.lm_studio.clone(),
                _ => status.servers.get(id).map(|server| server.base_url.clone()),
            };
            rows.push(Row {
                key: format!("server:{id}"),
                label: name.into(),
                active: saved.is_some(),
                detail: saved.unwrap_or_else(|| default.into()),
                ..Row::default()
            });
        }
        self.picker(PickerKind::Provider, "Connect a provider or server", rows);
    }

    /// The home screen within `rows`, its figures counted up to `elapsed` after they arrived, or at
    /// rest.
    fn home_lines(&self, elapsed: Option<f64>, rows: usize) -> Vec<Line<'static>> {
        let status = &self.state.status;
        let workspace = &status.workspace.path;
        let home_dir =
            std::env::home_dir().map(|dir| dir.display().to_string()).unwrap_or_default();
        let folder = match workspace.strip_prefix(&home_dir) {
            Some(rest) if !home_dir.is_empty() => format!("~{rest}"),
            _ => workspace.clone(),
        };
        let model = status
            .model
            .as_ref()
            .filter(|_| status.model_state != "unconfigured")
            .map(|model| (model.name().to_string(), provider_name(&model.provider)));
        home::render(&Home {
            theme: &self.theme,
            width: self.size.0 as usize,
            rows,
            version: &self.state.version,
            folder,
            model,
            stats: status.stats.as_ref(),
            elapsed,
        })
    }

    fn composer_width(&self) -> usize {
        (self.size.0 as usize).saturating_sub(2 * MARGIN + 6).max(4)
    }

    /// Sends finished output to the scrollback: the home screen once something follows it, a rule
    /// when another session's transcript takes the screen, and every entry the runtime will no
    /// longer change.
    /// With `closing`, everything still on screen goes too, so a quit mid-turn keeps what the turn
    /// showed. Returns where the entries not yet printed start.
    fn commit(&mut self, closing: bool) -> usize {
        if !self.state.loaded {
            return 0;
        }
        // The session is followed through every change, since the runtime starts one lazily,
        // without a reset. A reset within the same session resends what is already printed; an
        // empty session brings the home screen back, and another's transcript prints whole, under
        // a rule naming it.
        let session = self.state.status.session.as_ref().map(|s| s.id.clone());
        if self.state.resets != self.resets && session != self.session {
            if self.state.entries.is_empty() {
                self.home = true;
                self.counted_from = self.state.status.stats.is_some().then(Instant::now);
            } else if !self.printed.is_empty() {
                let title =
                    self.state.status.session.as_ref().map_or("Session", |s| s.title.as_str());
                self.print(vec![rule(title, self.size.0 as usize, &self.theme)]);
            }
            self.printed.clear();
        }
        self.resets = self.state.resets;
        self.session = session;
        if self.home && (closing || !self.state.entries.is_empty() || !self.scroll.is_empty()) {
            self.home = false;
            // The scrollback has room for all of it.
            let mut lines = self.home_lines(None, usize::MAX);
            lines.push(Line::default());
            self.scroll.splice(0..0, lines);
        }
        let entries = &self.state.entries;
        let start =
            entries.iter().position(|e| !self.printed.contains(&e.id)).unwrap_or(entries.len());
        let settled = match closing {
            true => entries.len(),
            false => transcript::settled(entries, self.state.status.busy).max(start),
        };
        let lines = transcript::render(&entries[start..settled], &self.look(), false);
        self.printed.extend(entries[start..settled].iter().map(|e| e.id));
        self.scroll.extend(lines);
        settled
    }

    /// Prints what finished and redraws the live region; `closing` prints the rest and clears it.
    pub fn draw(&mut self, closing: bool) -> io::Result<()> {
        let start = self.commit(closing);
        let (width, height) = self.size;
        let (live, cursor) = if closing { (Vec::new(), None) } else { self.live(start) };
        let cursor = cursor.map(|(x, y)| (x as u16, y as u16));
        self.screen.draw(&self.scroll, &live, cursor, width, height)?;
        self.scroll.clear();
        Ok(())
    }

    /// The live region from the entry at `start`: the turn in progress, then the composer or
    /// whatever holds the keyboard, and where the cursor goes.
    fn live(&self, start: usize) -> (Vec<Line<'static>>, Option<(usize, usize)>) {
        let look = self.look();
        let theme = &self.theme;
        let width = self.size.0 as usize;
        let spinner = look.spinner();
        if !self.state.loaded {
            let mut spans = vec![margin(), spinner, Span::raw(" ")];
            spans.extend(transcript::shimmer("Starting Otis…", &look));
            return (vec![Line::from(spans)], None);
        }
        let status = &self.state.status;
        let mut bottom = Vec::new();
        if let Some((text, error)) = &self.notice {
            let color = if *error { theme.pink } else { theme.dim };
            bottom.extend(indented(
                &[Span::styled(text.clone(), Style::new().fg(color))],
                width,
                "",
            ));
        }
        let (lines, cursor) = match &self.overlay {
            Some(Overlay::Picker(picker)) => self.picker_lines(picker, &spinner),
            Some(Overlay::Field(field)) => self.field_lines(field),
            None if status.permission.is_some() => (self.permission_lines(), None),
            None => {
                let (mut lines, cursor) = self.composer_lines();
                let menu = self.menu();
                if menu.is_empty() {
                    lines.push(self.footer(&spinner));
                } else {
                    lines.extend(self.menu_lines(&menu));
                }
                (lines, cursor)
            }
        };
        let cursor = cursor.map(|(x, y)| (x, bottom.len() + y));
        bottom.extend(lines);
        // What holds the keyboard keeps its rows; the transcript's live tail shows as much of its
        // end as fits above, and the home screen leaves parts out rather than lose its top.
        let room = (self.size.1 as usize).saturating_sub(bottom.len() + 1);
        let entries = &self.state.entries;
        let mut body = if self.home {
            let elapsed = self.counted_from.map(|at| at.elapsed().as_millis() as f64);
            let elapsed = elapsed.filter(|elapsed| home::counting(*elapsed));
            let mut lines = self.home_lines(elapsed, room.saturating_sub(1));
            lines.push(Line::default());
            lines
        } else {
            transcript::render(&entries[start..], &look, status.busy)
        };
        if status.busy {
            // A thinking or tool line already spins; otherwise the status line leads with a
            // spinner of its own.
            let last = entries[start..]
                .iter()
                .rev()
                .find(|e| e.kind != Kind::Message || !e.text.trim().is_empty());
            let spinning = last.is_some_and(|e| {
                (e.kind == Kind::Reasoning && e.streaming) || e.kind == Kind::Tool
            });
            let mut spans = vec![margin()];
            if !spinning {
                let label = match status.phase.as_str() {
                    "thinking" => "Thinking…",
                    "queued" => "Waiting for another session…",
                    _ => "Working…",
                };
                spans.extend([spinner.clone(), Span::raw(" ")]);
                spans.extend(transcript::shimmer(label, &look));
            }
            spans.push(Span::raw("  "));
            let mut facts = Vec::new();
            facts.extend(
                self.turn_started.map(|at| transcript::elapsed(at.elapsed().as_millis() as f64)),
            );
            let speed = status.speed.as_ref().filter(|s| s.tokens_per_second > 0.0);
            facts.extend(speed.map(|s| format!("{:.0} tok/s", s.tokens_per_second)));
            facts.push("esc to stop".into());
            spans.push(Span::styled(facts.join(" · "), Style::new().fg(theme.faint)));
            body.push(Line::from(spans));
            // The delegated runs at work, each by its brief; /agents opens one's whole trace.
            for run in status.subagents.iter().filter(|run| run.status == "running") {
                let spans = [
                    spinner.clone(),
                    Span::styled(format!(" {}", run.title), Style::new().fg(theme.dim)),
                    Span::styled(format!(" · {} tools", run.tools), Style::new().fg(theme.faint)),
                ];
                body.extend(
                    indented(&spans, width, "  ").into_iter().map(|l| lead(&[Span::raw("  ")], l)),
                );
            }
            body.push(Line::default());
        }
        let skip = body.len().saturating_sub(room);
        let offset = body.len() - skip;
        let mut lines: Vec<Line<'static>> = body.into_iter().skip(skip).collect();
        lines.extend(bottom);
        (lines, cursor.map(|(x, y)| (x, y + offset)))
    }

    fn composer_lines(&self) -> (Vec<Line<'static>>, Option<(usize, usize)>) {
        let theme = &self.theme;
        let status = &self.state.status;
        let outer = (self.size.0 as usize).saturating_sub(2 * MARGIN).max(12);
        let inner = outer - 4;
        let edge = Style::new().fg(theme.border);
        let top =
            Line::from(vec![margin(), Span::styled(format!("╭{}╮", "─".repeat(outer - 2)), edge)]);
        let mut lines = vec![top];
        let row = |spans: Vec<Span<'static>>| boxed(spans, inner, edge);
        if !self.attachments.is_empty() {
            let names: Vec<String> =
                self.attachments.iter().map(|a| format!("◫ {}", a.name)).collect();
            let chips = [Span::styled(names.join("   "), Style::new().fg(theme.dim))];
            lines.extend(wrap(&chips, inner, &[], &[]).into_iter().map(|line| row(line.spans)));
        }
        let layout = self.composer.layout(self.composer_width());
        let first = layout
            .cursor
            .0
            .saturating_sub(COMPOSER_ROWS - 1)
            .min(layout.rows.len().saturating_sub(COMPOSER_ROWS));
        let above = lines.len();
        let prompt = Span::styled("› ", Style::new().fg(theme.accent));
        if self.composer.is_empty() {
            let placeholder = match status.model_state.as_str() {
                "unconfigured" => "Choose a model with /model to begin",
                _ if status.busy => "Steer this turn, or queue what comes next",
                _ => "Ask Otis anything",
            };
            lines.push(row(vec![prompt, Span::styled(placeholder, Style::new().fg(theme.faint))]));
        } else {
            for (index, &(start, end)) in
                layout.rows.iter().enumerate().skip(first).take(COMPOSER_ROWS)
            {
                let lead = if index == 0 { prompt.clone() } else { Span::raw("  ") };
                let text = self.composer.text()[start..end].replace('\t', "    ");
                lines.push(row(vec![lead, Span::styled(text, Style::new().fg(theme.text))]));
            }
        }
        lines.push(Line::from(vec![
            margin(),
            Span::styled(format!("╰{}╯", "─".repeat(outer - 2)), edge),
        ]));
        let (row_index, column) = layout.cursor;
        (lines, Some((MARGIN + 4 + column, above + row_index - first)))
    }

    fn footer(&self, spinner: &Span<'static>) -> Line<'static> {
        let theme = &self.theme;
        let status = &self.state.status;
        let faint = Style::new().fg(theme.faint);
        let mut left = vec![Span::raw(" ".repeat(MARGIN + 2))];
        match (&status.model, status.model_state.as_str()) {
            (_, "unconfigured") => {
                left.push(Span::styled("No model yet · /model", Style::new().fg(theme.orange)))
            }
            (Some(model), "starting") => {
                left.push(spinner.clone());
                left.push(Span::styled(
                    format!(" Starting {}", model.name()),
                    Style::new().fg(theme.dim),
                ));
            }
            (Some(model), _) => {
                left.push(Span::styled(model.name().to_string(), Style::new().fg(theme.dim)))
            }
            (None, _) => {}
        }
        if let Some(load) = &status.model_load {
            let percent = load.status.percent.map(|p| format!(" {p:.0}%")).unwrap_or_default();
            let color = if load.status.kind == "error" { theme.pink } else { theme.accent_ink };
            left.push(Span::styled(
                format!(" · {}{percent}", load.status.label),
                Style::new().fg(color),
            ));
        } else if let Some(error) = &status.model_error {
            left.push(Span::styled(format!(" · {error}"), Style::new().fg(theme.pink)));
        }
        if status.needs_workspace {
            left.push(Span::styled(
                " · folder missing: /locate <path>",
                Style::new().fg(theme.orange),
            ));
        }
        if status.offline.is_some() {
            left.push(Span::styled(" · offline", Style::new().fg(theme.orange)));
        }
        if let Some(tokens) = status.context_tokens.filter(|_| status.context_limit > 0.0) {
            let used = tokens / status.context_limit;
            let ring = ["○", "◔", "◑", "◕", "●"][((used * 4.0).round() as usize).min(4)];
            let color = if used >= 0.8 { theme.orange } else { theme.faint };
            left.push(Span::styled(
                format!(" · {ring} {:.0}%", used * 100.0),
                Style::new().fg(color),
            ));
        }
        if status.permission_mode == "auto" {
            left.push(Span::styled(" · auto-approve", Style::new().fg(theme.orange)));
        }
        if status.debug {
            left.push(Span::styled(" · debug", faint));
        }
        let right = match (&self.release, self.quit_armed) {
            (_, Some(_)) => "ctrl+c again to quit".to_string(),
            (Some(version), _) => format!("Otis {version} is out · otis update"),
            _ => "/ commands · ⇧⏎ newline".to_string(),
        };
        // The hint on the right goes first when the row runs short, then the row's end.
        let width = (self.size.0 as usize).saturating_sub(MARGIN);
        let used: usize = left.iter().map(|s| text::width(&s.content)).sum();
        let room = width.saturating_sub(used);
        if text::width(&right) + 2 <= room {
            left.push(Span::raw(" ".repeat(room - text::width(&right))));
            left.push(Span::styled(right, faint));
        }
        truncate(Line::from(left), width)
    }

    fn menu_lines(&self, menu: &[(String, String)]) -> Vec<Line<'static>> {
        let theme = &self.theme;
        let selected = self.menu_index.min(menu.len() - 1);
        // A long skill name truncates rather than pushing every description off the row.
        let names = menu.iter().map(|(name, _)| text::width(name)).max().unwrap_or(0).min(20);
        let width = (self.size.0 as usize).saturating_sub(2 * MARGIN);
        let rows = menu.iter().enumerate().skip(selected.saturating_sub(7)).take(8);
        rows.map(|(index, (name, about))| {
            let chosen = index == selected;
            let surface = if chosen { Style::new().bg(theme.selected) } else { Style::new() };
            let ink = if chosen { theme.accent_ink } else { theme.text };
            let name = truncate(Line::from(name.clone()), names);
            let pad = " ".repeat(names + 3 - name.width());
            let mut spans = vec![Span::styled("  ", surface)];
            spans.extend(name.spans.into_iter().map(|span| span.style(surface.fg(ink))));
            spans.push(Span::styled(pad, surface));
            spans.push(Span::styled(about.clone(), surface.fg(theme.dim)));
            let line = truncate(Line::from(spans), width);
            let line = if chosen { fill(line, width, surface) } else { line };
            lead(&[margin()], line)
        })
        .collect()
    }

    fn picker_lines(
        &self,
        picker: &Picker,
        spinner: &Span<'static>,
    ) -> (Vec<Line<'static>>, Option<(usize, usize)>) {
        let theme = &self.theme;
        let width = (self.size.0 as usize).saturating_sub(2 * MARGIN);
        let title =
            Span::styled(picker.title, Style::new().fg(theme.text).add_modifier(Modifier::BOLD));
        let hint = match picker.kind {
            PickerKind::Model => "enter select · ⌃F favorite · ⌃X delete download · esc close",
            _ => "↑↓ choose · enter select · esc close",
        };
        let gap = width.saturating_sub(text::width(picker.title) + text::width(hint));
        let mut lines = vec![
            Line::from(vec![
                margin(),
                title,
                Span::raw(" ".repeat(gap)),
                Span::styled(hint, Style::new().fg(theme.faint)),
            ]),
            Line::from(vec![
                margin(),
                Span::styled("⌕ ", Style::new().fg(theme.accent)),
                Span::styled(picker.query.clone(), Style::new().fg(theme.text)),
            ]),
            Line::from(vec![
                margin(),
                Span::styled("─".repeat(width), Style::new().fg(theme.border)),
            ]),
        ];
        let cursor = Some((MARGIN + 2 + text::width(&picker.query), 1));
        if picker.loading {
            let mut spans = vec![margin(), spinner.clone(), Span::raw(" ")];
            spans.extend(transcript::shimmer("Loading…", &self.look()));
            lines.push(Line::from(spans));
            return (lines, cursor);
        }
        let rows = picker.visible();
        if rows.is_empty() {
            lines.push(dim_line("Nothing matches.", theme));
            return (lines, cursor);
        }
        let current = picker.current().map(|row| row.key.clone());
        let selected = rows
            .iter()
            .position(|row| !row.header && Some(&row.key) == current.as_ref())
            .unwrap_or(0);
        let start =
            selected.saturating_sub(PICKER_ROWS / 2).min(rows.len().saturating_sub(PICKER_ROWS));
        let load =
            self.state.status.model_load.as_ref().filter(|_| picker.kind == PickerKind::Model);
        for (index, row) in rows.iter().enumerate().skip(start).take(PICKER_ROWS) {
            if row.header {
                let style = Style::new().fg(theme.faint).add_modifier(Modifier::BOLD);
                lines.push(Line::from(vec![
                    margin(),
                    Span::styled(format!("  {}", row.label), style),
                ]));
                continue;
            }
            let chosen = index == selected;
            let surface = if chosen { Style::new().bg(theme.selected) } else { Style::new() };
            let mark = if row.active { "● " } else { "  " };
            let ink = match (row.disabled, chosen) {
                (true, _) => theme.faint,
                (false, true) => theme.accent_ink,
                (false, false) => theme.text,
            };
            let (detail, detail_ink) = match load.filter(|load| load.model_id == row.key) {
                Some(load) => {
                    let percent =
                        load.status.percent.map(|p| format!(" {p:.0}%")).unwrap_or_default();
                    let error = load.status.kind == "error";
                    (
                        format!("{}{percent}", load.status.label),
                        if error { theme.pink } else { theme.accent_ink },
                    )
                }
                None => (row.detail.clone(), theme.dim),
            };
            let line = Line::from(vec![
                Span::styled(if chosen { "› " } else { "  " }, surface.fg(theme.accent)),
                Span::styled(mark, surface.fg(theme.accent)),
                Span::styled(row.label.clone(), surface.fg(ink)),
                Span::styled(if row.favorite { " ★" } else { "" }, surface.fg(theme.accent)),
                Span::styled(format!("  {detail}"), surface.fg(detail_ink)),
            ]);
            let line = truncate(line, width);
            let line = if chosen { fill(line, width, surface) } else { line };
            lines.push(lead(&[margin()], line));
        }
        if rows.len() > PICKER_ROWS {
            let more = format!("  {} of {}", selected + 1, rows.len());
            lines
                .push(Line::from(vec![margin(), Span::styled(more, Style::new().fg(theme.faint))]));
        }
        (lines, cursor)
    }

    /// A key typed masked, or a server's address in the clear, in an accent-edged box.
    fn field_lines(&self, field: &Field) -> (Vec<Line<'static>>, Option<(usize, usize)>) {
        let theme = &self.theme;
        let width = (self.size.0 as usize).saturating_sub(2 * MARGIN).max(12);
        let edge = Style::new().fg(theme.accent);
        let (title, about, hint, shown) = match field {
            Field::Key(provider, key) => (
                format!("Connect {}", provider_name(provider)),
                "Paste an API key. It is saved on this computer and sent only to the provider.",
                "enter save · ctrl+o open the key page · esc cancel",
                "•".repeat(key.chars().count()),
            ),
            Field::Server(server, address) => (
                format!(
                    "Connect {}",
                    SERVERS.iter().find(|(id, ..)| id == server).map_or("a server", |s| s.1)
                ),
                "The address it serves on, on this computer. Otis connects only over loopback.",
                "enter connect · esc cancel",
                address.clone(),
            ),
        };
        let shown: String =
            shown.chars().rev().take(width - 6).collect::<Vec<_>>().into_iter().rev().collect();
        let lines = vec![
            Line::from(vec![
                margin(),
                Span::styled(title, Style::new().fg(theme.text).add_modifier(Modifier::BOLD)),
            ]),
            dim_line(about, theme),
            Line::from(vec![margin(), Span::styled(format!("╭{}╮", "─".repeat(width - 2)), edge)]),
            boxed(vec![Span::styled(shown.clone(), Style::new().fg(theme.text))], width - 4, edge),
            Line::from(vec![margin(), Span::styled(format!("╰{}╯", "─".repeat(width - 2)), edge)]),
            Line::from(vec![
                Span::raw(" ".repeat(MARGIN + 2)),
                Span::styled(hint, Style::new().fg(theme.faint)),
            ]),
        ];
        (lines, Some((MARGIN + 2 + text::width(&shown), 3)))
    }

    fn permission_lines(&self) -> Vec<Line<'static>> {
        let theme = &self.theme;
        let status = &self.state.status;
        let Some(permission) = &status.permission else { return Vec::new() };
        let width = (self.size.0 as usize).saturating_sub(2 * MARGIN).max(16);
        let inner = width - 4;
        let edge = Style::new().fg(theme.accent);
        let strong = Style::new().fg(theme.accent_ink).add_modifier(Modifier::BOLD);
        let title = " Allow this? ";
        let rule = "─".repeat(width.saturating_sub(3 + text::width(title)));
        let mut lines = vec![Line::from(vec![
            margin(),
            Span::styled("╭─", edge),
            Span::styled(title, strong),
            Span::styled(format!("{rule}╮"), edge),
        ])];
        let row = |spans: Vec<Span<'static>>| boxed(spans, inner, edge);
        let label = [Span::styled(
            permission.label.clone(),
            Style::new().fg(theme.text).add_modifier(Modifier::BOLD),
        )];
        lines.extend(wrap(&label, inner, &[], &[]).into_iter().map(|line| row(line.spans)));
        for resource in &permission.resources {
            let spans = [Span::styled(resource.clone(), Style::new().fg(theme.dim))];
            lines.extend(wrap(&spans, inner, &[], &[]).into_iter().map(|line| row(line.spans)));
        }
        lines.push(row(Vec::new()));
        let mut keys = vec![
            Span::styled("y", strong),
            Span::styled(" allow   ", Style::new().fg(theme.dim)),
            Span::styled("n", strong),
            Span::styled(" deny", Style::new().fg(theme.dim)),
        ];
        if status.permission_queue > 0 {
            let waiting = format!("   {} more waiting", status.permission_queue);
            keys.push(Span::styled(waiting, Style::new().fg(theme.faint)));
        }
        lines.push(row(keys));
        lines.push(Line::from(vec![
            margin(),
            Span::styled(format!("╰{}╯", "─".repeat(width - 2)), edge),
        ]));
        lines
    }
}

/// A row of a box drawn in `edge`: its content padded to `inner` columns between the sides.
fn boxed(spans: Vec<Span<'static>>, inner: usize, edge: Style) -> Line<'static> {
    let content = fill(Line::from(spans), inner, Style::new());
    let mut line = lead(&[margin(), Span::styled("│ ", edge)], content);
    line.spans.push(Span::styled(" │", edge));
    line
}

fn heading(text: &str, theme: &Theme) -> Line<'static> {
    let style = Style::new().fg(theme.text).add_modifier(Modifier::BOLD);
    Line::from(vec![margin(), Span::styled(text.to_string(), style)])
}

fn dim_line(text: &str, theme: &Theme) -> Line<'static> {
    Line::from(vec![margin(), Span::styled(text.to_string(), Style::new().fg(theme.dim))])
}

/// A hairline across the column with a title in it, where one transcript gives way to another.
fn rule(title: &str, width: usize, theme: &Theme) -> Line<'static> {
    let inner = width.saturating_sub(2 * MARGIN);
    let title: String = title.chars().take(inner.saturating_sub(8)).collect();
    let tail = inner.saturating_sub(text::width(&title) + 4);
    Line::from(vec![
        margin(),
        Span::styled("── ", Style::new().fg(theme.hairline)),
        Span::styled(title, Style::new().fg(theme.dim)),
        Span::styled(format!(" {}", "─".repeat(tail)), Style::new().fg(theme.hairline)),
    ])
}

/// Cuts a line to `width` columns, ending in an ellipsis when it was longer.
fn truncate(line: Line<'static>, width: usize) -> Line<'static> {
    if line.width() <= width {
        return line;
    }
    let mut spans = Vec::new();
    let mut used = 0;
    for span in line.spans {
        let mut content = String::new();
        for ch in span.content.chars() {
            let w = text::width(ch.encode_utf8(&mut [0; 4]));
            if used + w + 1 > width {
                spans.push(Span::styled(content, span.style));
                spans.push(Span::styled("…", span.style));
                return Line::from(spans);
            }
            used += w;
            content.push(ch);
        }
        spans.push(Span::styled(content, span.style));
    }
    Line::from(spans)
}

/// The catalog as the picker lists it: favorites moved out of their sections into one on top, in
/// catalog order, as the desktop's `arrangeFavorites` does, and a way to add a provider.
fn model_rows(catalog: &[Row], favorites: &[String]) -> Vec<Row> {
    let favorite = |row: &&Row| !row.header && favorites.contains(&row.key);
    let favored: Vec<Row> =
        catalog.iter().filter(favorite).map(|row| Row { favorite: true, ..row.clone() }).collect();
    let mut rows = Vec::new();
    if !favored.is_empty() {
        rows.push(Row::header("favorites", "Favorites"));
        rows.extend(favored);
    }
    let rest: Vec<&Row> = catalog.iter().filter(|row| !favorite(row)).collect();
    for (index, row) in rest.iter().enumerate() {
        // A section its favorites emptied is dropped.
        if !row.header || rest.get(index + 1).is_some_and(|next| !next.header) {
            rows.push((*row).clone());
        }
    }
    rows.push(Row::header("more", "More"));
    rows.push(Row {
        key: "connect".into(),
        label: "Connect a provider or server…".into(),
        detail: "API keys and local model servers".into(),
        ..Row::default()
    });
    rows
}

/// Every local endpoint as `connectLocalServers` takes them, since it keeps only those it is
/// given: the saved ones, with `server` at `address`. A blank key keeps a server's saved key.
fn server_inputs(status: &Status, server: &str, address: &str) -> Value {
    let mut inputs = serde_json::Map::new();
    let endpoints = &status.pair_endpoints;
    for (key, endpoint) in [("ollama", &endpoints.ollama), ("lmStudio", &endpoints.lm_studio)] {
        if let Some(endpoint) = endpoint {
            inputs.insert(key.into(), json!(endpoint));
        }
    }
    for (provider, saved) in &status.servers {
        let mut input = json!({ "baseURL": saved.base_url });
        if let Some(model) = &saved.model {
            input["model"] = json!(model);
        }
        if let Some(limit) = saved.context_length {
            input["contextLength"] = json!(limit.to_string());
        }
        inputs.insert(provider.clone(), input);
    }
    match server {
        "ollama" | "lmStudio" => {
            inputs.insert(server.into(), json!(address));
        }
        _ => inputs.entry(server).or_insert_with(|| json!({}))["baseURL"] = json!(address),
    }
    Value::Object(inputs)
}

fn settings_rows(status: &Status) -> Vec<Row> {
    let on = |value: bool| if value { "On" } else { "Off" }.to_string();
    let row = |key: &str, label: &str, detail: String| Row {
        key: key.into(),
        label: label.into(),
        detail,
        ..Row::default()
    };
    let approve = if status.permission_mode == "auto" { "Automatically" } else { "Ask first" };
    vec![
        row("theme", "Theme", capitalized(&status.theme)),
        row("thinking", "Thinking traces", on(status.thinking_visible)),
        row("permissions", "Approve edits and commands", approve.into()),
        row("notify", "Bell when a turn finishes", on(status.notify_on_completion)),
        row("awake", "Keep the computer awake while working", on(status.keep_awake)),
        row("offline", "Fall back to a local model offline", on(status.offline_fallback)),
        row("debug", "Debug mode", on(status.debug)),
    ]
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or(String::new(), |first| first.to_uppercase().chain(chars).collect())
}

/// What a model provider is called, as the desktop's `providerLabel` names it.
fn provider_name(id: &str) -> String {
    match id {
        "local" => "Local".into(),
        "pair" => "NVIDIA PAIR".into(),
        "omlx" => "oMLX".into(),
        "custom" => "Custom server".into(),
        _ => PROVIDERS
            .iter()
            .find(|(key, _)| *key == id)
            .map_or_else(|| capitalized(id), |(_, name)| name.to_string()),
    }
}

/// A description's first sentence, kept short for a menu row.
fn first_sentence(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let sentence = &text[..text.find(". ").map_or(text.len(), |index| index + 1)];
    if sentence.chars().count() <= 72 {
        return sentence.to_string();
    }
    let cut: String = sentence.chars().take(70).collect();
    format!("{}…", cut.trim_end())
}

/// A context window as the desktop's `formatContextWindow` writes it.
fn context_window(tokens: u64) -> String {
    match tokens {
        t if t % 1_048_576 == 0 => format!("{}M", t / 1_048_576),
        t if t >= 1_000_000 => format!("{:.1}M", t as f64 / 1_000_000.0),
        t if t < 1_000 => t.to_string(),
        t if t % 1_000 == 0 => format!("{}K", t / 1_000),
        t if t % 1_024 == 0 => format!("{}K", t / 1_024),
        t => format!("~{}K", (t as f64 / 1_024.0).round()),
    }
}

/// Paths a terminal pasted when files were dropped on it, shell-escaped, quoted, or as file URLs;
/// none unless every one names a file Otis can attach.
fn pasted_paths(text: &str) -> Option<Vec<PathBuf>> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let (mut quote, mut escaped) = (None, false);
    for ch in text.trim().chars() {
        match ch {
            _ if escaped => {
                token.push(ch);
                escaped = false;
            }
            '\\' if quote != Some('\'') => escaped = true,
            '\'' | '"' if quote.is_none() => quote = Some(ch),
            '\'' | '"' if quote == Some(ch) => quote = None,
            ' ' | '\t' | '\n' | '\r' if quote.is_none() => {
                if !token.is_empty() {
                    tokens.push(std::mem::take(&mut token));
                }
            }
            _ => token.push(ch),
        }
    }
    if escaped || quote.is_some() {
        return None;
    }
    tokens.extend((!token.is_empty()).then_some(token));
    let mut paths = Vec::new();
    for token in tokens {
        let Some(url) = token.strip_prefix("file://") else {
            paths.push(PathBuf::from(token));
            continue;
        };
        // A file URL's path, percent-decoded.
        let (bytes, mut decoded, mut index) = (url.as_bytes(), Vec::new(), 0);
        while index < bytes.len() {
            let hex = |at: usize| bytes.get(at).and_then(|byte| char::from(*byte).to_digit(16));
            match (bytes[index], hex(index + 1), hex(index + 2)) {
                (b'%', Some(high), Some(low)) => {
                    decoded.push((high * 16 + low) as u8);
                    index += 3;
                }
                (byte, ..) => {
                    decoded.push(byte);
                    index += 1;
                }
            }
        }
        paths.push(PathBuf::from(String::from_utf8_lossy(&decoded).into_owned()));
    }
    let attachable =
        !paths.is_empty() && paths.iter().all(|path| mime(path).is_some() && path.is_file());
    attachable.then_some(paths)
}

fn mime(path: &std::path::Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_lowercase();
    if let Some((_, mime)) = IMAGE_TYPES.iter().find(|(ext, _)| *ext == extension) {
        return Some(mime);
    }
    DOCUMENT_EXTENSIONS.contains(&extension.as_str()).then_some(match extension.as_str() {
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        _ => "text/plain",
    })
}

fn attachment(path: &std::path::Path) -> Result<Attachment, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mime = mime(path).ok_or_else(|| format!("Otis cannot attach {name}."))?;
    let bytes = std::fs::read(path).map_err(|error| format!("Could not read {name}: {error}"))?;
    Ok(Attachment { name, mime, bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{PairEndpoints, Server};

    #[test]
    fn reads_dropped_paths_and_leaves_prose_alone() {
        let dir = std::env::temp_dir().join(format!("otis-paste-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let spaced = dir.join("a picture.png");
        std::fs::write(&spaced, b"\x89PNG").unwrap();
        let escaped = spaced.display().to_string().replace(' ', "\\ ");
        assert_eq!(pasted_paths(&escaped), Some(vec![spaced.clone()]));
        assert_eq!(pasted_paths(&format!("'{}'", spaced.display())), Some(vec![spaced.clone()]));
        let url = format!("file://{}", spaced.display().to_string().replace(' ', "%20"));
        assert_eq!(pasted_paths(&url), Some(vec![spaced.clone()]));
        assert_eq!(pasted_paths("What does screenshot.png contain?"), None);
        assert_eq!(pasted_paths("'/tmp/unfinished.png"), None);
        assert_eq!(pasted_paths("   "), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn writes_context_windows_like_the_desktop() {
        assert_eq!(context_window(1_048_576), "1M");
        assert_eq!(context_window(128_000), "128K");
        assert_eq!(context_window(131_072), "128K");
        assert_eq!(context_window(1_050_000), "1.1M");
    }

    #[test]
    fn filters_pickers_and_keeps_section_headers() {
        let row = |key: &str| Row { key: key.into(), label: key.into(), ..Row::default() };
        let rows = vec![
            Row::header("hosted", "Hosted"),
            row("kimi"),
            row("glm"),
            Row::header("local", "Local"),
            row("gemma"),
        ];
        let mut picker = Picker::new(PickerKind::Model, "Models", rows);
        picker.query = "g".into();
        let shown: Vec<&str> = picker.visible().iter().map(|r| r.key.as_str()).collect();
        assert_eq!(shown, ["hosted", "glm", "local", "gemma"]);
        picker.step(1);
        assert_eq!(picker.current().map(|r| r.key.as_str()), Some("gemma"));
    }

    #[test]
    fn shortens_descriptions_to_their_first_sentence() {
        assert_eq!(first_sentence("Makes PDFs.  Also more."), "Makes PDFs.");
    }

    #[test]
    fn keeps_every_saved_local_endpoint_when_connecting_one() {
        let status = Status {
            pair_endpoints: PairEndpoints {
                ollama: Some("http://127.0.0.1:11434".into()),
                lm_studio: None,
            },
            servers: HashMap::from([(
                "custom".to_string(),
                Server {
                    base_url: "http://127.0.0.1:9000".into(),
                    model: Some("m".into()),
                    context_length: Some(8192),
                },
            )]),
            ..Status::default()
        };
        let inputs = server_inputs(&status, "custom", "http://127.0.0.1:9100");
        assert_eq!(
            inputs,
            json!({
                "ollama": "http://127.0.0.1:11434",
                "custom": {
                    "baseURL": "http://127.0.0.1:9100",
                    "model": "m",
                    "contextLength": "8192",
                },
            })
        );
        let inputs = server_inputs(&status, "omlx", "http://127.0.0.1:8000");
        assert_eq!(inputs["omlx"], json!({ "baseURL": "http://127.0.0.1:8000" }));
        assert_eq!(inputs["custom"]["baseURL"], "http://127.0.0.1:9000");
    }
}
