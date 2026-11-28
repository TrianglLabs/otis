//! Transcript entries as terminal lines, in the desktop transcript's grammar: the user's words in a
//! bubble on the right, answers as Markdown, consecutive tool activity condensed into one run, and
//! thinking as a quiet line. Finished items go to the terminal's scrollback; the live tail redraws.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::protocol::{Artifact, Entry, Kind};
use crate::text::{self, fill, lead, markdown, wrap};
use crate::theme::Theme;

/// Columns kept clear on each side of the transcript.
pub const MARGIN: usize = 2;
const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/// Diff rows an edit shows before the rest is counted.
const DIFF_ROWS: usize = 12;

/// Actions whose subject is a path, shown as its name with the folder after.
const PATH_ACTIONS: [&str; 10] = [
    "read",
    "write",
    "edit",
    "edit_document",
    "save_attachment",
    "publish_artifact",
    "document_check",
    "document_inspect_pdf",
    "document_edit_pdf",
    "document_render",
];

/// Subjects that are sentences rather than code: a brief, a query, a fact.
const PROSE_ACTIONS: [&str; 8] = [
    "agent",
    "web_search",
    "recall",
    "remember",
    "forget",
    "routines_list",
    "routines_save",
    "routines_remove",
];

pub struct Look<'t> {
    pub theme: &'t Theme,
    pub width: usize,
    pub thinking_visible: bool,
    /// The animation frame, for spinners and the thinking shimmer.
    pub frame: usize,
}

impl Look<'_> {
    fn inner(&self) -> usize {
        self.width.saturating_sub(2 * MARGIN).max(10)
    }

    pub fn spinner(&self) -> Span<'static> {
        Span::styled(SPINNER[self.frame % SPINNER.len()], Style::new().fg(self.theme.accent))
    }
}

pub fn margin() -> Span<'static> {
    Span::raw(" ".repeat(MARGIN))
}

