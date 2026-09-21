use desktop_lib::index::Index;
use desktop_lib::knowledge::{
    KnowledgeItem, KnowledgePageRequest, KnowledgeQuery, RelationshipDirection,
};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

const CATALOG_NOTE: &str = r#"---
noam_kind: knowledge-schema
noam_knowledge_version: 1
---

```json
{"version":1,"properties":[{"id":"workflow","key":"project_status","name":"Status","type":{"kind":"text","cardinality":"one"}}],"labels":[],"relationships":[]}
```
"#;

fn write(vault: &Path, rel: &str, content: &str) {
    let path = vault.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn page(limit: u32) -> KnowledgePageRequest {
    KnowledgePageRequest {
        limit: Some(limit),
        cursor: None,
    }
}

fn note_id(idx: &Index, path: &str) -> String {
    idx.get_note_meta(path).unwrap().unwrap().id
}

fn property_ids(idx: &Index, path: &str) -> Vec<String> {
    idx.query_knowledge(
        &KnowledgeQuery::Properties {
            note_id: note_id(idx, path),
        },
        &page(50),
    )
    .unwrap()
    .items
    .into_iter()
    .filter_map(|item| match item {
        KnowledgeItem::Property { property_id, .. } => Some(property_id),
        _ => None,
    })
    .collect()
}

fn clean_rebuild_snapshot(vault: &Path) -> Vec<String> {
    let clean = tempfile::tempdir().unwrap();
    for entry in WalkDir::new(vault).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|ext| ext.to_str()) != Some("md")
        {
            continue;
        }
        let rel = entry.path().strip_prefix(vault).unwrap();
        write(
            clean.path(),
            rel.to_str().unwrap(),
            &fs::read_to_string(entry.path()).unwrap(),
        );
    }
    let rebuilt = Index::open(clean.path()).unwrap();
    rebuilt.rebuild(clean.path()).unwrap();
    semantic_snapshot(&rebuilt)
}

