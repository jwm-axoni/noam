//! Embedded terminal sessions (plan: `docs/PLAN-INTERACTIVE-VIEWS.md` Part 6).
//!
//! Rust owns every shell process, not the tab that shows it. A session is keyed
//! by the workspace panel instance id and survives the React view unmounting —
//! dragging a terminal tab between docks remounts the view, which re-attaches
//! with a fresh channel and gets the scrollback replayed. Dragging a tab must
//! never kill a running process.
//!
//! Rules this module enforces on its own, whatever the UI does:
//! - only the `main` window may call any terminal command (a note, frame or
//!   secondary webview never spawns a shell);
//! - a managed policy (`managed-policy.json` → `terminal.enabled: false`, or env
//!   `NOAM_TERMINAL_POLICY=disabled`) refuses every spawn;
//! - the shell starts in the open vault's root and nowhere else;
//! - nothing spawns implicitly: `terminal_attach` never starts a process, only
//!   `terminal_open` does, and the UI calls that only for a user action.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};

/// Bytes of output replayed to a view that re-attaches. Enough for a few
/// screens of a coding agent's history without holding megabytes per tab.
const SCROLLBACK_BYTES: usize = 256 * 1024;

/// Upper bound on concurrent sessions. The UI allows a handful of terminal
/// panels; this stops a runaway caller from forking without limit.
const MAX_SESSIONS: usize = 8;

const MAIN_WINDOW: &str = "main";

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

struct Session {
    writer: Mutex<Box<dyn Write + Send>>,
    /// `None` once the process has exited and the pty has been released.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output: Mutex<Output>,
}

#[derive(Default)]
struct Output {
    scrollback: Vec<u8>,
    channel: Option<Channel<InvokeResponseBody>>,
    /// `Some` once the process is gone; the value is its exit code if known.
    exited: Option<Option<u32>>,
}

impl Output {
    fn push(&mut self, bytes: &[u8]) {
        self.scrollback.extend_from_slice(bytes);
        trim_scrollback(&mut self.scrollback, SCROLLBACK_BYTES);
        if let Some(channel) = &self.channel {
            let _ = channel.send(InvokeResponseBody::Raw(bytes.to_vec()));
        }
    }

    fn finish(&mut self, code: Option<u32>) {
        if self.exited.is_some() {
            return;
        }
        self.exited = Some(code);
        if let Some(channel) = &self.channel {
            let _ = channel.send(exit_message(code));
        }
    }
}

/// Drop the oldest bytes past `cap`, cutting at a line boundary when one is
/// near so a replay starts on a clean line rather than mid escape sequence.
fn trim_scrollback(buf: &mut Vec<u8>, cap: usize) {
    if buf.len() <= cap {
        return;
    }
    let mut cut = buf.len() - cap;
    if let Some(nl) = buf[cut..].iter().take(4096).position(|&b| b == b'\n') {
        cut += nl + 1;
    }
    buf.drain(..cut);
}

fn exit_message(code: Option<u32>) -> InvokeResponseBody {
    InvokeResponseBody::Json(serde_json::json!({ "exit": code }).to_string())
}

// ---- managed policy --------------------------------------------------------

#[derive(Deserialize)]
struct PolicyFile {
    terminal: Option<PolicyTerminal>,
}

#[derive(Deserialize)]
struct PolicyTerminal {
    #[serde(default = "default_true")]
    enabled: bool,
}

fn default_true() -> bool {
    true
}

/// `false` only when IT disabled the terminal. A missing or unreadable policy
/// is "no policy", never a silent lock — same rule as the update policy.
fn parse_terminal_policy(s: &str) -> Option<bool> {
    serde_json::from_str::<PolicyFile>(s)
        .ok()
        .and_then(|f| f.terminal)
        .map(|t| t.enabled)
}

pub fn terminal_allowed() -> bool {
    if std::env::var("NOAM_TERMINAL_POLICY").is_ok_and(|v| v == "disabled") {
        return false;
    }
    crate::commands::managed_policy_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|s| parse_terminal_policy(&s))
        .unwrap_or(true)
}

// ---- process ---------------------------------------------------------------

fn shell_command(cwd: &std::path::Path) -> CommandBuilder {
    // Unix: the default program is the user's LOGIN shell ($SHELL, else the
    // passwd entry, argv0 prefixed with `-`). A GUI app does not inherit the
    // PATH a terminal would, so a plain spawn leaves `claude` and `codex`
    // unfound; the login shell sources the user's profile and fixes that.
    #[cfg(unix)]
    let mut cmd = CommandBuilder::new_default_prog();
    #[cfg(windows)]
    let mut cmd = {
        let mut c = CommandBuilder::new("powershell.exe");
        c.arg("-NoLogo");
        c
    };
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Noam");
    // Apps launched from Finder get no locale; without one, shells and TUIs
    // fall back to ASCII and mangle every non-Latin character.
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    cmd
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(2, 1000),
        cols: cols.clamp(2, 1000),
        pixel_width: 0,
        pixel_height: 0,
    }
}