/// Spans wrapped to the column inside the margin, later lines hanging by `hang`.
pub fn indented(spans: &[Span<'static>], width: usize, hang: &str) -> Vec<Line<'static>> {
    let rest = [margin(), Span::raw(hang.to_string())];
    wrap(spans, width.saturating_sub(MARGIN), &[margin()], &rest)
}

/// How much of the transcript is final: entries before the index will not change, so they can go
/// to scrollback. While a turn runs, an entry is final once the next has begun, except tool calls,
/// which stay open until the run of them ends, and a document, which waits for its turn to choose
/// the revision to show.
pub fn settled(entries: &[Entry], busy: bool) -> usize {
    entries
        .iter()
        .enumerate()
        .position(|(index, entry)| {
            let later = &entries[index + 1..];
            let closed = match entry.kind {
                _ if !busy => true,
                _ if entry.artifact_display.as_deref() == Some("pending") => false,
                Kind::Tool => later.iter().any(|next| next.kind != Kind::Tool),
                _ => !later.is_empty(),
            };
            entry.streaming || entry.delivery.is_some() || !closed
        })
        .unwrap_or(entries.len())
}

/// A Canvas document a tool presented, once its turn chose the revision to show.
fn shown_artifact(entry: &Entry) -> Option<&Artifact> {
    let artifact = entry.artifact.as_ref()?;
    let display = entry.artifact_display.as_deref();
    (artifact.kind != "text" && display != Some("pending") && display != Some("superseded"))
        .then_some(artifact)
}

/// Lines for a span of entries, each item followed by a blank line, grouped as the desktop groups
/// them: two or more consecutive tool calls condense into a run, and empty answers, tool calls
/// that found nothing, and finished thinking while traces are hidden leave no row. `active` marks
/// the span as the live tail of a running turn, whose last item is the one in progress.
pub fn render(entries: &[Entry], look: &Look, active: bool) -> Vec<Line<'static>> {
    let visible = entries.iter().filter(|entry| match entry.kind {
        Kind::Reasoning => look.thinking_visible || entry.streaming,
        Kind::Tool => entry.outcome.as_deref() != Some("empty"),
        Kind::Message if !entry.by_user() => {
            !entry.text.trim().is_empty() || entry.artifacts.as_ref().is_some_and(|a| !a.is_empty())
        }
        _ => true,
    });
    let mut items: Vec<Vec<&Entry>> = Vec::new();
    for entry in visible {
        let activity = entry.kind == Kind::Tool && shown_artifact(entry).is_none();
        let joins = items.last().is_some_and(|last| {
            let tool = last[0].kind == Kind::Tool && shown_artifact(last[0]).is_none();
            activity && tool
        });
        if joins {
            items.last_mut().expect("the run it joins").push(entry);
        } else {
            items.push(vec![entry]);
        }
    }
    let theme = look.theme;
    let count = items.len();
    let mut lines = Vec::new();
    for (index, item) in items.into_iter().enumerate() {
        let live = active && index + 1 == count;
        let entry = item[0];
        match entry.kind {
            _ if item.len() > 1 => run_lines(&item, look, live, &mut lines),
            Kind::Tool => tool_lines(entry, look, live, &mut lines),
            Kind::Debug => {
                let spans = [Span::styled(entry.text.clone(), Style::new().fg(theme.faint))];
                lines.extend(indented(&spans, look.width, ""));
            }
            Kind::Reasoning if entry.streaming => {
                let mut status = vec![margin(), look.spinner(), Span::raw(" ")];
                status.extend(shimmer("Thinking…", look));
                lines.push(Line::from(status));
                // The freshest lines of the live trace, as the desktop's three-line preview shows.
                if look.thinking_visible {
                    let trace =
                        [Span::styled(entry.text.trim().to_string(), Style::new().fg(theme.faint))];
                    let pad = [margin(), Span::raw("  ")];
                    let preview = wrap(&trace, look.width.saturating_sub(MARGIN), &pad, &pad);
                    let skip = preview.len().saturating_sub(3);
                    lines.extend(preview.into_iter().skip(skip));
                }
            }
            Kind::Reasoning => {
                let label = match entry.duration_ms {
                    Some(ms) => format!("Thought for {}", elapsed(ms)),
                    None => "Thought".to_string(),
                };
                let dim = Style::new().fg(theme.dim).add_modifier(Modifier::ITALIC);
                lines.push(Line::from(vec![margin(), Span::styled(label, dim)]));
                let spans =
                    [Span::styled(entry.text.trim().to_string(), Style::new().fg(theme.faint))];
                let bar = [margin(), Span::styled("│ ", Style::new().fg(theme.hairline))];
                lines.extend(wrap(&spans, look.width.saturating_sub(MARGIN), &bar, &bar));
            }
            Kind::Notice => {
                let (mark, color) = match entry.network.as_deref() {
                    Some("offline") => ("○ ", theme.orange),
                    Some("online") => ("● ", theme.green),
                    _ => ("· ", theme.faint),
                };
                let spans = [
                    Span::styled(mark, Style::new().fg(color)),
                    Span::styled(entry.text.clone(), Style::new().fg(theme.dim)),
                ];
                lines.extend(indented(&spans, look.width, "  "));
            }
            // The user's words in a bubble on the right, as wide as the words up to four fifths of
            // the column, with what rode along named below them.
            Kind::Message if entry.by_user() => {
                let surface = Style::new().bg(theme.user);
                let inner = look.inner() * 4 / 5 - 4;
                let words = entry.message_text.as_deref().unwrap_or(&entry.text).trim_end();
                let mut body = match words {
                    "" => Vec::new(),
                    _ => wrap(
                        &[Span::styled(words.to_string(), surface.fg(theme.text))],
                        inner,
                        &[],
                        &[],
                    ),
                };
                let images = entry.images.iter().flatten().map(String::as_str);
                let attached = images.chain(entry.artifacts.iter().flatten().map(Artifact::title));
                for name in attached {
                    let spans = [Span::styled(format!("◫ {name}"), surface.fg(theme.dim))];
                    body.extend(wrap(&spans, inner, &[], &[Span::raw("  ")]));
                }
                let content = body.iter().map(Line::width).max().unwrap_or(0);
                let outer = content + 4;
                let indent = look.width.saturating_sub(MARGIN + outer);
                let tag = match entry.delivery.as_deref() {
                    Some("queued") => "queued ",
                    Some("steering") => "steering ",
                    _ => "",
                };
                let edge = Style::new().fg(theme.user);
                let pad =
                    |text: &str| Span::raw(" ".repeat(indent.saturating_sub(text::width(text))));
                lines.push(Line::from(vec![
                    pad(tag),
                    Span::styled(tag, Style::new().fg(theme.accent_ink)),
                    Span::styled("▄".repeat(outer), edge),
                ]));
                for line in body {
                    let mut spans = vec![pad(""), Span::styled("  ", surface)];
                    spans.extend(fill(line, content, surface).spans);
                    spans.push(Span::styled("  ", surface));
                    lines.push(Line::from(spans));
                }
                lines.push(Line::from(vec![pad(""), Span::styled("▀".repeat(outer), edge)]));
            }
            Kind::Message => {
                if entry.text.starts_with("Error:") || entry.text.starts_with("Could not") {
                    let spans = [Span::styled(entry.text.clone(), Style::new().fg(theme.pink))];
                    lines.extend(indented(&spans, look.width, ""));
                } else {
                    let body = markdown(&entry.text, look.inner(), theme);
                    lines.extend(body.into_iter().map(|line| lead(&[margin()], line)));
                }
                for artifact in entry.artifacts.iter().flatten().filter(|a| a.kind != "text") {
                    lines.push(Line::default());
                    lines.extend(artifact_card(artifact, look));
                }
            }
        }
        lines.push(Line::default());
    }
    lines
}

/// Text with a highlight sweeping across it, the terminal's thinking orb.
pub fn shimmer(text: &str, look: &Look) -> Vec<Span<'static>> {
    let chars: Vec<char> = text.chars().collect();
    let sweep = (look.frame / 2) % (chars.len() + 8);
    chars
        .iter()
        .enumerate()
        .map(|(index, ch)| {
            let near = (index as isize - sweep as isize + 4).unsigned_abs() <= 1;
            let color = if near { look.theme.text } else { look.theme.dim };
            Span::styled(ch.to_string(), Style::new().fg(color))
        })
        .collect()
}

