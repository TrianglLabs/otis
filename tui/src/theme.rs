//! The desktop palettes (src/desktop/renderer/styles/tokens.css and themes.css) in a terminal. A
//! terminal that answers color queries takes the theme's page and ink as its own colors while Otis
//! runs, scrollback included, and gets its own back on exit. One that does not keep its background:
//! surfaces are mixed from it the way the desktop mixes them from its page, and a theme whose
//! lightness it does not share gives way to the default of its kind.

use std::time::Duration;

use ratatui::style::Color;

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    const fn hex(value: u32) -> Self {
        Self((value >> 16) as u8, (value >> 8) as u8, value as u8)
    }

    /// `color-mix(in srgb, self, other t)`: `t` of the way from this color to the other.
    fn mix(self, other: Self, t: f32) -> Self {
        let channel = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t).round() as u8;
        Self(channel(self.0, other.0), channel(self.1, other.1), channel(self.2, other.2))
    }

    fn dark(self) -> bool {
        let luminance = 0.2126 * self.0 as f32 + 0.7152 * self.1 as f32 + 0.0722 * self.2 as f32;
        luminance < 127.5
    }
}

struct Palette {
    bg: Rgb,
    elev: Rgb,
    accent: Rgb,
    text: Rgb,
    dim: Rgb,
    cyan: Rgb,
    green: Rgb,
    orange: Rgb,
    pink: Rgb,
    diff_add: Rgb,
    diff_remove: Rgb,
    diff_ln: Rgb,
}

/// A palette from its tokens in this order: bg, bg-elev, accent, text, text-dim, cyan, green,
/// orange, pink, diff-add-bg, diff-remove-bg, diff-ln.
const fn palette(tokens: [u32; 12]) -> Palette {
    Palette {
        bg: Rgb::hex(tokens[0]),
        elev: Rgb::hex(tokens[1]),
        accent: Rgb::hex(tokens[2]),
        text: Rgb::hex(tokens[3]),
        dim: Rgb::hex(tokens[4]),
        cyan: Rgb::hex(tokens[5]),
        green: Rgb::hex(tokens[6]),
        orange: Rgb::hex(tokens[7]),
        pink: Rgb::hex(tokens[8]),
        diff_add: Rgb::hex(tokens[9]),
        diff_remove: Rgb::hex(tokens[10]),
        diff_ln: Rgb::hex(tokens[11]),
    }
}

const DEFAULT: Palette = palette([
    0x1a1a1c, 0x242427, 0x8b7cff, 0xededef, 0x8e8e9f, 0x7dd3fc, 0xa7f3d0, 0xfdba74, 0xfda4af,
    0x1a2e22, 0x2e1a20, 0x56565c,
]);
const PEARL: Palette = palette([
    0xf5f5f7, 0xffffff, 0x0066cc, 0x1d1d1f, 0x626267, 0x006f85, 0x287447, 0x955800, 0xb93250,
    0xe5f1e8, 0xfbe8e7, 0x707077,
]);