#[test]
fn indexes_typed_properties_tags_and_derived_incoming_relationships() {
    let vault = tempfile::tempdir().unwrap();
    write(
        vault.path(),
        "People/Ada.md",
        "---\nnoam_document_id: doc-ada\nstatus: active\ncount: 7\ntrusted: true\ndue: 2026-09-19\ntags: [person, engineer]\n---\n# Ada\n",
    );
    write(
        vault.path(),
        "Projects/Noam.md",
        "---\nnoam_document_id: doc-noam\nnoam_relationships: [owner:doc-ada]\nstatus: building\n---\n# Noam\n",
    );

    let idx = Index::open(vault.path()).unwrap();
    idx.rebuild(vault.path()).unwrap();
    let ada = note_id(&idx, "People/Ada.md");
    let noam = note_id(&idx, "Projects/Noam.md");

    let properties = idx
        .query_knowledge(
            &KnowledgeQuery::Properties {
                note_id: ada.clone(),
            },
            &page(50),
        )
        .unwrap();
    let typed: Vec<(String, String, String)> = properties
        .items
        .into_iter()
        .filter_map(|item| match item {
            KnowledgeItem::Property {
                property_id,
                value_type,
                normalized_value,
                ..
            } => Some((property_id, value_type, normalized_value)),
            _ => None,
        })
        .collect();
    assert!(typed.contains(&("count".into(), "number".into(), "7".into())));
    assert!(typed.contains(&("trusted".into(), "checkbox".into(), "true".into())));
    assert!(typed.contains(&("due".into(), "date".into(), "2026-09-19".into())));
    assert!(!typed.iter().any(|(key, _, _)| key == "noam_document_id"));

    let labels = idx
        .query_knowledge(
            &KnowledgeQuery::Labels {
                note_id: ada.clone(),
            },
            &page(50),
        )
        .unwrap();
    let names: Vec<String> = labels
        .items
        .into_iter()
        .filter_map(|item| match item {
            KnowledgeItem::Label { label_id, .. } => Some(label_id),
            _ => None,
        })
        .collect();
    assert_eq!(names, vec!["engineer", "person"]);

    let number_matches = idx
        .query_knowledge(
            &KnowledgeQuery::PropertyEquals {
                property_id: "count".into(),
                value_type: "number".into(),
                normalized_value: "7".into(),
            },
            &page(50),
        )
        .unwrap();
    assert!(matches!(
        &number_matches.items[0],
        KnowledgeItem::Note { note_id, path }
            if note_id.as_str() == ada.as_str() && path == "People/Ada.md"
    ));

    let engineer_matches = idx
        .query_knowledge(
            &KnowledgeQuery::Labelled {
                label_id: "engineer".into(),
                property_id: Some("tags".into()),
            },
            &page(50),
        )
        .unwrap();
    assert!(matches!(
        &engineer_matches.items[0],
        KnowledgeItem::Note { note_id, path }
            if note_id.as_str() == ada.as_str() && path == "People/Ada.md"
    ));

    let index_state = idx
        .query_knowledge(
            &KnowledgeQuery::IndexState {
                note_id: ada.clone(),
            },
            &page(50),
        )
        .unwrap();
    assert!(matches!(
        &index_state.items[0],
        KnowledgeItem::IndexState {
            identity_status,
            source_revision: Some(source_revision),
            index_revision: Some(index_revision),
            index_status,
            ..
        } if identity_status == "unique"
            && source_revision == index_revision
            && index_status == "current"
    ));

    let outgoing = idx
        .query_knowledge(
            &KnowledgeQuery::Relationships {
                note_id: noam.clone(),
                direction: RelationshipDirection::Outgoing,
                relationship_ids: vec![],
            },
            &page(50),
        )
        .unwrap();
    assert!(matches!(
        &outgoing.items[0],
        KnowledgeItem::Relationship {
            edge_id,
            relationship_id,
            target_note_id: Some(target),
            target_path: Some(path),
            resolution,
            ..
        } if edge_id == "owner:doc-ada" && relationship_id == "owner" && target.as_str() == ada.as_str() && path == "People/Ada.md" && resolution == "resolved"
    ));

    let incoming = idx
        .query_knowledge(
            &KnowledgeQuery::Relationships {
                note_id: ada,
                direction: RelationshipDirection::Incoming,
                relationship_ids: vec!["owner".into()],
            },
            &page(50),
        )
        .unwrap();
    assert!(matches!(
        &incoming.items[0],
        KnowledgeItem::Relationship { source_note_id, .. } if source_note_id.as_str() == noam.as_str()
    ));
}