/// A duration as the desktop's `formatElapsed` writes it.
pub fn elapsed(ms: f64) -> String {
    let seconds = (ms / 1000.0).round() as u64;
    match seconds {
        0 => format!("{}ms", ms.round() as u64),
        1..60 => format!("{seconds}s"),
        _ => format!("{}m {}s", seconds / 60, seconds % 60),
    }
}

/// One action's words: its verb, present while it runs and past once done (the desktop's
/// `tool.*`), its subject, and the folder of a path.
fn activity(entry: &Entry, done: bool, look: &Look) -> Vec<Span<'static>> {
    let theme = look.theme;
    let (Some(action), Some(subject)) = (&entry.activity_action, &entry.activity_subject) else {
        return vec![Span::styled(entry.text.clone(), Style::new().fg(theme.dim))];
    };
    let (doing, did) = match action.as_str() {
        "web_search" => ("Searching the web for", "Searched the web for"),
        "web_read" | "read" => ("Reading", "Read"),
        "skill" => ("Loading skill", "Loaded skill"),
        "grep" => ("Searching files for", "Searched files for"),
        "glob" => ("Finding files", "Found files"),
        "write" => ("Writing", "Wrote"),
        "save_attachment" => ("Saving", "Saved"),
        "edit" => ("Editing", "Edited"),
        "edit_document" => ("Editing document", "Edited document"),
        "document_check" => ("Checking document", "Checked document"),
        "document_inspect_pdf" => ("Inspecting PDF", "Inspected PDF"),
        "document_create" => ("Creating document", "Created document"),
        "document_edit_pdf" => ("Editing PDF", "Edited PDF"),
        "document_convert" => ("Converting document", "Converted document"),
        "document_render" => ("Rendering document", "Rendered document"),
        "publish_artifact" => ("Publishing", "Published"),
        "agent" => ("Delegating", "Delegated"),
        "wait_coworkers" => ("Waiting for", "Received"),
        "search_command" => ("Searching files", "Searched files"),
        "inspect_command" => ("Inspecting files", "Inspected files"),
        "git_command" => ("Checking git", "Checked git"),
        "command" => ("Running", "Ran"),
        "recall" => ("Recalling", "Recalled"),
        "remember" => ("Remembering", "Remembered"),
        "forget" => ("Forgetting", "Forgot"),
        "routines_list" => ("Listing routines", "Listed routines"),
        "routines_save" => ("Saving routine", "Saved routine"),
        "routines_remove" => ("Removing routine", "Removed routine"),
        _ => ("Working", "Done"),
    };
    let split = PATH_ACTIONS.contains(&action.as_str()) && !subject.contains(", ");
    let (name, folder) = match subject.rfind('/') {
        Some(slash) if split => (&subject[slash + 1..], Some(&subject[..slash])),
        _ => (subject.as_str(), None),
    };
    let ink = if PROSE_ACTIONS.contains(&action.as_str()) { theme.text } else { theme.accent_ink };
    let mut spans = vec![
        Span::styled(format!("{} ", if done { did } else { doing }), Style::new().fg(theme.dim)),
        Span::styled(name.lines().next().unwrap_or("").to_string(), Style::new().fg(ink)),
    ];
    if let Some(folder) = folder {
        spans.push(Span::styled(format!(" · {folder}/"), Style::new().fg(theme.faint)));
    }
    spans
}

