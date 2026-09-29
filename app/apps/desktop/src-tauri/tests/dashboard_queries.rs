//! What dashboards read from the local index: the contract's `traverse` on the
//! `notes` query (relationship filters like `people has [[Paul]]`) and the
//! `note_cards` read that fills a card or a table row without reading a file.

use desktop_lib::index::Index;
use desktop_lib::knowledge::{KnowledgeItem, KnowledgePageRequest, KnowledgeQuery};
use serde_json::json;
use std::fs;
use std::path::Path;

fn write(vault: &Path, rel: &str, content: &str) {
    let path = vault.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn page() -> KnowledgePageRequest {
    KnowledgePageRequest {
        limit: Some(50),
        cursor: None,
    }
}

fn vault() -> (tempfile::TempDir, Index) {
    let vault = tempfile::tempdir().unwrap();
    write(vault.path(), "People/Paul.md", "---\nnoam_document_id: doc-paul\n---\nPaul.\n");
    write(vault.path(), "People/Anna.md", "---\nnoam_document_id: doc-anna\n---\nAnna.\n");
    write(
        vault.path(),
        "Talks/One.md",
        "---\ntype: conversation\nnoam_relationships: [people:doc-paul]\n---\nFirst talk with Paul.\n",
    );
    write(
        vault.path(),
        "Talks/Two.md",
        "---\ntype: conversation\nnoam_relationships: [people:doc-anna, people:doc-paul]\n---\n![](pic.png)\n",
    );
    write(
        vault.path(),
        "Talks/Three.md",
        "---\ntype: meeting\nnoam_relationships: [people:doc-paul]\n---\nA meeting.\n",
    );
    write(
        vault.path(),
        "Talks/Anna only.md",
        "---\ntype: conversation\npriority: 3\ndone: true\nnoam_relationships: [people:doc-anna]\n---\nOnly Anna.\n",
    );
    write(vault.path(), "Empty.md", "");
    let idx = Index::open(vault.path()).unwrap();
    idx.rebuild(vault.path()).unwrap();
    (vault, idx)
}

fn id_of(idx: &Index, path: &str) -> String {
    idx.get_note_meta(path).unwrap().unwrap().id
}

fn paths(idx: &Index, query: serde_json::Value) -> Vec<String> {
    let query: KnowledgeQuery = serde_json::from_value(query).unwrap();
    idx.query_knowledge(&query, &page())
        .unwrap()
        .items
        .into_iter()
        .map(|item| match item {
            KnowledgeItem::NoteEntry { path, .. } => path,
            other => panic!("unexpected {other:?}"),
        })
        .collect()
}

#[test]
fn traverse_incoming_finds_the_notes_that_name_a_person() {
    let (_vault, idx) = vault();
    let paul = id_of(&idx, "People/Paul.md");
    let mut found = paths(
        &idx,
        json!({
            "kind": "notes",
            "traverse": { "fromDocId": paul, "relationshipIds": ["people"], "direction": "incoming", "maxDepth": 1 },
            "sort": { "key": "name", "direction": "asc" }
        }),
    );
    found.sort();
    assert_eq!(found, vec!["Talks/One.md", "Talks/Three.md", "Talks/Two.md"]);

    // ANDed with `where`: conversations with Paul.
    let found = paths(
        &idx,
        json!({
            "kind": "notes",
            "where": [{ "propertyId": "type", "op": "eq", "value": "conversation" }],
            "traverse": { "fromDocId": paul, "relationshipIds": ["people"], "direction": "incoming", "maxDepth": 1 },
            "sort": { "key": "name", "direction": "asc" }
        }),
    );
    assert_eq!(found, vec!["Talks/One.md", "Talks/Two.md"]);
}

#[test]
fn traverse_outgoing_and_unknown_relationships() {
    let (_vault, idx) = vault();
    let two = id_of(&idx, "Talks/Two.md");
    let mut found = paths(
        &idx,
        json!({
            "kind": "notes",
            "traverse": { "fromDocId": two, "relationshipIds": [], "direction": "outgoing", "maxDepth": 1 }
        }),
    );
    found.sort();
    assert_eq!(found, vec!["People/Anna.md", "People/Paul.md"]);

    let found = paths(
        &idx,
        json!({
            "kind": "notes",
            "traverse": { "fromDocId": two, "relationshipIds": ["owner"], "direction": "outgoing", "maxDepth": 1 }
        }),
    );
    assert!(found.is_empty());
}

#[test]
fn traverse_depth_two_walks_through_and_never_returns_the_start() {
    let (_vault, idx) = vault();
    let paul = id_of(&idx, "People/Paul.md");
    // Nothing points INTO One/Two/Three, so a second incoming hop adds nothing;
    // and Paul himself is never a result, however deep the walk.
    let found = paths(
        &idx,
        json!({
            "kind": "notes",
            "traverse": { "fromDocId": paul, "relationshipIds": ["people"], "direction": "incoming", "maxDepth": 2 }
        }),
    );
    assert_eq!(found.len(), 3);
    assert!(!found.contains(&"People/Paul.md".to_string()));
}

#[test]
fn traverse_is_validated() {
    let (_vault, idx) = vault();
    let paul = id_of(&idx, "People/Paul.md");
    let run = |query: serde_json::Value| {
        let query: KnowledgeQuery = serde_json::from_value(query).unwrap();
        idx.query_knowledge(&query, &page()).unwrap_err().0
    };
    assert!(run(json!({
        "kind": "notes",
        "traverse": { "fromDocId": "nope", "relationshipIds": [], "direction": "incoming", "maxDepth": 1 }
    }))
    .starts_with("not_found"));
    assert!(run(json!({
        "kind": "notes",
        "traverse": { "fromDocId": paul, "relationshipIds": [], "direction": "incoming", "maxDepth": 5 }
    }))
    .starts_with("schema_invalid"));
}

#[test]
fn a_query_without_traverse_hashes_as_before() {
    // `traverse` is skipped when absent, so cursors minted before it existed
    // (and by callers that never send it) keep binding to the same query.
    let query: KnowledgeQuery = serde_json::from_value(json!({ "kind": "notes" })).unwrap();
    let encoded = serde_json::to_value(&query).unwrap();
    assert!(encoded.get("traverse").is_none());
}

#[test]
fn note_cards_come_from_the_index_in_the_order_asked() {
    let (_vault, idx) = vault();
    let ids = vec![
        id_of(&idx, "Talks/Anna only.md"),
        "missing".to_string(),
        id_of(&idx, "Talks/Two.md"),
        id_of(&idx, "Empty.md"),
    ];
    let rows = idx.note_cards(&ids).unwrap();
    assert_eq!(rows.len(), 3);

    let anna = &rows[0];
    assert_eq!(anna.path, "Talks/Anna only.md");
    assert_eq!(anna.name, "Anna only");
    assert_eq!(anna.excerpt.as_deref(), Some("Only Anna."));
    assert!(!anna.empty);
    let value = |id: &str| {
        anna.properties
            .iter()
            .filter(|p| p.property_id == id)
            .map(|p| p.text.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(value("type"), vec!["conversation"]);
    assert_eq!(value("priority"), vec!["3"]);
    assert_eq!(value("done"), vec!["true"]);
    assert_eq!(anna.relationships.len(), 1);
    assert_eq!(anna.relationships[0].relationship_id, "people");
    assert_eq!(anna.relationships[0].target_path.as_deref(), Some("People/Anna.md"));

    let two = &rows[1];
    assert_eq!(two.relationships.len(), 2);

    let empty = &rows[2];
    assert!(empty.empty);
    assert!(empty.excerpt.is_none());
}
