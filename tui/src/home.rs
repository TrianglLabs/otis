//! The home screen: the Otis mark in braille beside the name, folder, and model, the usage the
//! desktop's home card shows, and the last weeks of activity.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::protocol::{Day, Stats};
use crate::text::{lead, width};
use crate::theme::{Theme, Tone};
use crate::transcript::{MARGIN, margin};

/// The mark as dot art: the desktop cube of three faces, 3×3 tiles each, with the O cut from the
/// front face. Tiles are `TILE` dots wide with `GAP`-dot gaps, so a face spans `FACE` dots and the
/// cube is twice that plus a gap.
const TILE: usize = 5;
const GAP: usize = 2;
const FACE: usize = 3 * TILE + 2 * GAP;
const SIZE: usize = 2 * FACE + GAP;
const MARK_COLUMNS: usize = SIZE / 2;
/// Columns between the mark and what stands beside it.
const GUTTER: usize = 4;
/// How far the mark fades into the page from its top row to its bottom.
const MARK_FADE: f32 = 0.35;
/// Braille dot bits by row and column within a cell.
const BRAILLE: [[u32; 2]; 4] = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

/// The most days the activity chart shows, each a one-cell bar with a one-cell gap, and the
/// fewest worth showing.
const DAYS: usize = 28;
const MIN_DAYS: usize = 14;
const CHART_ROWS: usize = 3;
/// Bar heights in eighths of a row; the tallest leaves one eighth of air.
const PEAK: f64 = (CHART_ROWS * 8 - 1) as f64;
const CHART_FADE: f32 = 0.45;
const EIGHTHS: [&str; 9] = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/// How long each figure counts up, and how far apart they start.
const COUNT_MS: f64 = 900.0;
const STAGGER_MS: f64 = 70.0;
const LABELS: [&str; 4] = ["day streak", "total tokens", "tokens/session", "time/session"];
/// The labels where the full ones do not fit beside the mark.
const SHORT_LABELS: [&str; 4] = ["day streak", "tokens", "per session", "avg session"];

/// One tone per dot, or none. The top rhombus is 2:1 isometric, tested in doubled coordinates to
/// keep its diagonals even; the side faces hang one gap below its edges.
fn mark_dots() -> [[Option<Tone>; SIZE]; SIZE] {
    let pitch = (TILE + GAP) as f64;
    let face = FACE as f64;
    let centre = face + GAP as f64 / 2.0 - 0.5;
    let in_tile = |u: f64, v: f64, scale: f64| {
        u >= 0.0
            && v >= 0.0
            && u < face * scale
            && v < face * scale
            && u % (pitch * scale) < TILE as f64 * scale
            && v % (pitch * scale) < TILE as f64 * scale
    };
    let mut dots = [[None; SIZE]; SIZE];
    for x in 0..SIZE {
        let dx = x as f64 - centre;
        for (dy, row) in dots.iter_mut().enumerate().take(FACE) {
            let doubled = 2.0 * dy as f64;
            if in_tile(dx + doubled, doubled - dx, 2.0) {
                row[x] = Some(Tone::Top);
            }
        }
        let left = x < FACE;
        if !left && x < FACE + GAP {
            continue;
        }
        let u = if left { x } else { x - FACE - GAP };
        let top = (face - dx.abs() / 2.0).ceil() as usize + GAP;
        for v in 0..FACE {
            let hole = !left && u / (TILE + GAP) == 1 && v / (TILE + GAP) == 1;
            if in_tile(u as f64, v as f64, 1.0) && !hole && top + v < SIZE {
                dots[top + v][x] = Some(if left { Tone::Left } else { Tone::Accent });
            }
        }
    }
    dots
}