fn named(theme: &str) -> &'static Palette {
    const NORD: Palette = palette([
        0x252525, 0x343434, 0xb8a1ff, 0xf0f0f0, 0xa0a0a0, 0x8ddbff, 0xb8f5d0, 0xffd09a, 0xffb0b8,
        0x263a2c, 0x402a2e, 0x777777,
    ]);
    const BRIGHT: Palette = palette([
        0xd8d8d6, 0xcececa, 0x44318d, 0x292532, 0x4f4a59, 0x334b7b, 0x326247, 0x7a4900, 0x8d3151,
        0xc2d8cc, 0xe0c8cd, 0x707070,
    ]);
    const MATRIX: Palette = palette([
        0x0d0d0d, 0x1b1b1b, 0x00ff66, 0x00ff41, 0x4d7a52, 0x5dff8c, 0x7dffa0, 0xa8ffb8, 0x36e05a,
        0x102a18, 0x2a1414, 0x4d7a52,
    ]);
    const MIDNIGHT: Palette = palette([
        0x0b1020, 0x111827, 0xa78bfa, 0xe5e7eb, 0x7c879e, 0x67e8f9, 0x6ee7b7, 0xfdba74, 0xf9a8d4,
        0x0d2a24, 0x2a1421, 0x526078,
    ]);
    const GRAPHITE: Palette = palette([
        0x09090b, 0x111113, 0xe4e4e7, 0xe7e7ea, 0x92929b, 0xa5d8e8, 0xa7d7b5, 0xd6b07a, 0xd6a1b8,
        0x132019, 0x241518, 0x66666f,
    ]);
    const BEIGE: Palette = palette([
        0xeae3ce, 0xddd3b6, 0x8a4b1f, 0x33291d, 0x8a7a5c, 0x3f6e66, 0x667b2f, 0xa05e10, 0x9e4f5e,
        0xcdd8ac, 0xe3c4b4, 0xa89a76,
    ]);
    const VICE: Palette = palette([
        0x1b1035, 0x2a1b4a, 0xff6ec7, 0xede6f7, 0x8f7fb8, 0x4dd8e8, 0x7bf1a8, 0xffb86b, 0xff7eb6,
        0x1f3d33, 0x4a1e3d, 0x6b5a94,
    ]);
    const EAGAN: Palette = palette([
        0x010a13, 0x0a1e28, 0x1eefff, 0xabffe9, 0x4e7e7c, 0x05c3a8, 0x8fe3b4, 0xf0a868, 0xdf81d5,
        0x0b2e24, 0x2e1524, 0x2e5e58,
    ]);
    const EMBER: Palette = palette([
        0x110f0e, 0x1c1a19, 0xff9a3c, 0xf1e9e1, 0x9b918a, 0x6cc7d1, 0x9bcb7a, 0xff7a2e, 0xf27c8a,
        0x1e2b1f, 0x3a1c19, 0x6b625b,
    ]);
    const TITANIUM: Palette = palette([
        0x1c1d20, 0x282a2e, 0x8cb9f2, 0xecedef, 0xa1a4ab, 0x89cbd1, 0x9dcca7, 0xe1b17b, 0xe7a2ad,
        0x22392c, 0x40282c, 0x92969e,
    ]);
    const PORCELAIN: Palette = palette([
        0xffffff, 0xf5f5f7, 0x000000, 0x1d1d1f, 0x6e6e73, 0x0071a4, 0x1e7a34, 0xc93400, 0xd30f45,
        0xe8f5ec, 0xfdecee, 0x8e8e93,
    ]);
    const ARCADE: Palette = palette([
        0xebebeb, 0xffffff, 0xd9000f, 0x2d2d2d, 0x5f5f5f, 0x006a94, 0x276e2c, 0xa04b00, 0xb0186d,
        0xe1f0e2, 0xf9e1e3, 0x7a7a7a,
    ]);
    const HANDHELD: Palette = palette([
        0xe8e6f4, 0xf6f5fb, 0x4a3db3, 0x221d45, 0x5a5580, 0x136a86, 0x2f6f3e, 0x9a4a12, 0xa8256a,
        0xdff0e4, 0xf6e0ea, 0x7c78a0,
    ]);
    match theme {
        "nord" => &NORD,
        "bright" => &BRIGHT,
        "matrix" => &MATRIX,
        "midnight" => &MIDNIGHT,
        "graphite" => &GRAPHITE,
        "beige" => &BEIGE,
        "vice" => &VICE,
        "eagan" => &EAGAN,
        "pearl" => &PEARL,
        "ember" => &EMBER,
        "titanium" => &TITANIUM,
        "porcelain" => &PORCELAIN,
        "arcade" => &ARCADE,
        "handheld" => &HANDHELD,
        _ => &DEFAULT,
    }
}

/// What the terminal draws with: its own colors, when it answers the query, and whether it takes
/// 24-bit color.
#[derive(Clone, Copy)]
pub struct Terminal {
    /// The terminal's background and foreground; a terminal that reports them takes the theme's.
    colors: Option<(Rgb, Rgb)>,
    truecolor: bool,
}

