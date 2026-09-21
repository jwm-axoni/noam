//! Reproducible ignored scale harness for the local knowledge index.
//!
//! Run one size explicitly, for example:
//! `cargo test --test knowledge_index_bench knowledge_index_100k -- --ignored --nocapture`

use desktop_lib::index::Index;
use desktop_lib::knowledge::{KnowledgePageRequest, KnowledgeQuery};
use std::fs;
use std::time::Instant;

fn run(size: usize) {
    let vault = tempfile::tempdir().unwrap();
    let seed_started = Instant::now();
    for i in 0..size {
        let shard = format!("{:03}", i % 1000);
        let dir = vault.path().join(&shard);
        fs::create_dir_all(&dir).unwrap();
        let target = if i == 0 { size - 1 } else { i - 1 };
        fs::write(
            dir.join(format!("note-{i:06}.md")),
            format!(
                "---\nnoam_document_id: doc-{i:06}\nstatus: active\npriority: {}\ntags: [scale, shard-{shard}]\nnoam_relationships: [previous:doc-{target:06}]\n---\n# Note {i}\n",
                i % 5
            ),
        )
        .unwrap();
    }

    let seed_elapsed = seed_started.elapsed();
    let index = Index::open(vault.path()).unwrap();
    let index_started = Instant::now();
    index.rebuild(vault.path()).unwrap();
    let index_elapsed = index_started.elapsed();
    let query_started = Instant::now();
    let result = index
        .query_knowledge(
            &KnowledgeQuery::PropertyEquals {
                property_id: "status".into(),
                value_type: "text".into(),
                normalized_value: "active".into(),
            },
            &KnowledgePageRequest {
                limit: Some(50),
                cursor: None,
            },
        )
        .unwrap();
    println!(
        "notes={size} seed_ms={} rebuild_ms={} first_page_ms={} returned={}",
        seed_elapsed.as_millis(),
        index_elapsed.as_millis(),
        query_started.elapsed().as_millis(),
        result.items.len()
    );
}

#[test]
#[ignore = "manual 10k scale measurement"]
fn knowledge_index_10k() {
    run(10_000);
}

#[test]
#[ignore = "manual 100k scale measurement"]
fn knowledge_index_100k() {
    run(100_000);
}

#[test]
#[ignore = "manual 300k scale measurement"]
fn knowledge_index_300k() {
    run(300_000);
}
