//! Drawing inline, in the terminal's normal screen below the shell prompt: finished lines are
//! printed into the scrollback, where the terminal keeps them for scrolling, selecting, and
//! copying, and a live region under them is redrawn in place. Only lines that changed are
//! rewritten, since a terminal drops a selection whose cells are written over.

use std::io::{self, Stdout, Write};

use crossterm::cursor::{Hide, MoveToColumn, MoveUp, Show};
use crossterm::style::{
    Attribute, Color as Ansi, Print, ResetColor, SetAttribute, SetBackgroundColor,
    SetForegroundColor,
};
use crossterm::terminal::{BeginSynchronizedUpdate, Clear, ClearType, EndSynchronizedUpdate};
use crossterm::{QueueableCommand, queue};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Line;
use unicode_width::UnicodeWidthStr;

pub struct Screen {
    out: Stdout,
    /// The live region as last drawn, and the cursor shown in it.
    frame: Vec<Line<'static>>,
    shown: Option<(u16, u16)>,
    /// Where the cursor was left in the live region: its row and column.
    cursor: (u16, u16),
}

impl Screen {
    pub fn new() -> Self {
        Self { out: io::stdout(), frame: Vec::new(), shown: None, cursor: (0, 0) }
    }

    /// Prints `scroll` into the scrollback above the live region, then redraws the region, at most
    /// `rows` tall, with the cursor shown at `cursor` or hidden. Lines must already fit `width`.
    /// An empty region with nothing to print clears what the last frame left.
    pub fn draw(
        &mut self,
        scroll: &[Line<'static>],
        live: &[Line<'static>],
        cursor: Option<(u16, u16)>,
        width: u16,
        rows: u16,
    ) -> io::Result<()> {
        let skip = live.len().saturating_sub(rows as usize);
        let live = &live[skip..];
        let cursor = cursor.and_then(|(x, y)| Some((x, y.checked_sub(skip as u16)?)));
        if scroll.is_empty() && live == self.frame && cursor == self.shown {
            return Ok(());
        }
        queue!(self.out, BeginSynchronizedUpdate, Hide)?;
        if self.cursor.0 > 0 {
            self.out.queue(MoveUp(self.cursor.0))?;
        }
        self.out.queue(MoveToColumn(0))?;
        if !scroll.is_empty() || live.is_empty() {
            self.out.queue(Clear(ClearType::FromCursorDown))?;
            self.frame.clear();
        }
        for line in scroll {
            self.line(line, width)?;
            self.out.queue(Print("\r\n"))?;
        }
        // Rows that already show their line are stepped over, not written.
        for (index, line) in live.iter().enumerate() {
            if index > 0 {
                self.out.queue(Print("\r\n"))?;
            }
            if self.frame.get(index) != Some(line) {
                self.line(line, width)?;
            }
        }
        // The rows a taller frame left below are cleared from the row after the last.
        if !live.is_empty() && live.len() < self.frame.len() {
            queue!(self.out, Print("\r\n"), Clear(ClearType::FromCursorDown), MoveUp(1))?;
        }
        let last = live.len().saturating_sub(1) as u16;
        self.out.queue(MoveToColumn(0))?;
        self.cursor = match cursor {
            Some((x, y)) => {
                if last > y {
                    self.out.queue(MoveUp(last - y))?;
                }
                queue!(self.out, MoveToColumn(x), Show)?;
                (y, x)
            }
            None => (last, 0),
        };
        self.frame = live.to_vec();
        self.shown = cursor;
        queue!(self.out, EndSynchronizedUpdate)?;
        self.out.flush()
    }

    /// A resize may have reflowed the live region: lines wider than the new width now take more
    /// rows. Clears from where the region's top moved to, so the next draw starts clean.
    pub fn resized(&mut self, width: u16) -> io::Result<()> {
        let width = width.max(1);
        let rows = |line: &Line| (line.width() as u16).div_ceil(width).max(1);
        let above: u16 = self.frame.iter().take(self.cursor.0 as usize).map(rows).sum::<u16>()
            + self.cursor.1 / width;
        queue!(self.out, MoveToColumn(0))?;
        if above > 0 {
            self.out.queue(MoveUp(above))?;
        }
        self.out.queue(Clear(ClearType::FromCursorDown))?;
        self.frame.clear();
        self.shown = None;
        self.cursor = (0, 0);
        self.out.flush()
    }

    /// Writes one line's cells with their styles. Trailing blank cells are left to the clear, so a
    /// line never writes into the last column, where the cursor would stay and erase it.
    fn line(&mut self, line: &Line, width: u16) -> io::Result<()> {
        let mut buffer = Buffer::empty(Rect::new(0, 0, width, 1));
        buffer.set_line(0, 0, line, width);
        let cells = buffer.content();
        let end = cells
            .iter()
            .rposition(|cell| {
                cell.symbol() != " "
                    || cell.bg != Color::Reset
                    || cell.modifier.contains(Modifier::UNDERLINED)
            })
            .map_or(0, |index| index + 1);
        let mut current = Style::reset();
        let mut skip = 0;
        for cell in &cells[..end] {
            if skip > 0 {
                skip -= 1;
                continue;
            }
            let style = Style::new().fg(cell.fg).bg(cell.bg).add_modifier(cell.modifier);
            if style != current {
                current = style;
                queue!(self.out, SetAttribute(Attribute::Reset), ResetColor)?;
                if cell.fg != Color::Reset {
                    self.out.queue(SetForegroundColor(ansi(cell.fg)))?;
                }
                if cell.bg != Color::Reset {
                    self.out.queue(SetBackgroundColor(ansi(cell.bg)))?;
                }
                for (flag, attribute) in [
                    (Modifier::BOLD, Attribute::Bold),
                    (Modifier::DIM, Attribute::Dim),
                    (Modifier::ITALIC, Attribute::Italic),
                    (Modifier::UNDERLINED, Attribute::Underlined),
                    (Modifier::CROSSED_OUT, Attribute::CrossedOut),
                    (Modifier::REVERSED, Attribute::Reverse),
                ] {
                    if cell.modifier.contains(flag) {
                        self.out.queue(SetAttribute(attribute))?;
                    }
                }
            }
            self.out.queue(Print(cell.symbol()))?;
            skip = cell.symbol().width().saturating_sub(1);
        }
        queue!(self.out, SetAttribute(Attribute::Reset), ResetColor)?;
        if (end as u16) < width {
            self.out.queue(Clear(ClearType::UntilNewLine))?;
        }
        Ok(())
    }
}

/// Otis draws only in its theme's colors, which are exact or, without 24-bit color, indexed.
fn ansi(color: Color) -> Ansi {
    match color {
        Color::Rgb(r, g, b) => Ansi::Rgb { r, g, b },
        Color::Indexed(index) => Ansi::AnsiValue(index),
        _ => Ansi::Reset,
    }
}