/// The mark in braille: each cell carries a 2×4 patch of dots in the tone that owns most of them,
/// fading a little into the page down the cube.
fn mark(theme: &Theme) -> Vec<Line<'static>> {
    let dots = mark_dots();
    let rows = SIZE / 4;
    (0..rows)
        .map(|row| {
            let fade = MARK_FADE * row as f32 / (rows - 1) as f32;
            let cells = (0..MARK_COLUMNS).map(|column| {
                let mut code = 0;
                let mut counts = [(Tone::Top, 0), (Tone::Left, 0), (Tone::Accent, 0)];
                for (y, bits) in BRAILLE.iter().enumerate() {
                    for (x, bit) in bits.iter().enumerate() {
                        let Some(tone) = dots[row * 4 + y][column * 2 + x] else {
                            continue;
                        };
                        code |= bit;
                        counts.iter_mut().find(|(t, _)| *t == tone).expect("a tone").1 += 1;
                    }
                }
                // The first tone with the most dots, as the desktop breaks ties.
                let tone =
                    counts.iter().fold(counts[0], |best, c| if c.1 > best.1 { *c } else { best }).0;
                match char::from_u32(0x2800 + code) {
                    Some(glyph) if code > 0 => {
                        Span::styled(glyph.to_string(), Style::new().fg(theme.shade(tone, fade)))
                    }
                    _ => Span::raw(" "),
                }
            });
            Line::from(cells.collect::<Vec<_>>())
        })
        .collect()
}

/// How far a part that starts `delay` into the count has grown, easing out, and 1 at rest.
fn grown(elapsed: Option<f64>, delay: f64) -> f64 {
    let amount = |elapsed: f64| ((elapsed - delay) / COUNT_MS).clamp(0.0, 1.0);
    elapsed.map_or(1.0, |elapsed| 1.0 - (1.0 - amount(elapsed)).powi(3))
}

/// Whether the figures are still counting up `elapsed` after they arrived.
pub fn counting(elapsed: f64) -> bool {
    elapsed < STAGGER_MS * (LABELS.len() - 1) as f64 + COUNT_MS
}

fn tokens(count: f64) -> String {
    match count {
        c if c >= 1e9 => format!("{:.1}B", c / 1e9),
        c if c >= 1e6 => format!("{:.1}M", c / 1e6),
        c if c >= 1e3 => format!("{:.0}K", c / 1e3),
        c => format!("{c:.0}"),
    }
}

fn duration(seconds: f64) -> String {
    match seconds {
        s if s >= 3600.0 => format!("{:.1}h", s / 3600.0),
        s if s >= 60.0 => format!("{:.0}m", s / 60.0),
        s => format!("{s:.0}s"),
    }
}

fn short_date(date: &str) -> String {
    const MONTHS: [&str; 12] =
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let mut parts = date.split('-').skip(1).map(|part| part.parse::<usize>().unwrap_or(0));
    let (month, day) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    match MONTHS.get(month.wrapping_sub(1)) {
        Some(name) => format!("{name} {day}"),
        None => date.to_string(),
    }
}

fn centered(text: &str, columns: usize, style: Style) -> Span<'static> {
    let room = columns.saturating_sub(width(text));
    let left = room / 2;
    Span::styled(format!("{}{text}{}", " ".repeat(left), " ".repeat(room - left)), style)
}

