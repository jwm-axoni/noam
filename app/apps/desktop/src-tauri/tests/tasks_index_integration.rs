//! Integration test: a real on-disk vault, the real index, and the derived
//! task tables. What it guards is the promise that makes the index safe to
//! throw away — a rebuild reproduces exactly what incremental indexing built,
//! and nothing a task carries is invented by the index.

use desktop_lib::index::Index;
use desktop_lib::notefile;
use desktop_lib::tasks::{TaskPageRequest, TaskQuery};
use std::path::PathBuf;

fn scratch_vault(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("context-test-tasks-{name}"))
}

fn seed(vault: &PathBuf) {
    let _ = std::fs::remove_dir_all(vault);
    std::fs::create_dir_all(vault).unwrap();
    notefile::write_note(
        vault,
        "Work/Project.md",
        "---\ntitle: Project\n---\n# Project\n\n- [ ] Draft the spec ⏫ 📅 2026-03-09 #work\n- [x] Kick-off ✅ 2026-03-01\n\n## Later\n\n- [ ] Review 🔁 every week 📅 2026-03-20 ^t-k3x9f2a0b1\n\n```md\n- [ ] Documentation, not a task\n```\n",
    )
    .unwrap();
    notefile::write_note(
        vault,
        "Home/Chores.md",
        "- [ ] Water the plants 📅 2026-03-10 #home\n- [-] Call the plumber\n- [ ] Someday\n",
    )
    .unwrap();
}

fn all(idx: &Index) -> Vec<String> {
    idx.query_tasks(&TaskQuery::default(), &TaskPageRequest::default())
        .unwrap()
        .items
        .into_iter()
        .map(|task| task.text)
        .collect()
}

#[test]
fn task_rows_follow_the_files() {
    let vault = scratch_vault("lifecycle");
    seed(&vault);
    let idx = Index::open(&vault).unwrap();
    idx.rebuild(&vault).unwrap();

    // Six task lines across two notes; the fenced one is documentation.
    let page = idx
        .query_tasks(&TaskQuery::default(), &TaskPageRequest::default())
        .unwrap();
    assert_eq!(page.total, 6, "{:?}", all(&idx));
    assert!(page.items.iter().all(|t| t.text != "Documentation, not a task"));

    // Ordered by due date, undated last, and every field came off the line.
    let first = &page.items[0];
    assert_eq!(first.text, "Draft the spec");
    assert_eq!(first.due.as_deref(), Some("2026-03-09"));
    assert_eq!(first.priority.as_deref(), Some("highest"));
    assert_eq!(first.tags, vec!["work".to_string()]);
    assert_eq!(first.section, vec!["Project".to_string()]);
    assert_eq!(first.path, "Work/Project.md");
    assert_eq!(
        first.note_id,
        idx.get_note_meta("Work/Project.md").unwrap().unwrap().id
    );

    // The hint span lands on the line it describes (UTF-16, like the editor).
    let content = std::fs::read_to_string(vault.join("Work/Project.md")).unwrap();
    let utf16: Vec<u16> = content.encode_utf16().collect();
    for task in &page.items {
        if task.path != "Work/Project.md" {
            continue;
        }
        let slice =
            String::from_utf16(&utf16[task.char_from as usize..task.char_to as usize]).unwrap();
        assert_eq!(slice, task.source_text);
    }

    // Filters.
    let due = idx
        .query_tasks(
            &TaskQuery {
                statuses: vec!["todo".into()],
                due_before: Some("2026-03-11".into()),
                ..Default::default()
            },
            &TaskPageRequest::default(),
        )
        .unwrap();
    assert_eq!(
        due.items.iter().map(|t| t.text.clone()).collect::<Vec<_>>(),
        vec!["Draft the spec".to_string(), "Water the plants".to_string()]
    );
    let by_note = idx
        .query_tasks(
            &TaskQuery {
                path_prefix: Some("home/".into()),
                ..Default::default()
            },
            &TaskPageRequest::default(),
        )
        .unwrap();
    assert_eq!(by_note.total, 3);

    // An id in the file is the identity: editing the line keeps it.
    notefile::write_note(
        &vault,
        "Work/Project.md",
        "# Project\n\n- [x] Review, renamed and moved up 🔁 every week 📅 2026-03-20 ✅ 2026-03-19 ^t-k3x9f2a0b1\n",
    )
    .unwrap();
    idx.index_note(&vault, &vault.join("Work/Project.md")).unwrap();
    let stamped = idx
        .query_tasks(
            &TaskQuery {
                task_id: Some("t-k3x9f2a0b1".into()),
                ..Default::default()
            },
            &TaskPageRequest::default(),
        )
        .unwrap();
    assert_eq!(stamped.items.len(), 1);
    assert_eq!(stamped.items[0].text, "Review, renamed and moved up");
    assert_eq!(stamped.items[0].line, 2);
    assert_eq!(stamped.items[0].status, "done");
    assert_eq!(stamped.items[0].series_id.as_deref(), Some("t-k3x9f2a0b1"));
    // The note's other tasks went with the edit; nothing stale is left behind.
    assert_eq!(all(&idx).len(), 4);

    // A rebuild reproduces the same rows, with the same ids.
    let note_id = idx.get_note_meta("Work/Project.md").unwrap().unwrap().id;
    idx.rebuild(&vault).unwrap();
    let after = idx
        .query_tasks(
            &TaskQuery {
                task_id: Some("t-k3x9f2a0b1".into()),
                ..Default::default()
            },
            &TaskPageRequest::default(),
        )
        .unwrap();
    assert_eq!(after.items.len(), 1);
    assert_eq!(after.items[0].note_id, note_id);
    assert_eq!(all(&idx).len(), 4);

    // A deleted note takes its tasks with it.
    std::fs::remove_file(vault.join("Home/Chores.md")).unwrap();
    idx.rebuild(&vault).unwrap();
    assert_eq!(all(&idx), vec!["Review, renamed and moved up".to_string()]);
}

#[test]
fn oversized_and_unreadable_notes_contribute_no_tasks() {
    let vault = scratch_vault("skipped");
    let _ = std::fs::remove_dir_all(&vault);
    std::fs::create_dir_all(&vault).unwrap();
    notefile::write_note(&vault, "Small.md", "- [ ] Real task 📅 2026-03-09\n").unwrap();

    // Past MAX_INDEX_BYTES (10 MB): the note is listed but never parsed, so it
    // cannot turn one bad file into 200k task rows.
    let mut huge = String::with_capacity(11 * 1024 * 1024);
    while huge.len() < 11 * 1024 * 1024 {
        huge.push_str("- [ ] one of very many 📅 2026-03-09\n");
    }
    notefile::write_note(&vault, "Huge.md", &huge).unwrap();

    // Not UTF-8: `index_one` refuses it, and the refusal is per-file.
    std::fs::write(vault.join("Binary.md"), [0xff, 0xfe, 0x00, 0x01, 0x2d]).unwrap();

    let idx = Index::open(&vault).unwrap();
    let failures = idx
        .index_notes(
            &vault,
            &[
                vault.join("Small.md"),
                vault.join("Huge.md"),
                vault.join("Binary.md"),
            ],
        )
        .unwrap();
    assert_eq!(failures.len(), 1, "only the binary file fails");
    assert!(failures[0].0.ends_with("Binary.md"));

    let page = idx
        .query_tasks(&TaskQuery::default(), &TaskPageRequest::default())
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].text, "Real task");
}