impl Terminal {
    /// Asks the terminal for its colors. Run before raw mode and the input reader start, which
    /// would otherwise swallow the answer.
    pub fn detect() -> Self {
        let mut options = terminal_colorsaurus::QueryOptions::default();
        options.timeout = Duration::from_millis(200);
        let eight = |color: terminal_colorsaurus::Color| {
            let (r, g, b) = color.scale_to_8bit();
            Rgb(r, g, b)
        };
        let colors = terminal_colorsaurus::color_palette(options)
            .ok()
            .map(|palette| (eight(palette.background), eight(palette.foreground)));
        let var = |name| std::env::var(name).unwrap_or_default();
        let colorterm = var("COLORTERM");
        let program = var("TERM_PROGRAM");
        let term = var("TERM");
        let truecolor = colorterm == "truecolor"
            || colorterm == "24bit"
            || ["iTerm.app", "WezTerm", "ghostty", "vscode", "rio", "WarpTerminal"]
                .contains(&program.as_str())
            || ["kitty", "ghostty", "direct", "alacritty"].iter().any(|t| term.contains(t))
            || cfg!(windows);
        Self { colors, truecolor }
    }

    /// The sequence that gives the terminal its own colors back: set to what it reported, for
    /// terminals without the reset, then reset, so one that follows the system's appearance does
    /// again. Empty for a terminal Otis never painted.
    pub fn restore(&self) -> String {
        let Some((background, foreground)) = self.colors else {
            return String::new();
        };
        format!("{}{}\x1b]111\x1b\\\x1b]110\x1b\\", osc(11, background), osc(10, foreground))
    }

    /// A terminal that reports no colors and draws in 24-bit color, for layouts that must not
    /// depend on the terminal running the tests.
    #[cfg(test)]
    pub fn fixed() -> Self {
        Self { colors: None, truecolor: true }
    }
}

/// Sets one of the terminal's dynamic colors: 10 is its foreground, 11 its background.
fn osc(slot: u8, rgb: Rgb) -> String {
    format!("\x1b]{slot};#{:02x}{:02x}{:02x}\x1b\\", rgb.0, rgb.1, rgb.2)
}

#[derive(Clone, Copy)]
pub struct Theme {
    pub accent: Color,
    /// Accent text that reads at body size.
    pub accent_ink: Color,
    pub text: Color,
    pub dim: Color,
    /// A step below dim: shortcuts, counts, the quietest metadata.
    pub faint: Color,
    pub cyan: Color,
    pub green: Color,
    pub orange: Color,
    pub pink: Color,
    /// The user's message bubble.
    pub user: Color,
    pub code: Color,
    /// A hovered or selected row.
    pub selected: Color,
    pub border: Color,
    pub hairline: Color,
    pub diff_add: Color,
    pub diff_remove: Color,
    pub diff_ln: Color,
    page: Rgb,
    ink: Rgb,
    accent_rgb: Rgb,
    truecolor: bool,
    paints: bool,
}

/// The mark's three tones: its faces, as the desktop's `MARK_FACES` give them.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Tone {
    /// The top face, text ink at 70%.
    Top,
    /// The left face, text ink at 45%.
    Left,
    /// The face with the O cut from it.
    Accent,
}

impl Theme {
    /// The sequence that makes the theme's page and ink the terminal's own colors, so every row,
    /// the scrollback's too, sits on the theme; empty where the terminal cannot be painted.
    pub fn paint(&self) -> String {
        match self.paints {
            true => format!("{}{}", osc(11, self.page), osc(10, self.ink)),
            false => String::new(),
        }
    }

    /// A tone of the mark faded `fade` of the way into the page, as things deeper in a drawing
    /// recede.
    pub fn shade(&self, tone: Tone, fade: f32) -> Color {
        let rgb = match tone {
            Tone::Top => self.page.mix(self.ink, 0.7),
            Tone::Left => self.page.mix(self.ink, 0.45),
            Tone::Accent => self.accent_rgb,
        };
        color(rgb.mix(self.page, fade), self.truecolor)
    }