/// The four figures over their labels, divided by hairlines; each column as wide as its widest
/// final text, so counting never shifts them.
/// Across one row where `room` allows, with the full labels if they fit, else as two rows of two.
fn figures(
    stats: Option<&Stats>,
    elapsed: Option<f64>,
    room: usize,
    theme: &Theme,
) -> Vec<Line<'static>> {
    let values = |amount: [f64; 4]| -> [String; 4] {
        match stats {
            None => ["–", "–", "–", "–"].map(String::from),
            Some(s) => [
                format!("{:.0}", s.streak * amount[0]),
                tokens((s.total_tokens * amount[1]).round()),
                tokens((s.avg_tokens_per_session * amount[2]).round()),
                duration(s.avg_session_seconds * amount[3]),
            ],
        }
    };
    let finals = values([1.0; 4]);
    let shown = values(std::array::from_fn(|i| grown(elapsed, STAGGER_MS * i as f64)));
    let value_style = match stats {
        Some(_) => Style::new().fg(theme.accent).add_modifier(Modifier::BOLD),
        None => Style::new().fg(theme.faint),
    };
    let divider = Span::styled(" │ ", Style::new().fg(theme.border));
    // Values over labels for the figures at `indices`, in columns of the given widths.
    let rows = |indices: &[usize], columns: &[usize], labels: &[&str; 4]| {
        let (mut top, mut bottom) = (Vec::new(), Vec::new());
        for (position, (&index, &columns)) in indices.iter().zip(columns).enumerate() {
            if position > 0 {
                top.push(divider.clone());
                bottom.push(divider.clone());
            }
            top.push(centered(&shown[index], columns, value_style));
            bottom.push(centered(labels[index], columns, Style::new().fg(theme.dim)));
        }
        [Line::from(top), Line::from(bottom)]
    };
    let column = |index: usize, labels: &[&str; 4]| width(&finals[index]).max(width(labels[index]));
    for labels in [&LABELS, &SHORT_LABELS] {
        let columns: Vec<usize> = (0..4).map(|index| column(index, labels)).collect();
        if columns.iter().sum::<usize>() + 9 <= room {
            return rows(&[0, 1, 2, 3], &columns, labels).to_vec();
        }
    }
    let columns: Vec<usize> =
        (0..2).map(|c| column(c, &SHORT_LABELS).max(column(c + 2, &SHORT_LABELS))).collect();
    let [first, second] = [[0, 1], [2, 3]].map(|pair| rows(&pair, &columns, &SHORT_LABELS));
    [first.to_vec(), vec![Line::default()], second.to_vec()].concat()
}

/// The last `count` days of tokens as bars, right-aligned so a short history leaves empty days on
/// the left, where a baseline stub stands in, and a caption with the dates and today's tokens. A
/// braille cell carries one color, so each bar fades down from its top.
fn chart(
    stats: Option<&Stats>,
    count: usize,
    elapsed: Option<f64>,
    theme: &Theme,
) -> Vec<Line<'static>> {
    let history: &[Day] = stats.map_or(&[], |stats| &stats.recent_activity);
    let days = &history[history.len().saturating_sub(count)..];
    let counts: Vec<f64> = (0..count)
        .map(|day| (day + days.len()).checked_sub(count).map_or(0.0, |index| days[index].tokens))
        .collect();
    let peak = counts.iter().copied().fold(1.0, f64::max);
    let last_start = STAGGER_MS * (LABELS.len() - 1) as f64;
    let heights: Vec<usize> = counts
        .iter()
        .enumerate()
        .map(|(day, tokens)| {
            let growth = grown(elapsed, last_start * day as f64 / (count - 1) as f64);
            if *tokens > 0.0 {
                ((PEAK * tokens * growth / peak).round() as usize).max(1)
            } else {
                1
            }
        })
        .collect();
    let mut lines: Vec<Line<'static>> = (0..CHART_ROWS)
        .map(|row| {
            let mut spans = Vec::new();
            for (day, height) in heights.iter().enumerate() {
                let fill = height.saturating_sub((CHART_ROWS - 1 - row) * 8).min(8);
                let depth = row as f32 - ((CHART_ROWS * 8 - height) / 8) as f32;
                let color = match counts[day] > 0.0 {
                    true => theme.shade(Tone::Accent, CHART_FADE * depth / 2.0),
                    false => theme.border,
                };
                spans.push(Span::styled(EIGHTHS[fill], Style::new().fg(color)));
                if day + 1 < count {
                    spans.push(Span::raw(" "));
                }
            }
            Line::from(spans)
        })
        .collect();
    let (range, today) = match stats {
        Some(stats) => {
            let range = match (days.first(), days.last()) {
                (Some(first), Some(last)) => {
                    format!("{} – {}", short_date(&first.date), short_date(&last.date))
                }
                _ => String::new(),
            };
            (range, format!("today {}", tokens(stats.today_tokens)))
        }
        None => ("Reading your history…".to_string(), String::new()),
    };
    let gap = (count * 2 - 1).saturating_sub(width(&range) + width(&today));
    lines.push(Line::from(vec![
        Span::styled(range, Style::new().fg(theme.faint)),
        Span::raw(" ".repeat(gap)),
        Span::styled(today, Style::new().fg(theme.faint)),
    ]));
    lines
}