fn diff_counts(entry: &Entry) -> (usize, usize) {
    let Some(diff) = &entry.diff else { return (0, 0) };
    text::parse_diff(diff).iter().fold((0, 0), |(added, removed), row| match row {
        text::DiffRow::Line { sign: '+', .. } => (added + 1, removed),
        text::DiffRow::Line { sign: '-', .. } => (added, removed + 1),
        _ => (added, removed),
    })
}

fn counts_spans((added, removed): (usize, usize), look: &Look) -> Vec<Span<'static>> {
    if added + removed == 0 {
        return Vec::new();
    }
    vec![
        Span::styled(format!(" +{added}"), Style::new().fg(look.theme.green)),
        Span::styled(format!(" −{removed}"), Style::new().fg(look.theme.pink)),
    ]
}

fn tool_lines(entry: &Entry, look: &Look, live: bool, lines: &mut Vec<Line<'static>>) {
    if let Some(artifact) = shown_artifact(entry) {
        return lines.extend(artifact_card(artifact, look));
    }
    let theme = look.theme;
    let mark =
        if live { look.spinner() } else { Span::styled("•", Style::new().fg(theme.faint)) };
    let mut spans = vec![mark, Span::raw(" ")];
    spans.extend(activity(entry, !live, look));
    spans.extend(counts_spans(diff_counts(entry), look));
    lines.extend(indented(&spans, look.width, "  "));
    if let Some(diff) = &entry.diff {
        let pad = [Span::raw(" ".repeat(MARGIN + 2))];
        let body = text::diff(diff, look.inner() - 2, DIFF_ROWS, theme);
        lines.extend(body.into_iter().map(|line| lead(&pad, line)));
    }
}