impl TerminalManager {
    fn get(&self, key: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(key).cloned()
    }

    fn spawn(
        &self,
        key: String,
        cwd: &std::path::Path,
        cols: u16,
        rows: u16,
        channel: Channel<InvokeResponseBody>,
    ) -> AppResult<()> {
        {
            let sessions = self.sessions.lock().unwrap();
            if let Some(existing) = sessions.get(&key) {
                if existing.output.lock().unwrap().exited.is_none() {
                    return Err(AppError("terminal session already running".into()));
                }
            }
            let live = sessions
                .values()
                .filter(|s| s.output.lock().unwrap().exited.is_none())
                .count();
            if live >= MAX_SESSIONS {
                return Err(AppError(format!(
                    "at most {MAX_SESSIONS} terminals can run at once"
                )));
            }
        }

        let pair = native_pty_system()
            .openpty(pty_size(cols, rows))
            .map_err(|e| AppError(format!("could not open a terminal: {e}")))?;
        let mut child = pair
            .slave
            .spawn_command(shell_command(cwd))
            .map_err(|e| AppError(format!("could not start the shell: {e}")))?;
        // The parent must not hold the slave: while it does, the master never
        // reads EOF after the shell exits.
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError(e.to_string()))?;

        let session = Arc::new(Session {
            writer: Mutex::new(writer),
            master: Mutex::new(Some(pair.master)),
            killer: Mutex::new(child.clone_killer()),
            output: Mutex::new(Output { channel: Some(channel), ..Default::default() }),
        });
        let replaced = self.sessions.lock().unwrap().insert(key, session.clone());
        drop(replaced);

        // Reader: pty → scrollback + attached view. Ends on EOF/error, which
        // follows the process exiting (Unix) or the master being dropped.
        let reading = session.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => reading.output.lock().unwrap().push(&buf[..n]),
                }
            }
        });

        // Waiter: records the exit, then releases the pty. Windows ConPTY keeps
        // the reader blocked after the child exits until the master is dropped.
        let waiting = session;
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            // Let the reader drain what the shell printed last before the
            // exit notice goes out behind it.
            std::thread::sleep(std::time::Duration::from_millis(50));
            waiting.output.lock().unwrap().finish(code);
            waiting.master.lock().unwrap().take();
        });
        Ok(())
    }

    fn kill(&self, key: &str) {
        let removed = self.sessions.lock().unwrap().remove(key);
        if let Some(session) = removed {
            let _ = session.killer.lock().unwrap().kill();
            session.output.lock().unwrap().channel = None;
        }
    }

    pub fn kill_all(&self) {
        let drained: Vec<_> = self.sessions.lock().unwrap().drain().collect();
        for (_, session) in drained {
            let _ = session.killer.lock().unwrap().kill();
        }
    }
}

// ---- commands --------------------------------------------------------------