    pub fn new(name: &str, terminal: Terminal) -> Self {
        // A terminal that cannot be painted is most likely dark; a light theme would leave its ink
        // unreadable there.
        let palette = match named(name) {
            light if terminal.colors.is_none() && !light.bg.dark() => &DEFAULT,
            palette => palette,
        };
        let page = palette.bg;
        let color = |rgb: Rgb| color(rgb, terminal.truecolor);
        Self {
            page,
            ink: palette.text,
            accent_rgb: palette.accent,
            truecolor: terminal.truecolor,
            paints: terminal.colors.is_some(),
            accent: color(palette.accent),
            accent_ink: color(palette.accent.mix(palette.text, 0.18)),
            text: color(palette.text),
            dim: color(palette.dim),
            faint: color(page.mix(palette.dim, 0.7)),
            cyan: color(palette.cyan),
            green: color(palette.green),
            orange: color(palette.orange),
            pink: color(palette.pink),
            user: color(palette.elev.mix(palette.accent, 0.06)),
            code: color(page.mix(palette.text, 0.06)),
            selected: color(page.mix(palette.text, 0.11)),
            border: color(page.mix(palette.text, 0.13)),
            hairline: color(page.mix(palette.text, 0.075)),
            diff_add: color(palette.diff_add),
            diff_remove: color(palette.diff_remove),
            diff_ln: color(palette.diff_ln),
        }
    }
}

/// A color as the terminal draws it: exact in 24-bit color, else the nearest of xterm's 256.
fn color(rgb: Rgb, truecolor: bool) -> Color {
    match truecolor {
        true => Color::Rgb(rgb.0, rgb.1, rgb.2),
        false => Color::Indexed(xterm(rgb)),
    }
}

/// The nearest of xterm's 256 colors, from its 6×6×6 cube or its grey ramp.
fn xterm(rgb: Rgb) -> u8 {
    const LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];
    let level = |c: u8| (0..6).min_by_key(|&i| c.abs_diff(LEVELS[i])).expect("six levels");
    let (r, g, b) = (level(rgb.0), level(rgb.1), level(rgb.2));
    let distance = |c: Rgb| {
        let d = |a: u8, b: u8| (a as i32 - b as i32).pow(2);
        d(c.0, rgb.0) + d(c.1, rgb.1) + d(c.2, rgb.2)
    };
    let average = (rgb.0 as u16 + rgb.1 as u16 + rgb.2 as u16) / 3;
    let grey = (average.saturating_sub(3) / 10).min(23) as u8;
    let grey_level = 8 + grey * 10;
    if distance(Rgb(grey_level, grey_level, grey_level))
        < distance(Rgb(LEVELS[r], LEVELS[g], LEVELS[b]))
    {
        232 + grey
    } else {
        16 + 36 * r as u8 + 6 * g as u8 + b as u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixes_like_css_color_mix() {
        assert_eq!(Rgb(0, 0, 0).mix(Rgb(255, 255, 255), 0.5), Rgb(128, 128, 128));
        assert_eq!(Rgb::hex(0x8b7cff), Rgb(0x8b, 0x7c, 0xff));
    }

    #[test]
    fn paints_any_theme_on_a_terminal_that_reports_its_colors() {
        let painted =
            Terminal { colors: Some((Rgb(0, 0, 0), Rgb(255, 255, 255))), truecolor: true };
        let pearl = Theme::new("pearl", painted);
        assert_eq!(pearl.accent, Color::Rgb(0x00, 0x66, 0xcc));
        assert_eq!(pearl.paint(), "\x1b]11;#f5f5f7\x1b\\\x1b]10;#1d1d1f\x1b\\");
        assert_eq!(
            painted.restore(),
            "\x1b]11;#000000\x1b\\\x1b]10;#ffffff\x1b\\\x1b]111\x1b\\\x1b]110\x1b\\"
        );
    }

    #[test]
    fn keeps_dark_themes_where_the_terminal_cannot_be_painted() {
        let unknown = Terminal::fixed();
        assert_eq!(Theme::new("ember", unknown).accent, Color::Rgb(0xff, 0x9a, 0x3c));
        assert_eq!(Theme::new("pearl", unknown).accent, Color::Rgb(0x8b, 0x7c, 0xff));
        assert_eq!(Theme::new("ember", unknown).paint(), "");
        assert_eq!(unknown.restore(), "");
    }

    #[test]
    fn mixes_surfaces_from_the_page() {
        // The default bubble: its elevation #242427 tinted 6% toward the accent.
        assert_eq!(Theme::new("default", Terminal::fixed()).user, Color::Rgb(42, 41, 52));
    }

    #[test]
    fn maps_to_the_nearest_xterm_color() {
        assert_eq!(xterm(Rgb(0, 0, 0)), 16);
        assert_eq!(xterm(Rgb(255, 0, 0)), 196);
        assert_eq!(xterm(Rgb(128, 128, 128)), 244);
    }
}
