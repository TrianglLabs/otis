//! Styled text laid out for a width: word wrapping over spans, Markdown, and unified diffs.

use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::theme::Theme;

pub fn width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

fn width_of(spans: &[Span]) -> usize {
    spans.iter().map(|span| width(&span.content)).sum()
}

/// Word-wraps styled spans into lines of at most `width` columns. The first line opens with
/// `first`, later ones with `rest`; a word wider than a line breaks between graphemes, and a `\n`
/// ends its line.
pub fn wrap(
    spans: &[Span<'static>],
    width: usize,
    first: &[Span<'static>],
    rest: &[Span<'static>],
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let mut line = first.to_vec();
    let mut start = width_of(first);
    let mut used = start;
    // Whitespace waits until a word follows it on the same line.
    let mut pending: Vec<Span<'static>> = Vec::new();
    let mut pending_width = 0;
    let mut finish = |line: &mut Vec<Span<'static>>, used: &mut usize, start: &mut usize| {
        lines.push(Line::from(std::mem::replace(line, rest.to_vec())));
        *start = width_of(rest);
        *used = *start;
    };
    for span in spans {
        for piece in split_words(&span.content) {
            if piece == "\n" {
                pending.clear();
                pending_width = 0;
                finish(&mut line, &mut used, &mut start);
                continue;
            }
            let piece_width = self::width(piece);
            if piece.chars().all(char::is_whitespace) {
                if used > start {
                    pending.push(Span::styled(piece.to_string(), span.style));
                    pending_width += piece_width;
                }
                continue;
            }
            if used + pending_width + piece_width > width && used > start {
                pending.clear();
                pending_width = 0;
                finish(&mut line, &mut used, &mut start);
            }
            line.append(&mut pending);
            used += pending_width;
            pending_width = 0;
            if used + piece_width <= width {
                line.push(Span::styled(piece.to_string(), span.style));
                used += piece_width;
                continue;
            }
            let mut chunk = String::new();
            for grapheme in piece.graphemes(true) {
                let grapheme_width = self::width(grapheme);
                if used + grapheme_width > width && used > start {
                    line.push(Span::styled(std::mem::take(&mut chunk), span.style));
                    finish(&mut line, &mut used, &mut start);
                }
                chunk.push_str(grapheme);
                used += grapheme_width;
            }
            line.push(Span::styled(chunk, span.style));
        }
    }
    if used > start || lines.is_empty() {
        lines.push(Line::from(line));
    }
    lines
}

/// Splits text into words, runs of whitespace, and lone newlines.
fn split_words(text: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut begin = 0;
    let mut space: Option<bool> = None;
    for (index, ch) in text.char_indices() {
        if ch == '\n' {
            if begin < index {
                pieces.push(&text[begin..index]);
            }
            pieces.push("\n");
            begin = index + 1;
            space = None;
            continue;
        }
        let is_space = ch.is_whitespace();
        if space.is_some_and(|was| was != is_space) {
            pieces.push(&text[begin..index]);
            begin = index;
        }
        space = Some(is_space);
    }
    if begin < text.len() {
        pieces.push(&text[begin..]);
    }
    pieces
}

/// Breaks spans at exactly the line's width, as code reads: no reflow at word boundaries. One
/// column stays free on the right, so a filled surface keeps an edge.
fn wrap_hard(
    spans: &[Span<'static>],
    width: usize,
    first: &[Span<'static>],
    rest: &[Span<'static>],
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let mut line = first.to_vec();
    let mut start = width_of(first);
    let mut used = start;
    for span in spans {
        let mut chunk = String::new();
        for grapheme in span.content.graphemes(true) {
            let grapheme_width = self::width(grapheme);
            if used + grapheme_width >= width && used > start {
                line.push(Span::styled(std::mem::take(&mut chunk), span.style));
                lines.push(Line::from(std::mem::replace(&mut line, rest.to_vec())));
                start = width_of(rest);
                used = start;
            }
            chunk.push_str(grapheme);
            used += grapheme_width;
        }
        line.push(Span::styled(chunk, span.style));
    }
    lines.push(Line::from(line));
    lines
}

/// Pads a line with spaces in `style` to `width` columns, for surfaces that fill their row.
pub fn fill(mut line: Line<'static>, width: usize, style: Style) -> Line<'static> {
    let used = line.width();
    if used < width {
        line.spans.push(Span::styled(" ".repeat(width - used), style));
    }
    line
}

/// Prepends a prefix to a line's spans.
pub fn lead(prefix: &[Span<'static>], line: Line<'static>) -> Line<'static> {
    Line::from([prefix.to_vec(), line.spans].concat())
}

/// An open container a block sits in, outermost first.
enum Container {
    Quote,
    List(Option<u64>),
    /// A list item's marker, shown on its first line and as blank indent after.
    Item {
        marker: String,
        shown: bool,
    },
}

#[derive(Default)]
struct Table {
    alignments: Vec<Alignment>,
    rows: Vec<Vec<Vec<Span<'static>>>>,
    cell: Vec<Span<'static>>,
}

struct Markdown<'t> {
    theme: &'t Theme,
    width: usize,
    lines: Vec<Line<'static>>,
    inline: Vec<Span<'static>>,
    styles: Vec<Style>,
    containers: Vec<Container>,
    code: Option<(String, String)>,
    table: Option<Table>,
}

/// Renders Markdown as the desktop's `Markdown` component does, for a terminal `width` columns
/// wide. Unfinished Markdown, mid-stream, renders as far as it parses.
pub fn markdown(text: &str, width: usize, theme: &Theme) -> Vec<Line<'static>> {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_MATH;
    let mut markdown = Markdown {
        theme,
        width: width.max(8),
        lines: Vec::new(),
        inline: Vec::new(),
        styles: vec![Style::new().fg(theme.text)],
        containers: Vec::new(),
        code: None,
        table: None,
    };
    for event in Parser::new_ext(text, options) {
        markdown.event(event);
    }
    markdown.flush();
    markdown.lines
}

impl Markdown<'_> {
    fn style(&self) -> Style {
        *self.styles.last().expect("the base style stays")
    }

    fn push_style(&mut self, change: impl FnOnce(Style) -> Style) {
        self.styles.push(change(self.style()));
    }

    fn text(&mut self, text: &str, style: Style) {
        let span = Span::styled(text.to_string(), style);
        match &mut self.table {
            Some(table) => table.cell.push(span),
            None => self.inline.push(span),
        }
    }

    /// What a block's first line and its later lines lead with, from its containers.
    fn prefixes(&mut self) -> (Vec<Span<'static>>, Vec<Span<'static>>) {
        let (mut first, mut rest) = (Vec::new(), Vec::new());
        let bar = Style::new().fg(self.theme.border);
        let dim = Style::new().fg(self.theme.dim);
        for container in &mut self.containers {
            match container {
                Container::Quote => {
                    first.push(Span::styled("│ ", bar));
                    rest.push(Span::styled("│ ", bar));
                }
                Container::List(_) => {}
                Container::Item { marker, shown } => {
                    let blank = Span::raw(" ".repeat(width(marker)));
                    first.push(if *shown {
                        blank.clone()
                    } else {
                        Span::styled(marker.clone(), dim)
                    });
                    rest.push(blank);
                    *shown = true;
                }
            }
        }
        (first, rest)
    }

    /// A blank line between blocks, carrying the quote bars around it; never two in a row.
    fn gap(&mut self) {
        let blank = |line: &Line| {
            line.spans.iter().all(|span| {
                span.style.bg.is_none() && span.content.trim_matches([' ', '│']).is_empty()
            })
        };
        if self.lines.last().is_none_or(blank) {
            return;
        }
        let quotes = self.containers.iter().filter(|c| matches!(c, Container::Quote)).count();
        let bars = "│ ".repeat(quotes).trim_end().to_string();
        self.lines.push(Line::from(Span::styled(bars, Style::new().fg(self.theme.border))));
    }

    fn flush(&mut self) {
        if self.inline.is_empty() {
            return;
        }
        let spans = std::mem::take(&mut self.inline);
        let (first, rest) = self.prefixes();
        self.lines.extend(wrap(&spans, self.width, &first, &rest));
    }

    /// Lines a block laid out itself, behind its containers' prefixes.
    fn block(&mut self, lines: Vec<Line<'static>>) {
        let (first, rest) = self.prefixes();
        for (index, line) in lines.into_iter().enumerate() {
            self.lines.push(lead(if index == 0 { &first } else { &rest }, line));
        }
    }

    fn inner_width(&self) -> usize {
        let indent: usize = self
            .containers
            .iter()
            .map(|container| match container {
                Container::Quote => 2,
                Container::List(_) => 0,
                Container::Item { marker, .. } => width(marker),
            })
            .sum();
        self.width.saturating_sub(indent).max(4)
    }

    fn event(&mut self, event: Event) {
        let theme = self.theme;
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(text) => match &mut self.code {
                Some((_, code)) => code.push_str(&text),
                None => self.text(&text, self.style()),
            },
            Event::Code(code) => self.text(&code, Style::new().fg(theme.text).bg(theme.code)),
            Event::InlineMath(math) | Event::DisplayMath(math) => {
                self.text(&math, Style::new().fg(theme.accent_ink).add_modifier(Modifier::ITALIC))
            }
            Event::Html(html) | Event::InlineHtml(html) => self.text(&html, self.style()),
            Event::SoftBreak => self.text(" ", self.style()),
            Event::HardBreak => self.text("\n", self.style()),
            Event::Rule => {
                self.flush();
                self.gap();
                let rule =
                    Span::styled("─".repeat(self.inner_width()), Style::new().fg(theme.hairline));
                self.block(vec![Line::from(rule)]);
            }
            Event::TaskListMarker(done) => {
                let (mark, color) = if done { ("☑ ", theme.accent) } else { ("☐ ", theme.dim) };
                self.text(mark, Style::new().fg(color));
            }
            Event::FootnoteReference(name) => self.text(&format!("[{name}]"), self.style()),
        }
    }

    fn start(&mut self, tag: Tag) {
        let theme = self.theme;
        match tag {
            // An item's first paragraph sits on its marker's line.
            Tag::Paragraph => {
                if !matches!(self.containers.last(), Some(Container::Item { shown: false, .. })) {
                    self.gap();
                }
            }
            // The desktop sets headings apart by weight and size; a terminal has weight alone, so
            // the top level also takes an underline.
            Tag::Heading { level, .. } => {
                self.gap();
                let underline = if level == HeadingLevel::H1 {
                    Modifier::UNDERLINED
                } else {
                    Modifier::empty()
                };
                self.push_style(|style| {
                    style.fg(theme.text).add_modifier(Modifier::BOLD | underline)
                });
            }
            Tag::BlockQuote(_) => {
                self.flush();
                self.gap();
                self.containers.push(Container::Quote);
                self.push_style(|style| style.fg(theme.dim));
            }
            Tag::CodeBlock(kind) => {
                self.flush();
                self.gap();
                let language = match kind {
                    CodeBlockKind::Fenced(info) => {
                        info.split_whitespace().next().unwrap_or("").to_string()
                    }
                    CodeBlockKind::Indented => String::new(),
                };
                self.code = Some((language, String::new()));
            }
            Tag::List(start) => {
                self.flush();
                if !self.containers.iter().any(|c| matches!(c, Container::Item { .. })) {
                    self.gap();
                }
                self.containers.push(Container::List(start));
            }
            Tag::Item => {
                self.flush();
                let marker = match self.containers.last_mut() {
                    Some(Container::List(Some(number))) => {
                        let marker = format!("{number}. ");
                        *number += 1;
                        marker
                    }
                    _ => "• ".to_string(),
                };
                self.containers.push(Container::Item { marker, shown: false });
            }
            Tag::Emphasis => self.push_style(|style| style.add_modifier(Modifier::ITALIC)),
            Tag::Strong => self.push_style(|style| style.add_modifier(Modifier::BOLD)),
            Tag::Strikethrough => {
                self.push_style(|style| style.add_modifier(Modifier::CROSSED_OUT))
            }
            Tag::Link { .. } => {
                self.push_style(|style| style.fg(theme.cyan).add_modifier(Modifier::UNDERLINED))
            }
            Tag::Image { .. } => {
                self.push_style(|style| style.fg(theme.dim));
                self.text("🖼 ", self.style());
            }
            Tag::Table(alignments) => {
                self.flush();
                self.gap();
                self.table = Some(Table { alignments, ..Table::default() });
            }
            Tag::TableHead | Tag::TableRow => {
                self.table.as_mut().expect("an open table").rows.push(Vec::new())
            }
            Tag::TableCell => {}
            _ => self.push_style(|style| style),
        }
    }

    fn end(&mut self, tag: TagEnd) {
        let theme = self.theme;
        match tag {
            TagEnd::Paragraph => self.flush(),
            TagEnd::Heading(_) => {
                self.flush();
                self.styles.pop();
            }
            TagEnd::BlockQuote(_) => {
                self.flush();
                self.containers.pop();
                self.styles.pop();
            }
            TagEnd::CodeBlock => {
                let (language, code) = self.code.take().expect("an open code block");
                let inner = self.inner_width();
                let surface = Style::new().bg(theme.code);
                let ink = Style::new().fg(theme.text).bg(theme.code);
                let label =
                    Line::from(Span::styled(format!(" {language}"), surface.fg(theme.faint)));
                let mut lines = vec![fill(label, inner, surface)];
                let pad = [Span::styled("  ", surface)];
                for source in code.trim_end_matches('\n').split('\n') {
                    let spans = [Span::styled(source.replace('\t', "    "), ink)];
                    for line in wrap_hard(&spans, inner, &pad, &pad) {
                        lines.push(fill(line, inner, surface));
                    }
                }
                lines.push(fill(Line::default(), inner, surface));
                self.block(lines);
            }
            TagEnd::List(_) | TagEnd::Item => {
                self.flush();
                self.containers.pop();
            }
            TagEnd::Table => {
                let table = self.table.take().expect("an open table");
                let lines = render_table(table, self.inner_width(), theme);
                self.block(lines);
            }
            TagEnd::TableHead | TagEnd::TableRow => {}
            TagEnd::TableCell => {
                let table = self.table.as_mut().expect("an open table");
                let cell = std::mem::take(&mut table.cell);
                table.rows.last_mut().expect("an open row").push(cell);
            }
            _ => {
                self.styles.pop();
            }
        }
    }
}

/// A table with hairline rules: the header in bold over a rule, columns divided, each cell wrapped
/// to the share of the width its content asks for.
fn render_table(table: Table, available: usize, theme: &Theme) -> Vec<Line<'static>> {
    let columns = table.rows.iter().map(Vec::len).max().unwrap_or(0);
    if columns == 0 {
        return Vec::new();
    }
    let rule = Style::new().fg(theme.border);
    let natural: Vec<usize> = (0..columns)
        .map(|column| {
            let cells = table.rows.iter().filter_map(|row| row.get(column));
            cells.map(|cell| width_of(cell)).max().unwrap_or(0).max(1)
        })
        .collect();
    let room = available.saturating_sub(3 * (columns - 1)).max(columns);
    let total: usize = natural.iter().sum();
    let widths: Vec<usize> = if total <= room {
        natural
    } else {
        natural.iter().map(|natural| (natural * room / total).max(3)).collect()
    };
    let mut lines = Vec::new();
    for (index, row) in table.rows.iter().enumerate() {
        let cells: Vec<Vec<Line<'static>>> = (0..columns)
            .map(|column| {
                let mut spans = row.get(column).cloned().unwrap_or_default();
                if index == 0 {
                    for span in &mut spans {
                        span.style = span.style.add_modifier(Modifier::BOLD);
                    }
                }
                wrap(&spans, widths[column], &[], &[])
            })
            .collect();
        let height = cells.iter().map(Vec::len).max().unwrap_or(1);
        for y in 0..height {
            let mut spans = Vec::new();
            for (column, cell) in cells.iter().enumerate() {
                if column > 0 {
                    spans.push(Span::styled(" │ ", rule));
                }
                let line = cell.get(y).cloned().unwrap_or_default();
                let pad = Span::raw(" ".repeat(widths[column].saturating_sub(line.width())));
                if table.alignments.get(column) == Some(&Alignment::Right) {
                    spans.push(pad);
                    spans.extend(line.spans);
                } else {
                    spans.extend(line.spans);
                    if column + 1 < columns {
                        spans.push(pad);
                    }
                }
            }
            lines.push(Line::from(spans));
        }
        if index == 0 {
            let parts: Vec<String> = widths.iter().map(|width| "─".repeat(*width)).collect();
            lines.push(Line::from(Span::styled(parts.join("─┼─"), rule)));
        }
    }
    lines
}

#[derive(Debug, PartialEq)]
pub enum DiffRow {
    Line { sign: char, text: String, old: Option<u64>, new: Option<u64> },
    Gap,
}

/// A stored unified diff as rows with line numbers, without the patch scaffolding, as the desktop's
/// `parseDiffDisplay` reads it.
pub fn parse_diff(diff: &str) -> Vec<DiffRow> {
    let mut rows = Vec::new();
    let (mut old, mut new) = (0, 0);
    // Lines left in the open hunk: a `---`/`+++` line is a file header only outside one.
    let (mut old_left, mut new_left) = (0i64, 0i64);
    for line in diff.split('\n') {
        let in_hunk = old_left > 0 || new_left > 0;
        if !in_hunk && let Some(header) = line.strip_prefix("@@ -") {
            let ranges = header.split(" @@").next().unwrap_or("");
            let mut parts = ranges.split(" +").map(|range| {
                let mut numbers = range.split(',').map(|n| n.parse::<u64>().unwrap_or(0));
                (numbers.next().unwrap_or(0), numbers.next().unwrap_or(1))
            });
            let ((from, from_len), (to, to_len)) =
                (parts.next().unwrap_or((0, 0)), parts.next().unwrap_or((0, 0)));
            (old, new, old_left, new_left) = (from, to, from_len as i64, to_len as i64);
            if !rows.is_empty() {
                rows.push(DiffRow::Gap);
            }
            continue;
        }
        if !in_hunk || line.is_empty() || line.starts_with('\\') {
            continue;
        }
        // By character, not byte: a hunk whose counts are off may start a line mid-text.
        let mut chars = line.chars();
        let sign = chars.next().expect("a non-empty hunk line");
        let (in_old, in_new) = (sign != '+', sign != '-');
        rows.push(DiffRow::Line {
            sign: if in_old && in_new { ' ' } else { sign },
            text: chars.as_str().to_string(),
            old: in_old.then_some(old),
            new: in_new.then_some(new),
        });
        old += in_old as u64;
        new += in_new as u64;
        old_left -= in_old as i64;
        new_left -= in_new as i64;
    }
    rows
}

/// A diff as the desktop draws it: line numbers in the gutter and tinted rows, up to `limit` rows.
pub fn diff(diff: &str, width: usize, limit: usize, theme: &Theme) -> Vec<Line<'static>> {
    let rows = parse_diff(diff);
    let digits = rows
        .iter()
        .filter_map(|row| match row {
            DiffRow::Line { old, new, .. } => old.max(new).map(|n| n.to_string().len()),
            DiffRow::Gap => None,
        })
        .max()
        .unwrap_or(1);
    let mut lines = Vec::new();
    for row in rows.iter().take(limit) {
        let DiffRow::Line { sign, text, old, new } = row else {
            lines.push(Line::from(Span::styled("  ⋯", Style::new().fg(theme.faint))));
            continue;
        };
        let (surface, mark, ink) = match sign {
            '+' => (Style::new().bg(theme.diff_add), theme.green, theme.text),
            '-' => (Style::new().bg(theme.diff_remove), theme.pink, theme.text),
            _ => (Style::new(), theme.dim, theme.dim),
        };
        let number = if *sign == '+' { new } else { old };
        let number = number.map(|n| n.to_string()).unwrap_or_default();
        let gutter = [
            Span::styled(format!("{number:>digits$} "), surface.fg(theme.diff_ln)),
            Span::styled(format!("{sign} "), surface.fg(mark)),
        ];
        let blank = [Span::styled(" ".repeat(digits + 3), surface)];
        let spans = [Span::styled(text.replace('\t', "    "), surface.fg(ink))];
        for line in wrap_hard(&spans, width, &gutter, &blank) {
            lines.push(if *sign == ' ' { line } else { fill(line, width, surface) });
        }
    }
    if rows.len() > limit {
        let more = rows.len() - limit;
        let text = format!("  … {more} more line{}", if more == 1 { "" } else { "s" });
        lines.push(Line::from(Span::styled(text, Style::new().fg(theme.faint))));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::Terminal;

    fn plain(lines: &[Line]) -> Vec<String> {
        let text = |line: &Line| line.spans.iter().map(|s| s.content.as_ref()).collect::<String>();
        lines.iter().map(|line| text(line).trim_end().to_string()).collect()
    }

    fn theme() -> Theme {
        Theme::new("default", Terminal::fixed())
    }

    #[test]
    fn wraps_at_word_boundaries_with_indents() {
        let spans = [Span::raw("the quick brown fox jumps")];
        let lines = wrap(&spans, 12, &[Span::raw("• ")], &[Span::raw("  ")]);
        assert_eq!(plain(&lines), ["• the quick", "  brown fox", "  jumps"]);
    }

    #[test]
    fn breaks_words_longer_than_the_line_and_keeps_wide_graphemes_whole() {
        assert_eq!(plain(&wrap(&[Span::raw("abcdefghij")], 4, &[], &[])), ["abcd", "efgh", "ij"]);
        assert_eq!(plain(&wrap(&[Span::raw("日本語です")], 5, &[], &[])), ["日本", "語で", "す"]);
    }

    #[test]
    fn ends_lines_at_newlines() {
        assert_eq!(plain(&wrap(&[Span::raw("one\ntwo")], 20, &[], &[])), ["one", "two"]);
    }

    #[test]
    fn renders_markdown_blocks() {
        let text = "# Title\n\nSome **bold** text.\n\n- one\n- two\n  1. nested\n\n> quoted\n\n\
                    ```rust\nfn main() {}\n```\n\nAfter.";
        let lines = plain(&markdown(text, 40, &theme()));
        let expected = [
            "Title",
            "",
            "Some bold text.",
            "",
            "• one",
            "• two",
            "  1. nested",
            "",
            "│ quoted",
            "",
            " rust",
            "  fn main() {}",
            "",
            "",
            "After.",
        ];
        assert_eq!(lines, expected);
    }

    #[test]
    fn renders_tables_with_rules() {
        let lines = plain(&markdown("| a | bb |\n|---|---:|\n| ccc | d |", 40, &theme()));
        assert_eq!(lines, ["a   │ bb", "────┼───", "ccc │  d"]);
    }

    #[test]
    fn parses_diffs_into_numbered_rows() {
        let rows =
            parse_diff("--- a\n+++ b\n@@ -3,2 +3,2 @@\n keep\n-old\n+new\n@@ -9 +9 @@\n-x\n");
        let line = |sign, text: &str, old, new| DiffRow::Line { sign, text: text.into(), old, new };
        let expected = [
            line(' ', "keep", Some(3), Some(3)),
            line('-', "old", Some(4), None),
            line('+', "new", None, Some(4)),
            DiffRow::Gap,
            line('-', "x", Some(9), None),
        ];
        assert_eq!(rows, expected);
    }

    #[test]
    fn reads_a_hunk_line_that_starts_mid_character() {
        let rows = parse_diff("@@ -1 +1 @@\né\n");
        let expected = DiffRow::Line { sign: ' ', text: String::new(), old: Some(1), new: Some(1) };
        assert_eq!(rows, [expected]);
    }

    #[test]
    fn caps_long_diffs() {
        let added: String = (0..30).map(|n| format!("+{n}\n")).collect();
        let lines = plain(&diff(&format!("@@ -1,0 +1,30 @@\n{added}"), 40, 12, &theme()));
        assert_eq!(lines.len(), 13);
        assert_eq!(lines[12], "  … 18 more lines");
    }
}