fn require_main(window: &tauri::WebviewWindow) -> AppResult<()> {
    if window.label() == MAIN_WINDOW {
        Ok(())
    } else {
        Err(AppError("terminal is only available in the main window".into()))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStatus {
    pub enabled: bool,
}

#[tauri::command]
pub fn terminal_status(window: tauri::WebviewWindow) -> AppResult<TerminalStatus> {
    require_main(&window)?;
    Ok(TerminalStatus { enabled: terminal_allowed() })
}

/// Start a shell for `key` in the open vault's root. Refuses when policy
/// disables the terminal, no vault is open, or `key` is already running.
#[tauri::command]
pub fn terminal_open(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    terminals: tauri::State<'_, TerminalManager>,
    key: String,
    cols: u16,
    rows: u16,
    channel: Channel<InvokeResponseBody>,
) -> AppResult<()> {
    require_main(&window)?;
    if !terminal_allowed() {
        return Err(AppError("the terminal is disabled by your organization".into()));
    }
    let vault = state
        .inner
        .lock()
        .unwrap()
        .vault
        .clone()
        .ok_or_else(|| AppError("open a vault first".into()))?;
    terminals.spawn(key, &vault, cols, rows, channel)
}

/// Re-attach a view to an existing session: replays the scrollback (and the
/// exit notice, if the shell is gone) down `channel`, then streams live output
/// to it. Returns `false` when there is no session — it NEVER spawns one.
#[tauri::command]
pub fn terminal_attach(
    window: tauri::WebviewWindow,
    terminals: tauri::State<'_, TerminalManager>,
    key: String,
    channel: Channel<InvokeResponseBody>,
) -> AppResult<bool> {
    require_main(&window)?;
    let Some(session) = terminals.get(&key) else {
        return Ok(false);
    };
    // Replay and swap under ONE lock so no output lands between the snapshot
    // and the new channel, and the channel's own ordering keeps replay first.
    let mut out = session.output.lock().unwrap();
    if !out.scrollback.is_empty() {
        let _ = channel.send(InvokeResponseBody::Raw(out.scrollback.clone()));
    }
    if let Some(code) = out.exited {
        let _ = channel.send(exit_message(code));
    }
    out.channel = Some(channel);
    Ok(true)
}

/// Stop streaming to a view that unmounted. `channel_id` guards the race where
/// the view's new mount attached before the old one detached.
#[tauri::command]
pub fn terminal_detach(
    window: tauri::WebviewWindow,
    terminals: tauri::State<'_, TerminalManager>,
    key: String,
    channel_id: u32,
) -> AppResult<()> {
    require_main(&window)?;
    if let Some(session) = terminals.get(&key) {
        let mut out = session.output.lock().unwrap();
        if out.channel.as_ref().is_some_and(|c| c.id() == channel_id) {
            out.channel = None;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_write(
    window: tauri::WebviewWindow,
    terminals: tauri::State<'_, TerminalManager>,
    key: String,
    data: String,
) -> AppResult<()> {
    require_main(&window)?;
    if let Some(session) = terminals.get(&key) {
        let mut writer = session.writer.lock().unwrap();
        // A write to a shell that just exited fails; the exit notice already
        // tells the view, so there is nothing more to report.
        let _ = writer.write_all(data.as_bytes()).and_then(|_| writer.flush());
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_resize(
    window: tauri::WebviewWindow,
    terminals: tauri::State<'_, TerminalManager>,
    key: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    require_main(&window)?;
    if let Some(session) = terminals.get(&key) {
        if let Some(master) = session.master.lock().unwrap().as_ref() {
            let _ = master.resize(pty_size(cols, rows));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_kill(
    window: tauri::WebviewWindow,
    terminals: tauri::State<'_, TerminalManager>,
    key: String,
) -> AppResult<()> {
    require_main(&window)?;
    terminals.kill(&key);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrollback_keeps_the_newest_bytes_and_cuts_at_a_line() {
        let mut buf = b"old line\nnewer line\nnewest\n".to_vec();
        trim_scrollback(&mut buf, 16);
        assert_eq!(buf, b"newest\n");
    }

    #[test]
    fn scrollback_under_cap_is_untouched() {
        let mut buf = b"abc".to_vec();
        trim_scrollback(&mut buf, 16);
        assert_eq!(buf, b"abc");
    }

    #[test]
    fn scrollback_without_a_nearby_newline_cuts_exactly() {
        let mut buf = vec![b'x'; 10_000];
        trim_scrollback(&mut buf, 100);
        assert!(buf.len() <= 100);
    }

    #[test]
    fn policy_disables_only_when_it_says_so() {
        assert_eq!(parse_terminal_policy(r#"{"terminal":{"enabled":false}}"#), Some(false));
        assert_eq!(parse_terminal_policy(r#"{"terminal":{}}"#), Some(true));
        assert_eq!(parse_terminal_policy(r#"{"autoUpdate":{"enabled":false}}"#), None);
        assert_eq!(parse_terminal_policy("not json"), None);
    }

    #[test]
    fn pty_size_is_clamped() {
        let s = pty_size(0, 5000);
        assert_eq!((s.cols, s.rows), (2, 1000));
    }

    #[cfg(unix)]
    #[test]
    fn a_session_runs_in_the_given_directory_and_reports_exit() {
        let dir = tempfile::tempdir().unwrap();
        let pair = native_pty_system().openpty(pty_size(80, 24)).unwrap();
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "pwd; exit 3"]);
        cmd.cwd(dir.path());
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let status = child.wait().unwrap();
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
        }
        let text = String::from_utf8_lossy(&out);
        let expected = dir.path().canonicalize().unwrap();
        let name = expected.file_name().unwrap().to_string_lossy().to_string();
        assert!(text.contains(&name), "pwd output {text:?} should name {name}");
        assert_eq!(status.exit_code(), 3);
    }
}