#[test]
fn duplicate_and_missing_targets_are_recorded_without_guessing_then_repaired_incrementally() {
    let vault = tempfile::tempdir().unwrap();
    write(
        vault.path(),
        "A.md",
        "---\nnoam_document_id: duplicate\n---\n# A\n",
    );
    write(
        vault.path(),
        "B.md",
        "---\nnoam_document_id: duplicate\n---\n# B\n",
    );
    write(
        vault.path(),
        "Source.md",
        "---\nnoam_document_id: source\nnoam_relationships: [owns:duplicate, depends_on:missing]\n---\n# Source\n",
    );
    let idx = Index::open(vault.path()).unwrap();
    idx.rebuild(vault.path()).unwrap();
    let source = note_id(&idx, "Source.md");

    let first = idx
        .query_knowledge(
            &KnowledgeQuery::Relationships {
                note_id: source.clone(),
                direction: RelationshipDirection::Outgoing,
                relationship_ids: vec![],
            },
            &page(50),
        )
        .unwrap();
    let resolutions: Vec<String> = first
        .items
        .into_iter()
        .filter_map(|item| match item {
            KnowledgeItem::Relationship {
                resolution,
                target_note_id,
                ..
            } => {
                assert!(target_note_id.is_none());
                Some(resolution)
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        resolutions,
        vec!["missing_reference", "duplicate_document_identity"]
    );

    write(
        vault.path(),
        "B.md",
        "---\nnoam_document_id: unique-b\n---\n# B\n",
    );
    idx.index_note(vault.path(), &vault.path().join("B.md"))
        .unwrap();
    let repaired = idx
        .query_knowledge(
            &KnowledgeQuery::Relationships {
                note_id: source,
                direction: RelationshipDirection::Outgoing,
                relationship_ids: vec!["owns".into()],
            },
            &page(50),
        )
        .unwrap();
    assert!(matches!(
        &repaired.items[0],
        KnowledgeItem::Relationship {
            target_note_id: Some(_),
            target_path: Some(path),
            resolution,
            ..
        } if path == "A.md" && resolution == "resolved"
    ));
}

#[test]
fn pages_are_capped_and_cursors_expire_when_the_index_generation_changes() {
    let vault = tempfile::tempdir().unwrap();
    write(
        vault.path(),
        "A.md",
        "---\na: one\nb: two\nc: three\n---\n# A\n",
    );
    let idx = Index::open(vault.path()).unwrap();
    idx.rebuild(vault.path()).unwrap();
    let a = note_id(&idx, "A.md");
    let query = KnowledgeQuery::Properties { note_id: a };
    let first = idx.query_knowledge(&query, &page(1)).unwrap();
    assert_eq!(first.items.len(), 1);
    let cursor = first.next_cursor.unwrap();
    let second = idx
        .query_knowledge(
            &query,
            &KnowledgePageRequest {
                limit: Some(1),
                cursor: Some(cursor.clone()),
            },
        )
        .unwrap();
    assert_eq!(second.items.len(), 1);

    write(vault.path(), "B.md", "---\nstatus: new\n---\n# B\n");
    idx.index_note(vault.path(), &vault.path().join("B.md"))
        .unwrap();
    let err = idx
        .query_knowledge(
            &query,
            &KnowledgePageRequest {
                limit: Some(1),
                cursor: Some(cursor),
            },
        )
        .unwrap_err();
    assert!(err.to_string().contains("cursor_expired"));

    let err = idx.query_knowledge(&query, &page(51)).unwrap_err();
    assert!(err.to_string().contains("limit_exceeded"));

    let err = idx
        .query_knowledge(
            &query,
            &KnowledgePageRequest {
                limit: Some(1),
                cursor: Some("x".repeat(8_193)),
            },
        )
        .unwrap_err();
    assert!(err.to_string().contains("cursor_expired"));
}

#[test]
fn catalog_maps_storage_keys_and_label_types_without_dropping_unknown_keys() {
    let vault = tempfile::tempdir().unwrap();
    write(
        vault.path(),
        "A.md",
        "---\nproject_status: in_progress\ntopic_names: [planning, unknown]\nlegacy_key: kept\n---\n# A\n",
    );
    let incremental = Index::open(vault.path()).unwrap();
    incremental.rebuild(vault.path()).unwrap();

    let catalog = r#"---
noam_kind: knowledge-schema
noam_knowledge_version: 1
---

```json
{"version":1,"properties":[{"id":"workflow","key":"project_status","name":"Status","type":{"kind":"label","cardinality":"one"}},{"id":"topics","key":"topic_names","name":"Topics","type":{"kind":"tag","cardinality":"many"}}],"labels":[{"id":"in_progress","name":"In progress"},{"id":"planning","name":"Planning"}],"relationships":[]}
```
"#;
    write(vault.path(), "_Noam/Knowledge schema.md", catalog);
    incremental
        .index_note(
            vault.path(),
            &vault.path().join("_Noam/Knowledge schema.md"),
        )
        .unwrap();

    let a = note_id(&incremental, "A.md");
    let properties = incremental
        .query_knowledge(
            &KnowledgeQuery::Properties { note_id: a.clone() },
            &page(50),
        )
        .unwrap();
    let values: Vec<(String, String)> = properties
        .items
        .into_iter()
        .filter_map(|item| match item {
            KnowledgeItem::Property {
                property_id,
                normalized_value,
                ..
            } => Some((property_id, normalized_value)),
            _ => None,
        })
        .collect();
    assert_eq!(
        values,
        vec![
            ("legacy_key".into(), "kept".into()),
            ("topics".into(), "planning".into()),
            ("topics".into(), "unknown".into()),
            ("workflow".into(), "in_progress".into()),
        ]
    );
    let labels = incremental
        .query_knowledge(&KnowledgeQuery::Labels { note_id: a }, &page(50))
        .unwrap();
    let labels: Vec<(String, String, bool)> = labels
        .items
        .into_iter()
        .filter_map(|item| match item {
            KnowledgeItem::Label {
                property_id,
                label_id,
                is_tag,
                ..
            } => Some((property_id, label_id, is_tag)),
            _ => None,
        })
        .collect();
    assert_eq!(
        labels,
        vec![
            ("topics".into(), "planning".into(), true),
            ("topics".into(), "unknown".into(), true),
            ("workflow".into(), "in_progress".into(), false),
        ]
    );
    let schema = note_id(&incremental, "_Noam/Knowledge schema.md");
    let schema_properties = incremental
        .query_knowledge(
            &KnowledgeQuery::Properties { note_id: schema },
            &page(50),
        )
        .unwrap();
    assert!(
        schema_properties.items.is_empty(),
        "reserved noam_* catalog metadata must not become user properties"
    );

    let incremental_snapshot = semantic_snapshot(&incremental);
    let clean_vault = tempfile::tempdir().unwrap();
    write(
        clean_vault.path(),
        "A.md",
        &fs::read_to_string(vault.path().join("A.md")).unwrap(),
    );
    write(clean_vault.path(), "_Noam/Knowledge schema.md", catalog);
    let rebuilt = Index::open(clean_vault.path()).unwrap();
    rebuilt.rebuild(clean_vault.path()).unwrap();
    assert_eq!(incremental_snapshot, semantic_snapshot(&rebuilt));
}

#[test]
fn moving_catalog_file_away_and_back_refreshes_the_catalog_projection() {
    let vault = tempfile::tempdir().unwrap();
    write(
        vault.path(),
        "A.md",
        "---\nproject_status: Ready\n---\n# A\n",
    );
    write(vault.path(), "_Noam/Knowledge schema.md", CATALOG_NOTE);
    let idx = Index::open(vault.path()).unwrap();
    idx.rebuild(vault.path()).unwrap();
    assert_eq!(property_ids(&idx, "A.md"), vec!["workflow"]);

    let canonical = vault.path().join("_Noam/Knowledge schema.md");
    let moved = vault.path().join("Knowledge schema.md");
    fs::rename(&canonical, &moved).unwrap();
    idx.rename_note(vault.path(), &canonical, &moved).unwrap();
    assert_eq!(property_ids(&idx, "A.md"), vec!["project_status"]);
    assert_eq!(
        semantic_snapshot(&idx),
        clean_rebuild_snapshot(vault.path())
    );

    fs::rename(&moved, &canonical).unwrap();
    idx.rename_note(vault.path(), &moved, &canonical).unwrap();
    assert_eq!(property_ids(&idx, "A.md"), vec!["workflow"]);
    assert_eq!(
        semantic_snapshot(&idx),
        clean_rebuild_snapshot(vault.path())
    );
}

#[test]
fn moving_catalog_directory_away_and_back_refreshes_the_catalog_projection() {
    let vault = tempfile::tempdir().unwrap();
    write(
        vault.path(),
        "A.md",
        "---\nproject_status: Ready\n---\n# A\n",
    );
    write(vault.path(), "_Noam/Knowledge schema.md", CATALOG_NOTE);
    let idx = Index::open(vault.path()).unwrap();
    idx.rebuild(vault.path()).unwrap();
    assert_eq!(property_ids(&idx, "A.md"), vec!["workflow"]);

    let canonical_dir = vault.path().join("_Noam");
    let moved_dir = vault.path().join("Schema");
    fs::rename(&canonical_dir, &moved_dir).unwrap();
    idx.rename_note(vault.path(), &canonical_dir, &moved_dir)
        .unwrap();
    assert_eq!(property_ids(&idx, "A.md"), vec!["project_status"]);
    assert_eq!(
        semantic_snapshot(&idx),
        clean_rebuild_snapshot(vault.path())
    );

    fs::rename(&moved_dir, &canonical_dir).unwrap();
    idx.rename_note(vault.path(), &moved_dir, &canonical_dir)
        .unwrap();
    assert_eq!(property_ids(&idx, "A.md"), vec!["workflow"]);
    assert_eq!(
        semantic_snapshot(&idx),
        clean_rebuild_snapshot(vault.path())
    );
}

#[test]
fn rejects_relationship_and_document_ids_outside_the_portable_codecs() {
    let vault = tempfile::tempdir().unwrap();
    let too_long = format!("d{}", "x".repeat(128));
    write(
        vault.path(),
        "Invalid.md",
        &format!(
            "---\nnoam_document_id: {too_long}\nnoam_relationships: [Owner:target, owner:target:extra, owner:{too_long}, owner:target-ok]\n---\n"
        ),
    );
    let idx = Index::open(vault.path()).unwrap();
    idx.rebuild(vault.path()).unwrap();
    let note = note_id(&idx, "Invalid.md");
    let state = idx
        .query_knowledge(
            &KnowledgeQuery::IndexState {
                note_id: note.clone(),
            },
            &page(50),
        )
        .unwrap();
    assert!(matches!(
        &state.items[0],
        KnowledgeItem::IndexState {
            portable_document_id: None,
            identity_status,
            ..
        } if identity_status == "absent"
    ));
    let relationships = idx
        .query_knowledge(
            &KnowledgeQuery::Relationships {
                note_id: note,
                direction: RelationshipDirection::Outgoing,
                relationship_ids: vec![],
            },
            &page(50),
        )
        .unwrap();
    assert_eq!(relationships.items.len(), 1);
    assert!(matches!(
        &relationships.items[0],
        KnowledgeItem::Relationship {
            relationship_id,
            target_document_id,
            ..
        } if relationship_id == "owner" && target_document_id == "target-ok"
    ));
    let err = idx
        .query_knowledge(
            &KnowledgeQuery::Relationships {
                note_id: note_id(&idx, "Invalid.md"),
                direction: RelationshipDirection::Outgoing,
                relationship_ids: vec!["Owner".into()],
            },
            &page(50),
        )
        .unwrap_err();
    assert!(err.to_string().contains("limit_exceeded"));
}

fn semantic_snapshot(idx: &Index) -> Vec<String> {
    let mut out = Vec::new();
    for meta in idx.list_note_titles().unwrap() {
        let properties = idx
            .query_knowledge(
                &KnowledgeQuery::Properties {
                    note_id: meta.id.clone(),
                },
                &page(50),
            )
            .unwrap();
        for item in properties.items {
            if let KnowledgeItem::Property {
                property_id,
                ordinal,
                value_type,
                normalized_value,
                ..
            } = item
            {
                out.push(format!(
                    "property|{}|{property_id}|{ordinal}|{value_type}|{normalized_value}",
                    meta.path
                ));
            }
        }
        let relationships = idx
            .query_knowledge(
                &KnowledgeQuery::Relationships {
                    note_id: meta.id,
                    direction: RelationshipDirection::Outgoing,
                    relationship_ids: vec![],
                },
                &page(50),
            )
            .unwrap();
        for item in relationships.items {
            if let KnowledgeItem::Relationship {
                relationship_id,
                target_document_id,
                target_path,
                resolution,
                ..
            } = item
            {
                out.push(format!(
                    "relationship|{}|{relationship_id}|{target_document_id}|{}|{resolution}",
                    meta.path,
                    target_path.unwrap_or_default()
                ));
            }
        }
    }
    out.sort();
    out
}

#[test]
fn incremental_index_matches_a_clean_rebuild() {
    let vault = tempfile::tempdir().unwrap();
    write(
        vault.path(),
        "A.md",
        "---\nnoam_document_id: a\nstatus: draft\n---\n# A\n",
    );
    let incremental = Index::open(vault.path()).unwrap();
    incremental.rebuild(vault.path()).unwrap();

    write(
        vault.path(),
        "A.md",
        "---\nnoam_document_id: a\nstatus: ready\ntags: [x]\n---\n# A\n",
    );
    write(
        vault.path(),
        "B.md",
        "---\nnoam_document_id: b\nnoam_relationships: [depends_on:a]\npriority: 2\n---\n# B\n",
    );
    incremental
        .index_notes(
            vault.path(),
            &[vault.path().join("A.md"), vault.path().join("B.md")],
        )
        .unwrap();
    let incremental_snapshot = semantic_snapshot(&incremental);

    let clean_vault = tempfile::tempdir().unwrap();
    fs::copy(vault.path().join("A.md"), clean_vault.path().join("A.md")).unwrap();
    fs::copy(vault.path().join("B.md"), clean_vault.path().join("B.md")).unwrap();
    let rebuilt = Index::open(clean_vault.path()).unwrap();
    rebuilt.rebuild(clean_vault.path()).unwrap();
    let rebuilt_snapshot = semantic_snapshot(&rebuilt);
    assert_eq!(incremental_snapshot, rebuilt_snapshot);
}

#[test]
fn rebuild_backfills_knowledge_rows_for_an_unchanged_legacy_index() {
    let vault = tempfile::tempdir().unwrap();
    write(
        vault.path(),
        "Legacy.md",
        "---\nnoam_document_id: doc-legacy\nstatus: carried-forward\n---\n# Legacy\n",
    );

    let idx = Index::open(vault.path()).unwrap();
    idx.rebuild(vault.path()).unwrap();
    drop(idx);

    let db = rusqlite::Connection::open(vault.path().join(".context/index.sqlite")).unwrap();
    db.execute_batch(
        "DELETE FROM knowledge_relationships;
         DELETE FROM knowledge_labels;
         DELETE FROM knowledge_properties;
         DELETE FROM knowledge_documents;",
    )
    .unwrap();
    drop(db);

    let reopened = Index::open(vault.path()).unwrap();
    reopened.rebuild(vault.path()).unwrap();
    let matches = reopened
        .query_knowledge(
            &KnowledgeQuery::PropertyEquals {
                property_id: "status".into(),
                value_type: "text".into(),
                normalized_value: "carried-forward".into(),
            },
            &page(50),
        )
        .unwrap();
    assert_eq!(matches.items.len(), 1);
}

#[test]
fn rebuild_seeds_catalog_projection_for_an_unchanged_legacy_index() {
    let vault = tempfile::tempdir().unwrap();
    write(
        vault.path(),
        "A.md",
        "---\nproject_status: Ready\n---\n# A\n",
    );
    write(
        vault.path(),
        "_Noam/Knowledge schema.md",
        r#"---
noam_kind: knowledge-schema
noam_knowledge_version: 1
---

```json
{"version":1,"properties":[{"id":"workflow","key":"project_status","name":"Status","type":{"kind":"text","cardinality":"one"}}],"labels":[],"relationships":[]}
```
"#,
    );
    let idx = Index::open(vault.path()).unwrap();
    idx.rebuild(vault.path()).unwrap();
    drop(idx);

    let db = rusqlite::Connection::open(vault.path().join(".context/index.sqlite")).unwrap();
    db.execute("DELETE FROM knowledge_catalog", []).unwrap();
    db.execute(
        "UPDATE knowledge_properties SET property_id = 'project_status'
          WHERE property_id = 'workflow'",
        [],
    )
    .unwrap();
    drop(db);

    let reopened = Index::open(vault.path()).unwrap();
    reopened.rebuild(vault.path()).unwrap();
    let matches = reopened
        .query_knowledge(
            &KnowledgeQuery::PropertyEquals {
                property_id: "workflow".into(),
                value_type: "text".into(),
                normalized_value: "Ready".into(),
            },
            &page(50),
        )
        .unwrap();
    assert_eq!(matches.items.len(), 1);
}
