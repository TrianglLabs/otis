//! The prompt being written: a multi-line buffer with a cursor that moves by grapheme, by word, and
//! by wrapped row, and the prompts sent before it to recall.

use unicode_segmentation::UnicodeSegmentation;

use crate::text::width;

#[derive(Default)]
pub struct Composer {
    text: String,
    /// A byte index on a grapheme boundary.
    cursor: usize,
    history: Vec<String>,
    /// Where in `history` Up has reached, with the draft it left.
    recalled: Option<(usize, String)>,
}

/// The buffer laid out in rows of a width: each row's byte range, and the cursor's row and column.
pub struct Layout {
    pub rows: Vec<(usize, usize)>,
    pub cursor: (usize, usize),
}

impl Composer {
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub fn set(&mut self, text: &str) {
        self.text = text.to_string();
        self.cursor = self.text.len();
        self.recalled = None;
    }

    /// Empties the buffer and returns what it held, remembered for Up.
    pub fn take(&mut self) -> String {
        let text = std::mem::take(&mut self.text);
        self.cursor = 0;
        self.recalled = None;
        if !text.trim().is_empty() && self.history.last() != Some(&text) {
            self.history.push(text.clone());
        }
        text
    }

    /// Seeds history with prompts sent in an earlier run of the session, oldest first.
    pub fn remember(&mut self, prompts: impl IntoIterator<Item = String>) {
        self.history = prompts.into_iter().collect();
    }

    pub fn insert(&mut self, text: &str) {
        // A terminal pastes line breaks as carriage returns.
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        self.text.insert_str(self.cursor, &text);
        self.cursor += text.len();
    }

    fn previous(&self, from: usize) -> usize {
        self.text[..from].grapheme_indices(true).next_back().map_or(0, |(index, _)| index)
    }

    fn next(&self, from: usize) -> usize {
        self.text[from..].graphemes(true).next().map_or(from, |grapheme| from + grapheme.len())
    }

    /// The start of the word before `from`, skipping the whitespace between.
    fn word_start(&self, from: usize) -> usize {
        self.text[..from].trim_end().trim_end_matches(|ch: char| !ch.is_whitespace()).len()
    }

    fn line_start(&self) -> usize {
        self.text[..self.cursor].rfind('\n').map_or(0, |index| index + 1)
    }

    fn line_end(&self) -> usize {
        self.text[self.cursor..].find('\n').map_or(self.text.len(), |index| self.cursor + index)
    }

    pub fn left(&mut self) {
        self.cursor = self.previous(self.cursor);
    }

    pub fn right(&mut self) {
        self.cursor = self.next(self.cursor);
    }

    pub fn word_left(&mut self) {
        self.cursor = self.word_start(self.cursor);
    }

    /// To the end of the word after the cursor, skipping the whitespace before it.
    pub fn word_right(&mut self) {
        let after = &self.text[self.cursor..];
        let rest = after.trim_start().trim_start_matches(|ch: char| !ch.is_whitespace());
        self.cursor += after.len() - rest.len();
    }

    pub fn home(&mut self) {
        self.cursor = self.line_start();
    }

    pub fn end(&mut self) {
        self.cursor = self.line_end();
    }

    pub fn backspace(&mut self) {
        let start = self.previous(self.cursor);
        self.text.replace_range(start..self.cursor, "");
        self.cursor = start;
    }

    pub fn delete(&mut self) {
        let end = self.next(self.cursor);
        self.text.replace_range(self.cursor..end, "");
    }

    pub fn delete_word(&mut self) {
        let start = self.word_start(self.cursor);
        self.text.replace_range(start..self.cursor, "");
        self.cursor = start;
    }

    /// Deletes to the start of the line, or the line break before it when already there.
    pub fn delete_to_start(&mut self) {
        let start = match self.line_start() {
            start if start == self.cursor => self.previous(start),
            start => start,
        };
        self.text.replace_range(start..self.cursor, "");
        self.cursor = start;
    }

    pub fn delete_to_end(&mut self) {
        let end = match self.line_end() {
            end if end == self.cursor => self.next(end),
            end => end,
        };
        self.text.replace_range(self.cursor..end, "");
    }

    /// Moves the cursor a wrapped row up or down at its column; false at the first or last row,
    /// where the arrow recalls history instead.
    pub fn vertical(&mut self, down: bool, width: usize) -> bool {
        let layout = self.layout(width);
        let (row, column) = layout.cursor;
        let target = if down { row + 1 } else { row.wrapping_sub(1) };
        let Some(&(start, end)) = layout.rows.get(target) else {
            return false;
        };
        let mut cursor = start;
        let mut used = 0;
        for (index, grapheme) in self.text[start..end].grapheme_indices(true) {
            let grapheme_width = width_of_grapheme(grapheme);
            if used + grapheme_width > column {
                break;
            }
            used += grapheme_width;
            cursor = start + index + grapheme.len();
        }
        self.cursor = cursor;
        true
    }

