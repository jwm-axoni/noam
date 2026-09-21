//! Shared application state: the currently-open vault, its live index, and the
//! watcher handle. Guarded by a single mutex; commands clone out the pieces
//! they need and release the lock quickly.

use crate::index::Index;
use crate::oauth::OauthResult;
use crate::watcher::VaultWatcher;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct AppState {
    pub inner: Mutex<Inner>,
    /// Serializes revision-checked note mutations with the editor's ordinary
    /// write path. Without this, an identity insertion could validate old bytes
    /// while a concurrent `write_note` publishes new ones, then overwrite them.
    pub note_writes: Mutex<()>,
    /// Pending Google-OAuth loopback handoff: `google_oauth_listen` parks the
    /// receiver here; `google_oauth_await` takes it out and blocks on it. Its
    /// own mutex so it never contends with the vault/index lock.
    pub oauth_rx: Mutex<Option<Receiver<OauthResult>>>,
    /// Absolute paths the user picked in a native save dialog and that have not
    /// been written yet. `write_external_file` is the ONE command that escapes
    /// the vault, so a path is only writable while it sits in here: the dialog
    /// is the authorization, and a single write consumes it. Without this the
    /// renderer could name any file the process can write.
    pub approved_writes: Mutex<HashSet<PathBuf>>,
    /// The parsed app `config.json`, cached after its first read.
    ///
    /// Its OWN mutex, deliberately: a config read must never queue behind the
    /// vault/index lock, which the background rebuild holds for the whole of a
    /// vault open. `None` means "not loaded yet"; `write_config` replaces the
    /// cached value rather than invalidating it, so the next read never touches
    /// the disk. Correct only while this process is the sole writer of the file,
    /// which it is (single-instance plugin) — a future "reload settings from
    /// disk" would have to clear this.
    pub config: Mutex<Option<crate::commands::AppConfig>>,
}

#[derive(Default)]
pub struct Inner {
    pub vault: Option<PathBuf>,
    pub index: Option<Arc<Mutex<Index>>>,
    pub watcher: Option<VaultWatcher>,
    /// Monotonic counter bumped on EVERY vault open. There is one global vault
    /// slot, so a vault-relative command resolves against whatever vault is open
    /// when it *lands* — not the vault its caller intended. Callers that write
    /// (or read in order to write) pass the epoch they started under; a mismatch
    /// is rejected instead of writing vault A's data into vault B's folder.
    /// An epoch is unambiguous where a path can repeat (reopen, rebind, rename).
    pub vault_epoch: u64,
}
