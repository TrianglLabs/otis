//! `otis`: the terminal UI with no arguments, and every subcommand (`exec`, `serve`, `skills`,
//! `update`, `version`) handed to the Otis runtime beside it.

mod app;
mod composer;
mod home;
mod protocol;
mod screen;
mod text;
mod theme;
mod transcript;

use std::io::{IsTerminal, Write};
use std::process::ExitCode;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crossterm::event::{
    self, DisableBracketedPaste, DisableFocusChange, EnableBracketedPaste, EnableFocusChange,
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::terminal::{self, DisableLineWrap, EnableLineWrap};

use crate::app::App;
use crate::protocol::{Incoming, Runtime};
use crate::theme::Terminal;

/// How often the live region animates while something moves.
const FRAME: Duration = Duration::from_millis(80);

enum Message {
    Terminal(event::Event),
    Runtime(Incoming),
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        return forward(&args);
    }
    // A launcher or a pipe has no terminal to draw in; the TUI would wait forever.
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        eprintln!(
            "otis needs an interactive terminal. Run it from a terminal, \
             or use `otis exec` for scripts."
        );
        return ExitCode::FAILURE;
    }
    match run() {
        Ok(None) => ExitCode::SUCCESS,
        Ok(Some(reason)) => {
            eprintln!("{reason}");
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("Error: {error}");
            ExitCode::FAILURE
        }
    }
}

/// Runs a subcommand on the runtime in this process's place.
fn forward(args: &[String]) -> ExitCode {
    let started: std::io::Result<std::process::ExitStatus> =
        protocol::runtime_command().and_then(|mut command| {
            command.args(args);
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                Err(command.exec())
            }
            #[cfg(not(unix))]
            command.status()
        });
    match started {
        Ok(status) => ExitCode::from(status.code().unwrap_or(1) as u8),
        Err(error) => {
            eprintln!("Error: could not start the Otis runtime: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> std::io::Result<Option<String>> {
    // Asked before raw mode and the input reader, which would swallow the terminal's answer.
    let terminal = Terminal::detect();
    let (sender, receiver) = mpsc::channel();
    let runtime_sender = sender.clone();
    let runtime = Runtime::spawn(move |incoming| {
        let _ = runtime_sender.send(Message::Runtime(incoming));
    })
    .map_err(|error| {
        std::io::Error::new(error.kind(), format!("could not start the Otis runtime: {error}"))
    })?;

    terminal::enable_raw_mode()?;
    let mut out = std::io::stdout();
    execute!(out, DisableLineWrap, EnableBracketedPaste, EnableFocusChange)?;
    // Where the terminal can tell Shift+Enter from Enter, it does. Asked once, here: the input
    // reader below holds the lock the question needs.
    let enhanced = terminal::supports_keyboard_enhancement().unwrap_or(false);
    if enhanced {
        let flags = KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES;
        execute!(out, PushKeyboardEnhancementFlags(flags))?;
    }
    // The terminal's own colors and keys come back however Otis ends, a panic included.
    let colors = terminal.restore();
    let hook_colors = colors.clone();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        leave(&hook_colors, enhanced);
        previous(info);
    }));
    std::thread::spawn(move || {
        while let Ok(event) = event::read() {
            if sender.send(Message::Terminal(event)).is_err() {
                break;
            }
        }
    });

    let mut app = App::new(runtime, terminal, terminal::size()?);
    let mut last_frame = Instant::now();
    let outcome = loop {
        if let Err(error) = app.draw(false) {
            break Err(error);
        }
        if app.done {
            break Ok(());
        }
        let wait = if app.animating() {
            FRAME.saturating_sub(last_frame.elapsed())
        } else {
            Duration::from_secs(1)
        };
        match receiver.recv_timeout(wait) {
            Ok(message) => {
                deliver(&mut app, message);
                // Everything already waiting lands in the same frame.
                while let Ok(message) = receiver.try_recv() {
                    deliver(&mut app, message);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break Ok(()),
        }
        if last_frame.elapsed() >= FRAME {
            app.tick();
            last_frame = Instant::now();
        }
    };
    // What the turn in progress showed stays in the scrollback.
    let closed = app.draw(true);
    leave(&colors, enhanced);
    let exited = app.exited.take();
    app.shutdown();
    outcome.and(closed).map(|()| exited)
}

fn deliver(app: &mut App, message: Message) {
    match message {
        Message::Terminal(event) => app.event(event),
        Message::Runtime(incoming) => app.incoming(incoming),
    }
}

fn leave(colors: &str, enhanced: bool) {
    let mut out = std::io::stdout();
    let _ = out.write_all(colors.as_bytes());
    if enhanced {
        let _ = execute!(out, PopKeyboardEnhancementFlags);
    }
    let _ = execute!(
        out,
        DisableFocusChange,
        DisableBracketedPaste,
        EnableLineWrap,
        crossterm::cursor::Show
    );
    let _ = terminal::disable_raw_mode();
    let _ = out.flush();
}