    /// Steps back (`older`) or forward through sent prompts; the draft returns past the newest.
    pub fn recall(&mut self, older: bool) {
        let next = match (&self.recalled, older) {
            (None, true) if !self.history.is_empty() => Some(self.history.len() - 1),
            (Some((index, _)), true) => Some(index.saturating_sub(1)),
            (Some((index, _)), false) if index + 1 < self.history.len() => Some(index + 1),
            _ => None,
        };
        match next {
            Some(index) => {
                let draft = match self.recalled.take() {
                    Some((_, draft)) => draft,
                    None => std::mem::take(&mut self.text),
                };
                self.text = self.history[index].clone();
                self.recalled = Some((index, draft));
            }
            None => {
                if let Some((_, draft)) = self.recalled.take() {
                    self.text = draft;
                }
            }
        }
        self.cursor = self.text.len();
    }

    /// Rows of at most `width` columns, broken at line breaks and, within a line, at the last space
    /// that fits; the cursor sits after the grapheme it follows.
    pub fn layout(&self, width: usize) -> Layout {
        let width = width.max(2);
        let mut rows = Vec::new();
        let mut cursor = (0, 0);
        let mut line_start = 0;
        for line in self.text.split('\n') {
            let mut row_start = line_start;
            let mut used = 0;
            let mut last_space: Option<(usize, usize)> = None;
            for (offset, grapheme) in line.grapheme_indices(true) {
                let index = line_start + offset;
                let grapheme_width = width_of_grapheme(grapheme);
                // Room is kept for the cursor after a row's last grapheme; one space may hang.
                let hangs = grapheme == " " && used < width;
                if used > 0 && used + grapheme_width >= width && !hangs {
                    let (break_at, carried) = match last_space {
                        Some((after, used_after)) if after > row_start => {
                            (after, used - used_after)
                        }
                        _ => (index, 0),
                    };
                    rows.push((row_start, break_at));
                    row_start = break_at;
                    used = carried;
                    last_space = None;
                }
                used += grapheme_width;
                if grapheme == " " {
                    last_space = Some((index + 1, used));
                }
            }
            rows.push((row_start, line_start + line.len()));
            line_start += line.len() + 1;
        }
        for (row, &(start, end)) in rows.iter().enumerate() {
            let last = row + 1 == rows.len() || rows[row + 1].0 != end;
            if self.cursor >= start && (self.cursor < end || (self.cursor == end && last)) {
                let before = self.text[start..self.cursor].graphemes(true);
                cursor = (row, before.map(width_of_grapheme).sum());
                break;
            }
        }
        Layout { rows, cursor }
    }
}

fn width_of_grapheme(grapheme: &str) -> usize {
    if grapheme == "\t" { 4 } else { width(grapheme) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn composer(text: &str) -> Composer {
        let mut composer = Composer::default();
        composer.insert(text);
        composer
    }

    #[test]
    fn edits_by_grapheme() {
        let mut c = composer("héllo👋🏽");
        c.backspace();
        assert_eq!(c.text(), "héllo");
        c.home();
        c.right();
        c.right();
        c.backspace();
        assert_eq!(c.text(), "hllo");
    }

    #[test]
    fn moves_and_deletes_by_word() {
        let mut c = composer("one two  three");
        c.delete_word();
        assert_eq!(c.text(), "one two  ");
        c.word_left();
        c.word_left();
        c.insert("_");
        assert_eq!(c.text(), "_one two  ");
        c.word_right();
        c.delete_to_end();
        assert_eq!(c.text(), "_one");
    }

    #[test]
    fn lays_out_rows_at_spaces_and_line_breaks() {
        let c = composer("hello world again\nnext");
        let layout = c.layout(12);
        let rows: Vec<&str> = layout.rows.iter().map(|&(s, e)| &c.text()[s..e]).collect();
        assert_eq!(rows, ["hello world ", "again", "next"]);
        assert_eq!(layout.cursor, (2, 4));
    }

    #[test]
    fn moves_between_rows_and_reports_the_edges() {
        let mut c = composer("abc\ndefgh");
        assert!(c.vertical(false, 20));
        assert_eq!(c.cursor, 3);
        assert!(!c.vertical(false, 20));
        assert!(c.vertical(true, 20));
        assert_eq!(c.cursor, 7);
    }

    #[test]
    fn recalls_history_and_returns_to_the_draft() {
        let mut c = Composer::default();
        c.remember(["first".to_string(), "second".to_string()]);
        c.insert("draft");
        c.recall(true);
        assert_eq!(c.text(), "second");
        c.recall(true);
        assert_eq!(c.text(), "first");
        c.recall(false);
        c.recall(false);
        assert_eq!(c.text(), "draft");
    }

    #[test]
    fn normalizes_pasted_line_breaks() {
        assert_eq!(composer("a\r\nb\rc").text(), "a\nb\nc");
    }

    #[test]
    fn counts_a_tab_as_four_columns_for_the_cursor() {
        assert_eq!(composer("\tx").layout(20).cursor, (0, 5));
    }

    #[test]
    fn wraps_a_run_of_spaces_rather_than_overflowing() {
        let c = composer("ab        cd");
        let layout = c.layout(6);
        assert!(layout.rows.iter().all(|&(s, e)| width(&c.text()[s..e]) <= 6));
    }
}