pub struct Home<'a> {
    pub theme: &'a Theme,
    pub width: usize,
    /// The rows the home screen may take; parts are left out to stay within them.
    pub rows: usize,
    pub version: &'a str,
    pub folder: String,
    /// The model's name and its provider's, or none before one is chosen.
    pub model: Option<(String, String)>,
    pub stats: Option<&'a Stats>,
    /// Milliseconds since the figures arrived while they count up; none at rest.
    pub elapsed: Option<f64>,
}

/// The home screen's lines: the mark beside the rest where it fits, else above it. Where rows run
/// short the chart goes first, then the mark, so nothing is ever cut off at the top.
pub fn render(home: &Home) -> Vec<Line<'static>> {
    let attempts = [(true, true), (true, false), (false, false)];
    let mut lines = Vec::new();
    for (with_mark, with_chart) in attempts {
        lines = compose(home, with_mark, with_chart);
        if lines.len() <= home.rows {
            break;
        }
    }
    lines
}

fn compose(home: &Home, with_mark: bool, with_chart: bool) -> Vec<Line<'static>> {
    let theme = home.theme;
    let inner = home.width.saturating_sub(2 * MARGIN);
    let short_width = SHORT_LABELS.iter().map(|l| width(l)).sum::<usize>() + 9;
    let beside = with_mark && inner >= MARK_COLUMNS + GUTTER + short_width;
    let room = if beside { inner - MARK_COLUMNS - GUTTER } else { inner };
    let mut info = vec![
        Line::from(vec![
            Span::styled("Otis", Style::new().fg(theme.text).add_modifier(Modifier::BOLD)),
            Span::styled(format!("  {}", home.version), Style::new().fg(theme.faint)),
        ]),
        Line::from(Span::styled(home.folder.clone(), Style::new().fg(theme.dim))),
        match &home.model {
            Some((model, provider)) => Line::from(vec![
                Span::styled(model.clone(), Style::new().fg(theme.text)),
                Span::styled(format!(" · {provider}"), Style::new().fg(theme.faint)),
            ]),
            None => Line::from(Span::styled(
                "No model yet · /model to choose one",
                Style::new().fg(theme.orange),
            )),
        },
        Line::default(),
    ];
    info.extend(figures(home.stats, home.elapsed, room, theme));
    let days = room.div_ceil(2).min(DAYS);
    if with_chart && days >= MIN_DAYS {
        info.push(Line::default());
        info.extend(chart(home.stats, days, home.elapsed, theme));
    }
    let mut lines = vec![Line::default()];
    if !beside {
        if with_mark {
            lines.extend(mark(theme).into_iter().map(|line| lead(&[margin()], line)));
            lines.push(Line::default());
        }
        lines.extend(info.into_iter().map(|line| lead(&[margin()], line)));
        return lines;
    }
    // Shorter text sits centered against the mark.
    let mark = mark(theme);
    let offset = mark.len().saturating_sub(info.len()) / 2;
    for row in 0..mark.len().max(info.len() + offset) {
        let mut spans = vec![margin()];
        match mark.get(row) {
            Some(line) => spans.extend(line.spans.clone()),
            None => spans.push(Span::raw(" ".repeat(MARK_COLUMNS))),
        }
        if let Some(line) = row.checked_sub(offset).and_then(|row| info.get(row)) {
            spans.push(Span::raw(" ".repeat(GUTTER)));
            spans.extend(line.spans.clone());
        }
        lines.push(Line::from(spans));
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

    fn stats() -> Stats {
        Stats {
            streak: 12.0,
            total_tokens: 4_200_000.0,
            avg_tokens_per_session: 38_000.0,
            avg_session_seconds: 840.0,
            today_tokens: 120_000.0,
            recent_activity: vec![
                Day { date: "2026-11-27".into(), tokens: 50.0 },
                Day { date: "2026-11-28".into(), tokens: 100.0 },
            ],
        }
    }

    fn home<'a>(theme: &'a Theme, stats: &'a Stats, width: usize, rows: usize) -> Home<'a> {
        Home {
            theme,
            width,
            rows,
            version: "0.3.4",
            folder: "~/otis".into(),
            model: Some(("Gemini 4 Neon".into(), "OpenRouter".into())),
            stats: Some(stats),
            elapsed: None,
        }
    }

    #[test]
    fn draws_the_cube_with_the_o_cut_from_its_front_face() {
        let dots = mark_dots();
        let x = FACE + GAP + TILE + GAP + TILE / 2;
        let accent: Vec<usize> = (0..SIZE).filter(|&y| dots[y][x] == Some(Tone::Accent)).collect();
        let (first, last) = (accent[0], *accent.last().unwrap());
        assert!((first..=last).any(|y| dots[y][x].is_none()), "the O leaves a hole");
        assert!(dots.iter().flatten().any(|d| *d == Some(Tone::Top)));
        assert!(dots.iter().flatten().any(|d| *d == Some(Tone::Left)));
    }

    #[test]
    fn renders_the_mark_as_ten_rows_of_braille() {
        let theme = Theme::new("default", Terminal::fixed());
        let lines = mark(&theme);
        assert_eq!(lines.len(), 10);
        assert!(lines.iter().all(|line| line.width() == MARK_COLUMNS));
    }

    #[test]
    fn sets_the_mark_beside_the_figures_and_chart_when_wide() {
        let (theme, stats) = (Theme::new("default", Terminal::fixed()), stats());
        let lines = plain(&render(&home(&theme, &stats, 100, 40)));
        assert!(lines.iter().any(|l| l.ends_with("    Otis  0.3.4")));
        assert!(
            lines.iter().any(|l| l.contains("12     │     4.2M     │      38K       │     14m"))
        );
        assert!(lines.iter().any(|l| l.contains("Nov 27 – Nov 28") && l.ends_with("today 120K")));
    }

    #[test]
    fn keeps_the_mark_beside_with_short_labels_and_fewer_days() {
        let (theme, stats) = (Theme::new("default", Terminal::fixed()), stats());
        let lines = plain(&render(&home(&theme, &stats, 78, 40)));
        assert!(lines.iter().any(|l| l.ends_with("    Otis  0.3.4")));
        assert!(lines.iter().any(|l| l.contains("per session")));
        assert!(lines.iter().any(|l| l.ends_with("today 120K")));
    }

    #[test]
    fn leaves_out_the_chart_then_the_mark_when_rows_run_short() {
        let (theme, stats) = (Theme::new("default", Terminal::fixed()), stats());
        let roomy = render(&home(&theme, &stats, 100, 40)).len();
        let without_chart = plain(&render(&home(&theme, &stats, 100, 11)));
        assert!(without_chart.len() < roomy);
        assert!(!without_chart.iter().any(|l| l.contains("today")));
        assert!(without_chart.iter().any(|l| l.contains('⣿')));
        let text_only = plain(&render(&home(&theme, &stats, 100, 8)));
        assert_eq!(text_only[1], "  Otis  0.3.4");
    }

    #[test]
    fn counts_figures_up_from_zero() {
        let theme = Theme::new("default", Terminal::fixed());
        let stats = Stats { streak: 10.0, ..Stats::default() };
        let lines = figures(Some(&stats), Some(0.0), 100, &theme);
        assert!(plain(&lines[..1]).concat().trim_start().starts_with('0'));
        assert!(counting(500.0));
        assert!(!counting(2000.0));
    }

    #[test]
    fn stacks_the_figures_two_by_two_where_one_row_will_not_fit() {
        let (theme, stats) = (Theme::new("default", Terminal::fixed()), stats());
        let lines = plain(&figures(Some(&stats), None, 40, &theme));
        assert_eq!(lines.len(), 5);
        assert!(lines.iter().all(|line| width(line) <= 40));
        assert!(lines[1].contains("day streak") && lines[4].contains("avg session"));
    }
}