/// A run of actions: the latest one while it works, then what the run amounted to, kind by kind
/// in the order they first happened, with each change still in view.
fn run_lines(run: &[&Entry], look: &Look, live: bool, lines: &mut Vec<Line<'static>>) {
    let theme = look.theme;
    if live {
        let mut spans = vec![look.spinner(), Span::raw(" ")];
        spans.extend(activity(run.last().expect("a run holds entries"), false, look));
        spans.push(Span::styled(format!("  {} actions", run.len()), Style::new().fg(theme.faint)));
        return lines.extend(indented(&spans, look.width, "  "));
    }
    let mut parts: Vec<(&str, &str, usize, (usize, usize))> = Vec::new();
    for entry in run {
        let (one, other) = match entry.activity_kind.as_deref().unwrap_or("shell") {
            "file_read" => ("file read", "files read"),
            "web_read" => ("page read", "pages read"),
            "file_search" | "web_search" => ("search", "searches"),
            "file_write" | "file_edit" => ("change", "changes"),
            "file_inspect" | "git" => ("check", "checks"),
            "agent" => ("delegation", "delegations"),
            "memory" => ("memory", "memories"),
            "routine" => ("routine", "routines"),
            _ => ("command", "commands"),
        };
        let (added, removed) = diff_counts(entry);
        match parts.iter_mut().find(|part| part.0 == one) {
            Some(part) => {
                part.2 += 1;
                part.3 = (part.3.0 + added, part.3.1 + removed);
            }
            None => parts.push((one, other, 1, (added, removed))),
        }
    }
    let mut spans = vec![Span::styled("•", Style::new().fg(theme.faint)), Span::raw(" ")];
    for (index, (one, other, count, counts)) in parts.into_iter().enumerate() {
        if index > 0 {
            spans.push(Span::styled(" · ", Style::new().fg(theme.faint)));
        }
        let label = format!("{count} {}", if count == 1 { one } else { other });
        spans.push(Span::styled(label, Style::new().fg(theme.dim)));
        spans.extend(counts_spans(counts, look));
    }
    lines.extend(indented(&spans, look.width, "  "));
    // Reads and searches condense; what changed stays in view.
    for entry in run.iter().filter(|entry| entry.diff.is_some()) {
        let mut nested = Vec::new();
        tool_lines(entry, look, false, &mut nested);
        lines.extend(nested.into_iter().map(|line| lead(&[Span::raw("  ")], line)));
    }
}

