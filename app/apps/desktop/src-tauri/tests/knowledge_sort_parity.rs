//! `query_knowledge` sort + the `created`/`modified` system properties.
//!
//! The first test replays the fixture the server's vitest replays too
//! (`packages/contracts/fixtures/knowledge-sort-parity.json`): the same notes
//! and the same query must give the same ordered doc ids on both sides.

use desktop_lib::index::Index;
use desktop_lib::knowledge::{KnowledgeItem, KnowledgePageRequest, KnowledgeQuery};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/contracts/fixtures/knowledge-sort-parity.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn write(vault: &Path, rel: &str, content: &str) {
    let path = vault.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn set_mtime(vault: &Path, rel: &str, ms: i64) {
    let file = fs::File::options().write(true).open(vault.join(rel)).unwrap();
    file.set_modified(UNIX_EPOCH + Duration::from_millis(ms as u64))
        .unwrap();
}

fn notes_query(query: &Value) -> KnowledgeQuery {
    let mut shape = query.clone();
    shape["kind"] = json!("notes");
    serde_json::from_value(shape).unwrap()
}

fn page(limit: u32, cursor: Option<String>) -> KnowledgePageRequest {
    KnowledgePageRequest {
        limit: Some(limit),
        cursor,
    }
}

fn entries(idx: &Index, query: &KnowledgeQuery) -> Vec<(String, Option<i64>, Option<String>)> {
    let mut out = Vec::new();
    let mut cursor = None;
    loop {
        let result = idx.query_knowledge(query, &page(2, cursor)).unwrap();
        for item in result.items {
            match item {
                KnowledgeItem::NoteEntry {
                    note_id,
                    created,
                    created_source,
                    ..
                } => out.push((note_id, created, created_source)),
                other => panic!("unexpected item {other:?}"),
            }
        }
        match result.next_cursor {
            Some(next) => cursor = Some(next),
            None => return out,
        }
    }
}

fn ids(idx: &Index, query: &KnowledgeQuery) -> Vec<String> {
    entries(idx, query).into_iter().map(|(id, ..)| id).collect()
}

/// Materialize the fixture vault: files, mtimes, doc ids and server times.
fn fixture_vault() -> (tempfile::TempDir, Index, Value) {
    let fixture = fixture();
    let vault = tempfile::tempdir().unwrap();
    for note in fixture["notes"].as_array().unwrap() {
        let rel = note["path"].as_str().unwrap();
        write(vault.path(), rel, note["markdown"].as_str().unwrap());
        set_mtime(vault.path(), rel, note["modified"].as_i64().unwrap());
    }
    let idx = Index::open(vault.path()).unwrap();
    idx.rebuild(vault.path()).unwrap();
    let mut server = Vec::new();
    for note in fixture["notes"].as_array().unwrap() {
        let doc_id = note["docId"].as_str().unwrap().to_string();
        assert!(idx
            .rebind_note_id(note["path"].as_str().unwrap(), &doc_id)
            .unwrap());
        let created = note["serverCreatedAt"].as_str().unwrap();
        let ms = desktop_lib::note_times::parse_timestamp(created).unwrap().ms;
        server.push((doc_id, ms));
    }
    idx.record_server_created(&server).unwrap();
    (vault, idx, fixture)
}

#[test]
fn shared_fixture_orders_exactly_like_the_server() {
    let (_vault, idx, fixture) = fixture_vault();
    for case in fixture["cases"].as_array().unwrap() {
        let expected: Vec<String> = case["expected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            ids(&idx, &notes_query(&case["query"])),
            expected,
            "case: {}",
            case["name"]
        );
    }
}

#[test]
fn created_resolution_order_is_frontmatter_then_server_then_birthtime() {
    let vault = tempfile::tempdir().unwrap();
    write(vault.path(), "Both.md", "---\ncreated: 2020-01-02\n---\n");
    write(vault.path(), "Server.md", "plain\n");
    write(vault.path(), "Local.md", "plain\n");
    let idx = Index::open(vault.path()).unwrap();
    idx.rebuild(vault.path()).unwrap();
    for (path, id) in [("Both.md", "both"), ("Server.md", "server"), ("Local.md", "local")] {
        assert!(idx.rebind_note_id(path, id).unwrap());
    }
    idx.record_server_created(&[("both".into(), 5_000), ("server".into(), 7_000)])
        .unwrap();

    let times: std::collections::HashMap<_, _> = idx
        .list_note_times()
        .unwrap()
        .into_iter()
        .map(|note| (note.note_id.clone(), note))
        .collect();
    assert_eq!(times["both"].created, Some(1_577_923_200_000));
    assert_eq!(times["both"].created_source.as_deref(), Some("frontmatter"));
    assert_eq!(times["server"].created, Some(7_000));
    assert_eq!(times["server"].created_source.as_deref(), Some("server"));
    // Birthtime is filesystem-dependent: when the platform has one it is the
    // source, otherwise the note honestly has no `created`.
    match times["local"].created_source.as_deref() {
        Some("birthtime") => assert!(times["local"].created.unwrap() > 1_577_923_200_000),
        None => assert!(times["local"].created.is_none()),
        other => panic!("unexpected source {other:?}"),
    }
    assert!(times["local"].modified.unwrap() > 0);
}

#[test]
fn server_created_survives_rebuild_and_edits() {
    let (vault, idx, _) = fixture_vault();
    let created = |idx: &Index| {
        idx.list_note_times()
            .unwrap()
            .into_iter()
            .find(|note| note.note_id == "n2")
            .unwrap()
    };
    let before = created(&idx);
    assert_eq!(before.created_source.as_deref(), Some("server"));

    // An edit re-indexes the note; a second rebuild re-walks the vault; a
    // brand-new index over the same folder (the `.context` db kept) too.
    write(vault.path(), "beta.md", "---\npriority: 11\n---\nedited\n");
    set_mtime(vault.path(), "beta.md", 1_788_600_000_000);
    idx.rebuild(vault.path()).unwrap();
    assert_eq!(created(&idx).created, before.created);
    drop(idx);
    let reopened = Index::open(vault.path()).unwrap();
    reopened.rebuild(vault.path()).unwrap();
    let after = created(&reopened);
    assert_eq!(after.created, before.created);
    assert_eq!(after.created_source.as_deref(), Some("server"));
    assert_eq!(after.modified, Some(1_788_600_000_000));
}

#[test]
fn a_cursor_is_bound_to_its_sort() {
    let (_vault, idx, _) = fixture_vault();
    let asc = notes_query(&json!({ "sort": { "key": "created", "direction": "asc" } }));
    let desc = notes_query(&json!({ "sort": { "key": "created", "direction": "desc" } }));
    let first = idx.query_knowledge(&asc, &page(2, None)).unwrap();
    let cursor = first.next_cursor.clone().unwrap();
    let replay = idx.query_knowledge(&desc, &page(2, Some(cursor.clone())));
    assert!(replay.unwrap_err().0.starts_with("cursor_expired"));
    let by_name = notes_query(&json!({ "sort": { "key": "name" } }));
    assert!(idx
        .query_knowledge(&by_name, &page(2, Some(cursor.clone())))
        .unwrap_err()
        .0
        .starts_with("cursor_expired"));
    // The same query resumes exactly after the last row.
    let second = idx.query_knowledge(&asc, &page(2, Some(cursor))).unwrap();
    assert_eq!(second.items.len(), 2);

    // A server time changing reorders `created`, so it expires old cursors.
    let cursor = idx
        .query_knowledge(&asc, &page(2, None))
        .unwrap()
        .next_cursor
        .unwrap();
    idx.record_server_created(&[("n3".into(), 1)]).unwrap();
    assert!(idx
        .query_knowledge(&asc, &page(2, Some(cursor.clone())))
        .unwrap_err()
        .0
        .starts_with("cursor_expired"));
    // Recording the same value again is not a change.
    let cursor = idx
        .query_knowledge(&asc, &page(2, None))
        .unwrap()
        .next_cursor
        .unwrap();
    assert_eq!(idx.record_server_created(&[("n3".into(), 1)]).unwrap(), 0);
    assert!(idx.query_knowledge(&asc, &page(2, Some(cursor))).is_ok());
}

#[test]
fn system_properties_are_validated() {
    let (_vault, idx, _) = fixture_vault();
    for predicate in [
        json!({ "propertyId": "created", "op": "contains", "value": "2026" }),
        json!({ "propertyId": "modified", "op": "gt", "value": "not a date" }),
        json!({ "propertyId": "created", "op": "eq", "value": true }),
    ] {
        let query = notes_query(&json!({ "where": [predicate] }));
        let error = idx.query_knowledge(&query, &page(10, None)).unwrap_err();
        assert!(error.0.starts_with("schema_invalid"), "{}", error.0);
    }
}

const CATALOG_WITH_OWN_TYPE: &str = r#"---
noam_kind: knowledge-schema
noam_knowledge_version: 1
---

```json
{"version":1,"properties":[{"id":"kind","key":"type","name":"Kind","type":{"kind":"number","cardinality":"one"}}],"labels":[],"relationships":[{"id":"people","name":"Attendees","cardinality":"many"}]}
```
"#;

#[test]
fn seeded_type_applies_until_the_catalog_defines_it() {
    let vault = tempfile::tempdir().unwrap();
    write(vault.path(), "Note.md", "---\ntype: meeting\n---\n");
    let idx = Index::open(vault.path()).unwrap();
    idx.rebuild(vault.path()).unwrap();
    let id = idx.get_note_meta("Note.md").unwrap().unwrap().id;
    let labels = |idx: &Index| {
        idx.query_knowledge(&KnowledgeQuery::Labels { note_id: id.clone() }, &page(10, None))
            .unwrap()
            .items
    };
    // Default: `type` is a single-valued label.
    assert!(matches!(
        labels(&idx).as_slice(),
        [KnowledgeItem::Label { property_id, label_id, .. }]
            if property_id == "type" && label_id == "meeting"
    ));

    // The catalog note claims the `type` key for its own property: it wins,
    // and the default steps aside entirely (no label, different id).
    write(vault.path(), "_Noam/Knowledge schema.md", CATALOG_WITH_OWN_TYPE);
    idx.index_note(vault.path(), &vault.path().join("_Noam/Knowledge schema.md"))
        .unwrap();
    assert!(labels(&idx).is_empty());
    let properties = idx
        .query_knowledge(&KnowledgeQuery::Properties { note_id: id.clone() }, &page(10, None))
        .unwrap()
        .items;
    assert!(properties.iter().all(|item| matches!(
        item,
        KnowledgeItem::Property { property_id, .. } if property_id == "kind"
    )));
    // Nothing was written into the vault on the default's behalf.
    assert_eq!(
        fs::read_to_string(vault.path().join("_Noam/Knowledge schema.md")).unwrap(),
        CATALOG_WITH_OWN_TYPE
    );
}
