//! Integration test: build a real on-disk test vault (nested folders, tags,
//! wiki-links) in the OS temp dir, then exercise the public index logic
//! against it end-to-end.

use desktop_lib::index::Index;
use desktop_lib::notefile;
use std::path::PathBuf;

fn scratch_vault() -> PathBuf {
    std::env::temp_dir().join("context-test-vault")
}

fn seed(vault: &PathBuf) {
    // Fresh vault each run.
    let _ = std::fs::remove_dir_all(vault);
    std::fs::create_dir_all(vault).unwrap();

    notefile::write_note(
        vault,
        "Index.md",
        "---\ntitle: Home\ntags: [moc]\n---\n# Home\n\nStart at [[Projects/Noam]] and [[Daily/2026-07-13]].\n",
    )
    .unwrap();
    notefile::write_note(
        vault,
        "Projects/Noam.md",
        "# Noam\n\nA local-first #project. Relates to [[Index]].\nSee also [[Daily/2026-07-13]].\n",
    )
    .unwrap();
    notefile::write_note(
        vault,
        "Daily/2026-07-13.md",
        "# 2026-07-13\n\nWorked on #project thread. Quick brown fox jumps. Link [[Projects/Noam]].\n",
    )
    .unwrap();
    notefile::write_note(
        vault,
        "Daily/Notes/Scratch.md",
        "# Scratch\n\nDangling [[Nowhere]] plus a #idea tag.\n",
    )
    .unwrap();
}

#[test]
fn full_index_lifecycle_on_disk_vault() {
    let vault = scratch_vault();
    seed(&vault);

    let idx = Index::open(&vault).unwrap();
    idx.rebuild(&vault).unwrap();

    // 4 notes discovered across nested folders.
    let titles = idx.list_note_titles().unwrap();
    assert_eq!(titles.len(), 4, "expected 4 notes, got {}", titles.len());

    // FTS: "quick brown" only appears in the daily note.
    let hits = idx.search_notes("quick brown").unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].title, "2026-07-13");
    assert!(hits[0].snippet.contains("<mark>"));

    // Wiki-link resolution (path-style target).
    let resolved = idx.resolve_wikilink("Projects/Noam").unwrap().unwrap();
    assert_eq!(resolved.path, "Projects/Noam.md");

    // Backlinks: Noam is linked from Index + Daily → 2 backlinks.
    let thread = idx.get_note_meta("Projects/Noam.md").unwrap().unwrap();
    let backlinks = idx.get_backlinks(&thread.id).unwrap();
    assert_eq!(backlinks.len(), 2, "thread backlinks: {:?}", backlinks);

    // Tags surfaced on the daily note.
    let daily = idx.get_note_meta("Daily/2026-07-13.md").unwrap().unwrap();
    assert!(daily.tags.contains(&"project".to_string()));

    // Dangling link ([[Nowhere]]) is recorded but unresolved (no backlink).
    let dangling = idx.resolve_wikilink("Nowhere").unwrap();
    assert!(dangling.is_none());

    // Identity is stable across a rebuild.
    let id_before = thread.id.clone();
    idx.rebuild(&vault).unwrap();
    let id_after = idx.get_note_meta("Projects/Noam.md").unwrap().unwrap().id;
    assert_eq!(id_before, id_after);

    // A move keeps inbound links pointing at the same doc_id.
    std::fs::create_dir_all(vault.join("Archive")).unwrap();
    std::fs::rename(
        vault.join("Projects/Noam.md"),
        vault.join("Archive/Noam.md"),
    )
    .unwrap();
    idx.rename_note(
        &vault,
        &vault.join("Projects/Noam.md"),
        &vault.join("Archive/Noam.md"),
    )
    .unwrap();
    let moved = idx.get_note_meta("Archive/Noam.md").unwrap().unwrap();
    assert_eq!(moved.id, id_before);
    assert_eq!(idx.get_backlinks(&moved.id).unwrap().len(), 2);
}