/// A Canvas document, which this terminal cannot draw: its name, kind, and where to see it.
fn artifact_card(artifact: &Artifact, look: &Look) -> Vec<Line<'static>> {
    let theme = look.theme;
    let edge = Style::new().fg(theme.border);
    let label = format!("{}  ", artifact.title());
    let detail = format!("{} · open it in Otis on the desktop", artifact.kind);
    let width = (text::width(&label) + text::width(&detail) + 4).min(look.inner());
    let rule = "─".repeat(width - 2);
    let body = [
        Span::styled("◆ ", Style::new().fg(theme.accent)),
        Span::styled(label, Style::new().fg(theme.text).add_modifier(Modifier::BOLD)),
        Span::styled(detail, Style::new().fg(theme.dim)),
    ];
    let mut lines = vec![Line::from(vec![margin(), Span::styled(format!("╭{rule}╮"), edge)])];
    for line in wrap(&body, width - 4, &[], &[]) {
        let mut spans = vec![margin(), Span::styled("│ ", edge)];
        spans.extend(fill(line, width - 4, Style::new()).spans);
        spans.push(Span::styled(" │", edge));
        lines.push(Line::from(spans));
    }
    lines.push(Line::from(vec![margin(), Span::styled(format!("╰{rule}╯"), edge)]));
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::Terminal;

    fn entry(id: u64, kind: Kind, speaker: &str, text: &str) -> Entry {
        Entry { id, kind, speaker: speaker.into(), text: text.into(), ..Entry::default() }
    }

    fn tool(id: u64, action: &str, subject: &str, kind: &str) -> Entry {
        Entry {
            activity_action: Some(action.into()),
            activity_subject: Some(subject.into()),
            activity_kind: Some(kind.into()),
            ..entry(id, Kind::Tool, "Tool", "")
        }
    }

    fn plain(lines: &[Line]) -> Vec<String> {
        let text = |line: &Line| line.spans.iter().map(|s| s.content.as_ref()).collect::<String>();
        lines.iter().map(|line| text(line).trim_end().to_string()).collect()
    }

    #[test]
    fn settles_entries_once_the_next_has_begun_and_runs_once_they_end() {
        let you = entry(1, Kind::Message, "You", "go");
        let read = tool(2, "read", "a.ts", "file_read");
        let edit = tool(3, "edit", "b.ts", "file_edit");
        let streaming = Entry { streaming: true, ..entry(4, Kind::Message, "Otis", "Do") };
        assert_eq!(settled(&[you.clone(), read.clone(), edit.clone()], true), 1);
        assert_eq!(settled(&[you.clone(), read.clone(), edit.clone(), streaming.clone()], true), 3);
        let answered = entry(4, Kind::Message, "Otis", "Done.");
        assert_eq!(settled(&[you.clone(), read, edit, answered], false), 4);
        let queued =
            Entry { delivery: Some("queued".into()), ..entry(5, Kind::Message, "You", "and") };
        assert_eq!(settled(&[you, queued], true), 1);
    }

    #[test]
    fn holds_a_document_until_its_turn_chooses_the_revision() {
        let document = Entry {
            artifact_display: Some("pending".into()),
            ..tool(1, "write", "report.md", "file_write")
        };
        let answer = entry(2, Kind::Message, "Otis", "Here it is.");
        assert_eq!(settled(&[document.clone(), answer.clone()], true), 0);
        assert_eq!(settled(&[document, answer], false), 2);
    }

    #[test]
    fn condenses_a_run_and_keeps_its_changes_in_view() {
        let theme = Theme::new("default", Terminal::fixed());
        let look = Look { theme: &theme, width: 60, thinking_visible: false, frame: 0 };
        let edit = Entry {
            diff: Some("@@ -1 +1 @@\n-a\n+b\n".into()),
            ..tool(3, "edit", "src/b.ts", "file_edit")
        };
        let entries = [
            tool(1, "read", "src/a.ts", "file_read"),
            tool(2, "read", "src/c.ts", "file_read"),
            edit,
        ];
        let lines = plain(&render(&entries, &look, false));
        assert_eq!(lines[0], "  • 2 files read · 1 change +1 −1");
        assert_eq!(lines[1], "    • Edited b.ts · src/ +1 −1");
        assert!(lines[2].contains("1 - a"));
    }

    #[test]
    fn hides_finished_thinking_unless_traces_show() {
        let theme = Theme::new("default", Terminal::fixed());
        let thought =
            Entry { duration_ms: Some(4200.0), ..entry(1, Kind::Reasoning, "Thinking", "hmm") };
        let hidden = Look { theme: &theme, width: 60, thinking_visible: false, frame: 0 };
        assert!(render(std::slice::from_ref(&thought), &hidden, false).is_empty());
        let shown = Look { thinking_visible: true, ..hidden };
        assert_eq!(plain(&render(&[thought], &shown, false))[..2], ["  Thought for 4s", "  │ hmm"]);
    }

    #[test]
    fn right_aligns_the_users_bubble() {
        let theme = Theme::new("default", Terminal::fixed());
        let look = Look { theme: &theme, width: 40, thinking_visible: false, frame: 0 };
        let lines = plain(&render(&[entry(1, Kind::Message, "You", "hello")], &look, false));
        assert_eq!(lines[1], format!("{}  hello", " ".repeat(29)));
        assert_eq!(text::width(&lines[1]) + MARGIN + 2, 40);
    }

    #[test]
    fn draws_on_a_terminal_too_narrow_for_its_margins() {
        let theme = Theme::new("default", Terminal::fixed());
        let look = Look { theme: &theme, width: 1, thinking_visible: true, frame: 0 };
        let entries = [
            entry(1, Kind::Notice, "Otis", "offline"),
            entry(2, Kind::Debug, "Debug", "trace"),
            tool(3, "read", "a.ts", "file_read"),
        ];
        assert!(!render(&entries, &look, false).is_empty());
    }

    #[test]
    fn writes_durations_like_the_desktop() {
        assert_eq!(elapsed(450.0), "450ms");
        assert_eq!(elapsed(4200.0), "4s");
        assert_eq!(elapsed(125_000.0), "2m 5s");
    }
}
