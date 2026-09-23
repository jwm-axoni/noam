//! Noam — desktop Rust core (Phase 0).
//! Rust owns all disk I/O; the React UI talks to it through the typed commands
//! registered here and reacts to `files-changed` / `vault-opened` events.

pub mod attachments;
mod commands;
mod error;
mod identity;
pub mod import_export;
pub mod index;
pub mod keychain;
pub mod knowledge;
pub mod notefile;
pub mod oauth;
pub mod parse;
mod state;
pub mod tasks;
pub mod tree;
pub mod vault;
mod watcher;

use state::AppState;
use tauri::Manager;

/// Source builds intentionally omit distribution-time updater settings.
fn has_updater_settings(config: &tauri::Config) -> bool {
    config
        .plugins
        .0
        .get("updater")
        .is_some_and(|value| !value.is_null())
}

/// Whether to register the updater plugin at all: the distribution config must
/// carry updater settings AND a managed policy must not force updates fully off
/// (`locked && !enabled`). Suppressing registration is the strongest lock —
/// there is then no polling and no update wall for a user to bypass.
fn should_register_updater(
    config: &tauri::Config,
    policy: &commands::ManagedUpdatePolicy,
) -> bool {
    has_updater_settings(config) && !policy.disables()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Single-instance FIRST, and only on desktop. Without it, clicking a
    // `noam://` link on Windows/Linux spawns a SECOND copy of the app with
    // the URL as an argv entry — two windows, two vault locks, one confused
    // user. With it the running instance is handed the URL and the duplicate
    // exits. On macOS the OS already routes links to the running app; the
    // plugin is harmless there and keeps one code path.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}));

    // The UI's own log, on the dev terminal. A `console.log` inside a WKWebView
    // goes to the Web Inspector and nowhere else, so anything the React layer
    // measures about itself is invisible to whoever is reading `tauri dev` —
    // which is how two wrong diagnoses of "the sidebar blinks while it syncs"
    // survived as long as they did. The frontend's `@tauri-apps/plugin-log`
    // calls land on stdout next to the Rust ones, so both halves of a symptom
    // read as one timeline. Debug builds only; a shipped app logs nothing new.
    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri_plugin_log::Builder::new()
            .level(log::LevelFilter::Info)
            .target(tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::Stdout,
            ))
            .build(),
    );

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        // Native clipboard: the webview's navigator.clipboard is tied to
        // WebKit's transient user activation, which an await (e.g. minting a
        // share link) outlives — a native call has no such rule.
        .plugin(tauri_plugin_clipboard_manager::init())
        // `noam://` links. A teammate pastes one into chat; clicking it hands
        // the URL to this app, which resolves it against the *recipient's* own
        // account and access — the link carries ids, never content or a grant.
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // A source build has no updater endpoint/key. Registering the plugin
            // without its config panics before the first window can open. A
            // managed policy that locks updates off suppresses it too.
            #[cfg(desktop)]
            if should_register_updater(app.config(), &commands::managed_update_policy()) {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            // Dev/Linux need a runtime registration: on macOS and Windows the
            // scheme comes from the bundle, which `tauri dev` never builds, so
            // without this a link is unopenable in development.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
            // The window starts hidden (`visible: false` in tauri.conf.json) so
            // nobody watches an empty frame while the bundle parses; the
            // frontend calls show() on its first paint. This is the dead-man's
            // switch: if the webview never gets that far — a JS crash, a broken
            // bundle — the window still appears, with whatever the webview
            // managed to render, instead of the app running invisibly. Tauri v2
            // window methods are callable off the main thread and show() on a
            // visible window is a no-op, so this needs no coordination.
            #[cfg(desktop)]
            if let Some(win) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    if win.is_visible().unwrap_or(false) {
                        return;
                    }
                    log::warn!(
                        "[window] frontend never revealed the window in 1500ms; showing it anyway"
                    );
                    let _ = win.show();
                    let _ = win.set_focus();
                });
            }
            Ok(())
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::pick_vault,
            commands::open_vault,
            commands::get_last_vault,
            commands::clear_last_vault,
            commands::get_recent_vaults,
            commands::remove_recent_vault,
            commands::delete_vault,
            commands::create_vault,
            commands::is_vault,
            commands::list_tree,
            commands::list_children,
            commands::read_note,
            commands::read_note_snapshot,
            commands::note_exists,
            commands::write_trash_copy,
            commands::rebind_note_id,
            commands::write_note,
            commands::inspect_document_identity,
            commands::write_note_if_missing,
            commands::write_note_if_unchanged,
            commands::create_note,
            commands::create_folder,
            commands::ensure_folder,
            commands::rename_path,
            commands::delete_path,
            commands::delete_file,
            commands::delete_folder_if_empty,
            commands::trash_note,
            commands::search_notes,
            commands::get_backlinks,
            commands::query_knowledge,
            commands::query_tasks,
            commands::graph_edges,
            commands::graph_edges_for,
            commands::get_note_meta,
            commands::resolve_wikilink,
            commands::list_note_titles,
            commands::list_graph_nodes,
            commands::append_yjs_update,
            commands::load_yjs_state,
            commands::save_yjs_snapshot,
            commands::save_yjs_state_vectors,
            commands::list_yjs_state_vectors,
            commands::prune_yjs_docs,
            commands::clear_yjs_doc,
            commands::read_binary_file,
            commands::write_binary_file,
            commands::list_attachments,
            commands::read_external_file,
            commands::write_external_file,
            commands::get_server_url,
            commands::set_server_url,
            commands::get_update_preferences,
            commands::set_auto_check_updates,
            commands::get_vaults_root,
            commands::set_vaults_root,
            commands::pick_vaults_root,
            commands::pick_folder,
            commands::pick_files,
            commands::save_file,
            commands::import_paths,
            commands::export_path,
            commands::open_vault_in_root,
            commands::folder_exists,
            commands::peek_vault_stamp,
            commands::list_vaults_root_dirs,
            commands::get_vault_config,
            commands::set_vault_config,
            commands::get_vault_types,
            commands::set_vault_types,
            commands::list_property_keys,
            commands::list_property_values,
            commands::list_tags,
            commands::get_note_ui_state,
            commands::set_note_ui_state,
            commands::get_vault_epoch,
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_delete,
            oauth::google_oauth_listen,
            oauth::google_oauth_await,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod startup_tests {
    use super::{has_updater_settings, should_register_updater};
    use crate::commands::ManagedUpdatePolicy;

    #[test]
    fn source_config_ships_with_updater_settings() {
        // Distribution is enabled: the committed tauri.conf.json carries the
        // updater pubkey + endpoint, so has_updater_settings() detects it and
        // the plugin registers unless a managed policy disables it.
        let config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(has_updater_settings(&config));
    }

    #[test]
    fn release_updater_settings_are_still_registered() {
        let mut config = tauri::Config::default();
        config.plugins.0.insert(
            "updater".into(),
            serde_json::json!({"pubkey": "release-key", "endpoints": ["https://example.com/update.json"]}),
        );
        assert!(has_updater_settings(&config));
        let _: tauri_plugin_updater::Config =
            serde_json::from_value(config.plugins.0["updater"].clone()).unwrap();
        config
            .plugins
            .0
            .insert("updater".into(), serde_json::Value::Null);
        assert!(!has_updater_settings(&config));
    }

    #[test]
    fn disabled_managed_policy_suppresses_updater_registration() {
        // Even a release config that carries distribution updater settings must
        // not register the plugin once a managed policy locks updates off.
        let mut config = tauri::Config::default();
        config.plugins.0.insert(
            "updater".into(),
            serde_json::json!({"pubkey": "release-key", "endpoints": ["https://example.com/update.json"]}),
        );
        let disabled = ManagedUpdatePolicy { enabled: false, locked: true };
        assert!(!should_register_updater(&config, &disabled));
        // No policy leaves the release config registering as before.
        let no_policy = ManagedUpdatePolicy { enabled: true, locked: false };
        assert!(should_register_updater(&config, &no_policy));
    }
}
