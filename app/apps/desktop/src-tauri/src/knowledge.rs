//! Rebuildable local knowledge index derived from Markdown frontmatter.
//!
//! This module owns the normalized property, label, and named-relationship
//! tables. Callers use one bounded query interface and never read those tables
//! directly. The Markdown file remains canonical.

use crate::error::{AppError, AppResult};
use crate::notefile::sha256_hex;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub const DEFAULT_PAGE_SIZE: u32 = 25;
pub const MAX_PAGE_SIZE: u32 = 50;

const DOCUMENT_ID_KEY: &str = "noam_document_id";
const RELATIONSHIPS_KEY: &str = "noam_relationships";
pub(crate) const KNOWLEDGE_SCHEMA_PATH: &str = "_Noam/Knowledge schema.md";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    version: u8,
    properties: Vec<CatalogProperty>,
    labels: Vec<CatalogLabel>,
    relationships: Vec<CatalogRelationship>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogProperty {
    id: String,
    key: String,
    name: String,
    #[serde(rename = "type")]
    property_type: CatalogPropertyType,
    #[serde(default, rename = "allowedLabelIds")]
    allowed_label_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogPropertyType {
    kind: String,
    cardinality: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogLabel {
    id: String,
    name: String,
    #[serde(default)]
    color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogRelationship {
    id: String,
    name: String,
    cardinality: String,
    #[serde(default, rename = "inverseName")]
    inverse_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgePageRequest {
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

impl Default for KnowledgePageRequest {
    fn default() -> Self {
        Self {
            limit: Some(DEFAULT_PAGE_SIZE),
            cursor: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum KnowledgeQuery {
    Properties {
        note_id: String,
    },
    Labels {
        note_id: String,
    },
    Backlinks {
        note_id: String,
    },
    Relationships {
        note_id: String,
        direction: RelationshipDirection,
        #[serde(default)]
        relationship_ids: Vec<String>,
    },
    PropertyEquals {
        property_id: String,
        value_type: String,
        normalized_value: String,
    },
    Labelled {
        label_id: String,
        property_id: Option<String>,
    },
    IndexState {
        note_id: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RelationshipDirection {
    Outgoing,
    Incoming,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum KnowledgeItem {
    Property {
        note_id: String,
        path: String,
        property_id: String,
        ordinal: i64,
        value_type: String,
        normalized_value: String,
        text_value: Option<String>,
        number_value: Option<f64>,
        boolean_value: Option<bool>,
        raw_json: String,
    },
    Label {
        note_id: String,
        path: String,
        property_id: String,
        label_id: String,
        ordinal: i64,
        is_tag: bool,
    },
    Backlink {
        backlink_id: i64,
        source_note_id: String,
        source_path: String,
        source_title: String,
        link_text: String,
    },
    Relationship {
        edge_id: String,
        relationship_id: String,
        source_note_id: String,
        source_path: String,
        target_document_id: String,
        target_note_id: Option<String>,
        target_path: Option<String>,
        resolution: String,
        ordinal: i64,
    },
    Note {
        note_id: String,
        path: String,
    },
    IndexState {
        note_id: String,
        path: String,
        portable_document_id: Option<String>,
        identity_status: String,
        source_revision: Option<String>,
        index_revision: Option<String>,
        index_status: String,
        generation: i64,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgePage {
    pub items: Vec<KnowledgeItem>,
    pub next_cursor: Option<String>,
    pub generation: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    version: u8,
    generation: i64,
    query_hash: String,
    last: Vec<String>,
}

pub(crate) fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS knowledge_documents (
            note_id               TEXT PRIMARY KEY,
            portable_document_id  TEXT,
            identity_status       TEXT NOT NULL DEFAULT 'absent',
            source_revision       TEXT,
            index_revision        TEXT,
            index_status          TEXT NOT NULL,
            generation            INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_properties (
            note_id           TEXT NOT NULL,
            property_id       TEXT NOT NULL,
            ordinal           INTEGER NOT NULL,
            value_type        TEXT NOT NULL,
            normalized_value  TEXT NOT NULL,
            text_value        TEXT,
            number_value      REAL,
            boolean_value     INTEGER,
            raw_json          TEXT NOT NULL,
            PRIMARY KEY (note_id, property_id, ordinal)
        );

        CREATE TABLE IF NOT EXISTS knowledge_labels (
            note_id      TEXT NOT NULL,
            property_id  TEXT NOT NULL,
            label_id     TEXT NOT NULL,
            ordinal      INTEGER NOT NULL,
            is_tag       INTEGER NOT NULL,
            PRIMARY KEY (note_id, property_id, label_id, ordinal)
        );

        CREATE TABLE IF NOT EXISTS knowledge_relationships (
            source_note_id     TEXT NOT NULL,
            relationship_id    TEXT NOT NULL,
            ordinal            INTEGER NOT NULL,
            target_document_id TEXT NOT NULL,
            target_note_id     TEXT,
            resolution         TEXT NOT NULL,
            PRIMARY KEY (source_note_id, relationship_id, ordinal)
        );

        CREATE TABLE IF NOT EXISTS knowledge_meta (
            key    TEXT PRIMARY KEY,
            value  INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO knowledge_meta (key, value) VALUES ('generation', 0);

        -- The catalog remains an ordinary Markdown note. This disposable row
        -- only caches its validated projection for indexing other notes.
        CREATE TABLE IF NOT EXISTS knowledge_catalog (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            json      TEXT NOT NULL
        );

        -- A short-lived work queue lets one batch repair only relationships whose
        -- source or portable target identity changed. It is emptied before commit.
        CREATE TABLE IF NOT EXISTS knowledge_resolution_queue (
            portable_document_id TEXT PRIMARY KEY
        );

        CREATE INDEX IF NOT EXISTS idx_knowledge_documents_portable
            ON knowledge_documents(portable_document_id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_properties_lookup
            ON knowledge_properties(property_id, value_type, normalized_value, note_id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_labels_lookup
            ON knowledge_labels(label_id, property_id, note_id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_relationships_outgoing
            ON knowledge_relationships(source_note_id, relationship_id, ordinal);
        CREATE INDEX IF NOT EXISTS idx_knowledge_relationships_incoming
            ON knowledge_relationships(target_note_id, relationship_id, source_note_id, ordinal);
        CREATE INDEX IF NOT EXISTS idx_knowledge_relationships_target_identity
            ON knowledge_relationships(target_document_id);
        "#,
    )?;
    Ok(())
}

pub(crate) fn next_generation(conn: &Connection) -> AppResult<i64> {
    conn.execute(
        "UPDATE knowledge_meta SET value = value + 1 WHERE key = 'generation'",
        [],
    )?;
    Ok(conn.query_row(
        "SELECT value FROM knowledge_meta WHERE key = 'generation'",
        [],
        |row| row.get(0),
    )?)
}

fn queue_identity(conn: &Connection, portable_id: Option<&str>) -> AppResult<()> {
    if let Some(value) = portable_id.map(str::trim).filter(|value| !value.is_empty()) {
        conn.execute(
            "INSERT OR IGNORE INTO knowledge_resolution_queue (portable_document_id) VALUES (?1)",
            params![value],
        )?;
    }
    Ok(())
}

fn valid_definition_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

fn valid_catalog_text(value: &str) -> bool {
    !value.is_empty() && value == value.trim()
}

fn valid_document_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn parse_catalog(frontmatter_json: Option<&str>, body: &str) -> Option<Catalog> {
    let frontmatter = serde_json::from_str::<Value>(frontmatter_json?).ok()?;
    if frontmatter.get("noam_kind")?.as_str()? != "knowledge-schema"
        || frontmatter.get("noam_knowledge_version")?.as_u64()? != 1
    {
        return None;
    }
    let body = body.trim();
    let json = body
        .strip_prefix("```json")?
        .trim_start_matches([' ', '\t']);
    let json = json
        .strip_prefix("\r\n")
        .or_else(|| json.strip_prefix('\n'))?;
    let json = json.strip_suffix("```")?.trim_end_matches(['\r', '\n']);
    let catalog = serde_json::from_str::<Catalog>(json).ok()?;
    if catalog.version != 1 {
        return None;
    }
    let mut property_ids = HashSet::new();
    let mut property_keys = HashSet::new();
    let mut label_ids = HashSet::new();
    let mut relationship_ids = HashSet::new();
    for label in &catalog.labels {
        if !valid_definition_id(&label.id)
            || !valid_catalog_text(&label.name)
            || !label_ids.insert(label.id.as_str())
        {
            return None;
        }
        if let Some(color) = &label.color {
            if !valid_catalog_text(color) {
                return None;
            }
            let valid_hex = color.len() == 7
                && color.starts_with('#')
                && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit());
            let valid_name = (1..=32).contains(&color.len())
                && color.as_bytes()[0].is_ascii_lowercase()
                && color.bytes().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'_' | b'-')
                });
            if !valid_hex && !valid_name {
                return None;
            }
        }
    }
    for property in &catalog.properties {
        let kind = property.property_type.kind.as_str();
        let cardinality = property.property_type.cardinality.as_str();
        if !valid_definition_id(&property.id)
            || !valid_catalog_text(&property.key)
            || property.key.contains(['\r', '\n', ':'])
            || matches!(property.key.as_str(), DOCUMENT_ID_KEY | RELATIONSHIPS_KEY)
            || !valid_catalog_text(&property.name)
            || !matches!(
                kind,
                "text"
                    | "number"
                    | "checkbox"
                    | "date"
                    | "datetime"
                    | "url"
                    | "label"
                    | "tag"
                    | "alias"
            )
            || !matches!(cardinality, "one" | "many")
            || (matches!(kind, "number" | "checkbox" | "date" | "datetime" | "url")
                && cardinality != "one")
            || (matches!(kind, "tag" | "alias") && cardinality != "many")
            || !property_ids.insert(property.id.as_str())
            || !property_keys.insert(property.key.as_str())
        {
            return None;
        }
        if let Some(allowed) = &property.allowed_label_ids {
            if !matches!(kind, "label" | "tag") || allowed.iter().any(|id| !valid_definition_id(id))
            {
                return None;
            }
        }
    }
    if catalog.properties.iter().any(|property| {
        property
            .allowed_label_ids
            .as_ref()
            .is_some_and(|ids| ids.iter().any(|id| !label_ids.contains(id.as_str())))
    }) {
        return None;
    }
    for relationship in &catalog.relationships {
        if !valid_definition_id(&relationship.id)
            || !valid_catalog_text(&relationship.name)
            || !matches!(relationship.cardinality.as_str(), "one" | "many")
            || relationship
                .inverse_name
                .as_ref()
                .is_some_and(|name| !valid_catalog_text(name))
            || !relationship_ids.insert(relationship.id.as_str())
        {
            return None;
        }
    }
    Some(catalog)
}

fn stored_catalog(conn: &Connection) -> AppResult<Option<Catalog>> {
    let json: Option<String> = conn
        .query_row(
            "SELECT json FROM knowledge_catalog WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(json.and_then(|value| serde_json::from_str(&value).ok()))
}

pub(crate) fn catalog_projection_ready(conn: &Connection) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM knowledge_catalog WHERE singleton = 1)",
        [],
        |row| row.get(0),
    )?)
}

fn store_catalog(conn: &Connection, catalog: Option<&Catalog>) -> AppResult<()> {
    if let Some(catalog) = catalog {
        conn.execute(
            "INSERT INTO knowledge_catalog (singleton, json) VALUES (1, ?1)
             ON CONFLICT(singleton) DO UPDATE SET json = excluded.json",
            params![serde_json::to_string(catalog)?],
        )?;
    } else {
        conn.execute(
            "INSERT INTO knowledge_catalog (singleton, json) VALUES (1, 'null')
             ON CONFLICT(singleton) DO UPDATE SET json = excluded.json",
            [],
        )?;
    }
    Ok(())
}

pub(crate) fn refresh_catalog(
    conn: &Connection,
    frontmatter_json: Option<&str>,
    body: &str,
) -> AppResult<()> {
    let catalog = parse_catalog(frontmatter_json, body);
    store_catalog(conn, catalog.as_ref())?;
    reproject_all_properties(conn, catalog.as_ref())
}

pub(crate) fn replace_note(
    conn: &Connection,
    note_id: &str,
    rel_path: &str,
    frontmatter_json: Option<&str>,
    body: &str,
    source_revision: &str,
    index_status: &str,
    generation: i64,
) -> AppResult<()> {
    let catalog_changed = rel_path == KNOWLEDGE_SCHEMA_PATH;
    if catalog_changed {
        refresh_catalog(conn, frontmatter_json, body)?;
    }
    let catalog = stored_catalog(conn)?;
    let old_portable: Option<String> = conn
        .query_row(
            "SELECT portable_document_id FROM knowledge_documents WHERE note_id = ?1",
            params![note_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    queue_identity(conn, old_portable.as_deref())?;

    conn.execute(
        "DELETE FROM knowledge_properties WHERE note_id = ?1",
        params![note_id],
    )?;
    conn.execute(
        "DELETE FROM knowledge_labels WHERE note_id = ?1",
        params![note_id],
    )?;
    conn.execute(
        "DELETE FROM knowledge_relationships WHERE source_note_id = ?1",
        params![note_id],
    )?;

    let frontmatter = frontmatter_json
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| value.as_object().cloned());
    let portable_id = frontmatter
        .as_ref()
        .and_then(|map| map.get(DOCUMENT_ID_KEY))
        .and_then(Value::as_str)
        .filter(|value| valid_document_id(value))
        .map(str::to_string);

    conn.execute(
        "INSERT INTO knowledge_documents
           (note_id, portable_document_id, identity_status, source_revision,
            index_revision, index_status, generation)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)
         ON CONFLICT(note_id) DO UPDATE SET
           portable_document_id = excluded.portable_document_id,
           identity_status = excluded.identity_status,
           source_revision = excluded.source_revision,
           index_revision = excluded.index_revision,
           index_status = excluded.index_status,
           generation = excluded.generation",
        params![
            note_id,
            portable_id,
            if portable_id.is_some() {
                "pending"
            } else {
                "absent"
            },
            source_revision,
            index_status,
            generation
        ],
    )?;
    queue_identity(conn, portable_id.as_deref())?;

    let Some(map) = frontmatter else {
        return Ok(());
    };

    if !catalog_changed {
        index_frontmatter_properties(conn, note_id, &map, catalog.as_ref())?;
    }

    if let Some(value) = map.get(RELATIONSHIPS_KEY) {
        let members: Vec<&Value> = match value {
            Value::Array(values) => values.iter().collect(),
            scalar => vec![scalar],
        };
        for (ordinal, member) in members.into_iter().enumerate() {
            let Some(raw) = member.as_str() else { continue };
            let Some((relationship_id, target_document_id)) = raw.split_once(':') else {
                continue;
            };
            if !valid_definition_id(relationship_id) || !valid_document_id(target_document_id) {
                continue;
            }
            conn.execute(
                "INSERT INTO knowledge_relationships
                   (source_note_id, relationship_id, ordinal, target_document_id,
                    target_note_id, resolution)
                 VALUES (?1, ?2, ?3, ?4, NULL, 'missing_reference')",
                params![note_id, relationship_id, ordinal as i64, target_document_id],
            )?;
            queue_identity(conn, Some(target_document_id))?;
        }
    }
    Ok(())
}

pub(crate) fn mark_skipped(
    conn: &Connection,
    note_id: &str,
    index_status: &str,
    generation: i64,
) -> AppResult<()> {
    let old_portable: Option<String> = conn
        .query_row(
            "SELECT portable_document_id FROM knowledge_documents WHERE note_id = ?1",
            params![note_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    queue_identity(conn, old_portable.as_deref())?;
    conn.execute(
        "DELETE FROM knowledge_properties WHERE note_id = ?1",
        params![note_id],
    )?;
    conn.execute(
        "DELETE FROM knowledge_labels WHERE note_id = ?1",
        params![note_id],
    )?;
    conn.execute(
        "DELETE FROM knowledge_relationships WHERE source_note_id = ?1",
        params![note_id],
    )?;
    conn.execute(
        "INSERT INTO knowledge_documents
           (note_id, portable_document_id, identity_status, source_revision,
            index_revision, index_status, generation)
         VALUES (?1, NULL, 'absent', NULL, NULL, ?2, ?3)
         ON CONFLICT(note_id) DO UPDATE SET
           portable_document_id = NULL,
           identity_status = 'absent',
           source_revision = NULL,
           index_revision = NULL,
           index_status = excluded.index_status,
           generation = excluded.generation",
        params![note_id, index_status, generation],
    )?;
    Ok(())
}

pub(crate) fn remove_note(conn: &Connection, note_id: &str) -> AppResult<()> {
    let removed_catalog = conn
        .query_row(
            "SELECT path = ?2 FROM notes WHERE id = ?1",
            params![note_id, KNOWLEDGE_SCHEMA_PATH],
            |row| row.get::<_, bool>(0),
        )
        .optional()?
        .unwrap_or(false);
    let portable: Option<String> = conn
        .query_row(
            "SELECT portable_document_id FROM knowledge_documents WHERE note_id = ?1",
            params![note_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    queue_identity(conn, portable.as_deref())?;
    conn.execute(
        "DELETE FROM knowledge_properties WHERE note_id = ?1",
        params![note_id],
    )?;
    conn.execute(
        "DELETE FROM knowledge_labels WHERE note_id = ?1",
        params![note_id],
    )?;
    conn.execute(
        "DELETE FROM knowledge_relationships WHERE source_note_id = ?1",
        params![note_id],
    )?;
    conn.execute(
        "UPDATE knowledge_relationships
            SET target_note_id = NULL, resolution = 'missing_reference'
          WHERE target_note_id = ?1",
        params![note_id],
    )?;
    conn.execute(
        "DELETE FROM knowledge_documents WHERE note_id = ?1",
        params![note_id],
    )?;
    if removed_catalog {
        store_catalog(conn, None)?;
        reproject_all_properties(conn, None)?;
        conn.execute(
            "DELETE FROM knowledge_properties WHERE note_id = ?1",
            params![note_id],
        )?;
        conn.execute(
            "DELETE FROM knowledge_labels WHERE note_id = ?1",
            params![note_id],
        )?;
    }
    Ok(())
}

pub(crate) fn rebind_note(conn: &Connection, old_id: &str, new_id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE knowledge_documents SET note_id = ?1 WHERE note_id = ?2",
        params![new_id, old_id],
    )?;
    conn.execute(
        "UPDATE knowledge_properties SET note_id = ?1 WHERE note_id = ?2",
        params![new_id, old_id],
    )?;
    conn.execute(
        "UPDATE knowledge_labels SET note_id = ?1 WHERE note_id = ?2",
        params![new_id, old_id],
    )?;
    conn.execute(
        "UPDATE knowledge_relationships SET source_note_id = ?1 WHERE source_note_id = ?2",
        params![new_id, old_id],
    )?;
    conn.execute(
        "UPDATE knowledge_relationships SET target_note_id = ?1 WHERE target_note_id = ?2",
        params![new_id, old_id],
    )?;
    Ok(())
}

pub(crate) fn resolve_queued_relationships(conn: &Connection) -> AppResult<()> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT portable_document_id FROM knowledge_resolution_queue ORDER BY portable_document_id",
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    for portable_id in ids {
        let note_ids: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT note_id FROM knowledge_documents
                  WHERE portable_document_id = ?1 ORDER BY note_id",
            )?;
            let rows = stmt.query_map(params![portable_id], |row| row.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let identity_status = match note_ids.len() {
            0 => "absent",
            1 => "unique",
            _ => "duplicate_document_identity",
        };
        conn.execute(
            "UPDATE knowledge_documents SET identity_status = ?1
              WHERE portable_document_id = ?2",
            params![identity_status, portable_id],
        )?;
        match note_ids.as_slice() {
            [target] => {
                conn.execute(
                    "UPDATE knowledge_relationships
                        SET target_note_id = ?1, resolution = 'resolved'
                      WHERE target_document_id = ?2",
                    params![target, portable_id],
                )?;
            }
            [] => {
                conn.execute(
                    "UPDATE knowledge_relationships
                        SET target_note_id = NULL, resolution = 'missing_reference'
                      WHERE target_document_id = ?1",
                    params![portable_id],
                )?;
            }
            _ => {
                conn.execute(
                    "UPDATE knowledge_relationships
                        SET target_note_id = NULL,
                            resolution = 'duplicate_document_identity'
                      WHERE target_document_id = ?1",
                    params![portable_id],
                )?;
            }
        }
    }
    conn.execute("DELETE FROM knowledge_resolution_queue", [])?;
    Ok(())
}

fn index_frontmatter_properties(
    conn: &Connection,
    note_id: &str,
    map: &serde_json::Map<String, Value>,
    catalog: Option<&Catalog>,
) -> AppResult<()> {
    for (storage_key, value) in map {
        if storage_key.starts_with("noam_") {
            continue;
        }
        let definition = catalog.and_then(|catalog| {
            catalog
                .properties
                .iter()
                .find(|definition| definition.key == *storage_key)
        });
        index_property(conn, note_id, storage_key, definition, value)?;
        let label_kind = definition
            .map(|definition| definition.property_type.kind.as_str())
            .filter(|kind| matches!(*kind, "label" | "tag"));
        let legacy_tag = definition.is_none() && storage_key.eq_ignore_ascii_case("tags");
        if label_kind.is_some() || legacy_tag {
            index_labels(
                conn,
                note_id,
                definition
                    .map(|value| value.id.as_str())
                    .unwrap_or(storage_key),
                value,
                label_kind == Some("tag") || legacy_tag,
                legacy_tag,
                catalog,
            )?;
        }
    }
    Ok(())
}

fn reproject_all_properties(conn: &Connection, catalog: Option<&Catalog>) -> AppResult<()> {
    conn.execute("DELETE FROM knowledge_properties", [])?;
    conn.execute("DELETE FROM knowledge_labels", [])?;
    let rows: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, frontmatter FROM notes WHERE frontmatter IS NOT NULL ORDER BY id",
        )?;
        let values = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        values.collect::<Result<Vec<_>, _>>()?
    };
    for (note_id, raw) in rows {
        let Some(map) = serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|value| value.as_object().cloned())
        else {
            continue;
        };
        index_frontmatter_properties(conn, &note_id, &map, catalog)?;
    }
    Ok(())
}

fn index_property(
    conn: &Connection,
    note_id: &str,
    storage_key: &str,
    definition: Option<&CatalogProperty>,
    value: &Value,
) -> AppResult<()> {
    let property_id = definition
        .map(|definition| definition.id.as_str())
        .unwrap_or(storage_key);
    match value {
        Value::Array(values) if values.is_empty() => {
            insert_property(
                conn,
                note_id,
                property_id,
                definition,
                0,
                &Value::Array(Vec::new()),
            )?;
        }
        Value::Array(values) => {
            for (ordinal, member) in values.iter().enumerate() {
                insert_property(
                    conn,
                    note_id,
                    property_id,
                    definition,
                    ordinal as i64,
                    member,
                )?;
            }
        }
        scalar => insert_property(conn, note_id, property_id, definition, 0, scalar)?,
    }
    Ok(())
}

fn insert_property(
    conn: &Connection,
    note_id: &str,
    property_id: &str,
    definition: Option<&CatalogProperty>,
    ordinal: i64,
    value: &Value,
) -> AppResult<()> {
    let (value_type, normalized, text, number, boolean) = normalized_value(
        value,
        definition.map(|value| value.property_type.kind.as_str()),
    );
    conn.execute(
        "INSERT INTO knowledge_properties
           (note_id, property_id, ordinal, value_type, normalized_value,
            text_value, number_value, boolean_value, raw_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            note_id,
            property_id,
            ordinal,
            value_type,
            normalized,
            text,
            number,
            boolean.map(i64::from),
            serde_json::to_string(value)?
        ],
    )?;
    Ok(())
}

fn normalized_value(
    value: &Value,
    declared_kind: Option<&str>,
) -> (
    &'static str,
    String,
    Option<String>,
    Option<f64>,
    Option<bool>,
) {
    match (declared_kind, value) {
        (Some("number"), Value::Number(value)) => {
            let normalized = value.to_string();
            return ("number", normalized, None, value.as_f64(), None);
        }
        (Some("checkbox"), Value::Bool(value)) => {
            return ("checkbox", value.to_string(), None, None, Some(*value));
        }
        (Some("date"), Value::String(value)) => {
            return ("date", value.clone(), Some(value.clone()), None, None);
        }
        (Some("datetime"), Value::String(value)) => {
            return ("datetime", value.clone(), Some(value.clone()), None, None);
        }
        (Some("text" | "url" | "label" | "tag" | "alias"), Value::String(value)) => {
            return ("text", value.clone(), Some(value.clone()), None, None)
        }
        _ => {}
    }
    match value {
        Value::Null => ("null", String::new(), None, None, None),
        Value::Bool(value) => ("checkbox", value.to_string(), None, None, Some(*value)),
        Value::Number(value) => {
            let normalized = value.to_string();
            ("number", normalized, None, value.as_f64(), None)
        }
        Value::String(value) => {
            let value_type = if is_date(value) {
                "date"
            } else if is_datetime(value) {
                "datetime"
            } else {
                "text"
            };
            (value_type, value.clone(), Some(value.clone()), None, None)
        }
        Value::Array(_) => (
            "list",
            serde_json::to_string(value).unwrap_or_default(),
            None,
            None,
            None,
        ),
        Value::Object(_) => (
            "raw",
            serde_json::to_string(value).unwrap_or_default(),
            None,
            None,
            None,
        ),
    }
}

fn is_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(idx, byte)| idx == 4 || idx == 7 || byte.is_ascii_digit())
}

fn is_datetime(value: &str) -> bool {
    value.len() >= 16
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && matches!(value.as_bytes().get(10), Some(b'T' | b' '))
        && value.as_bytes().get(13) == Some(&b':')
}

fn index_labels(
    conn: &Connection,
    note_id: &str,
    property_id: &str,
    value: &Value,
    is_tag: bool,
    split_scalar: bool,
    catalog: Option<&Catalog>,
) -> AppResult<()> {
    let mut labels = Vec::new();
    match value {
        Value::Array(values) => {
            labels.extend(values.iter().filter_map(Value::as_str).map(str::to_string));
        }
        Value::String(value) => {
            if split_scalar {
                labels.extend(value.split([',', ' ']).map(str::to_string));
            } else {
                labels.push(value.clone());
            }
        }
        _ => {}
    }
    for (ordinal, raw) in labels.into_iter().enumerate() {
        let raw_label = raw.trim().trim_start_matches('#');
        let label = catalog
            .and_then(|catalog| catalog.labels.iter().find(|candidate| candidate.id == raw_label))
            .map(|definition| definition.id.as_str())
            .unwrap_or(raw_label);
        if label.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO knowledge_labels
               (note_id, property_id, label_id, ordinal, is_tag)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                note_id,
                property_id,
                label,
                ordinal as i64,
                i64::from(is_tag)
            ],
        )?;
    }
    Ok(())
}

pub(crate) fn query(
    conn: &Connection,
    query: &KnowledgeQuery,
    page: &KnowledgePageRequest,
) -> AppResult<KnowledgePage> {
    let generation: i64 = conn.query_row(
        "SELECT value FROM knowledge_meta WHERE key = 'generation'",
        [],
        |row| row.get(0),
    )?;
    let limit = page.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    if limit == 0 || limit > MAX_PAGE_SIZE {
        return Err(AppError::new(format!(
            "limit_exceeded: knowledge query limit must be between 1 and {MAX_PAGE_SIZE}"
        )));
    }
    if page
        .cursor
        .as_ref()
        .is_some_and(|cursor| cursor.len() > 8_192)
    {
        return Err(AppError::new("cursor_expired: invalid knowledge cursor"));
    }
    if let KnowledgeQuery::Relationships {
        relationship_ids, ..
    } = query
    {
        if relationship_ids.len() > MAX_PAGE_SIZE as usize
            || relationship_ids.iter().any(|id| !valid_definition_id(id))
        {
            return Err(AppError::new(
                "limit_exceeded: relationship filters must contain at most 50 valid ids",
            ));
        }
    }
    let query_json = serde_json::to_string(query)?;
    let query_hash = sha256_hex(&query_json);
    let last = decode_cursor(page.cursor.as_deref(), generation, &query_hash)?;
    let (mut items, keys) = match query {
        KnowledgeQuery::Properties { note_id } => {
            query_properties(conn, note_id, &last, limit + 1)?
        }
        KnowledgeQuery::Labels { note_id } => query_labels(conn, note_id, &last, limit + 1)?,
        KnowledgeQuery::Backlinks { note_id } => {
            query_backlinks(conn, note_id, &last, limit + 1)?
        }
        KnowledgeQuery::Relationships {
            note_id,
            direction,
            relationship_ids,
        } => query_relationships(
            conn,
            note_id,
            *direction,
            relationship_ids,
            &last,
            limit + 1,
        )?,
        KnowledgeQuery::PropertyEquals {
            property_id,
            value_type,
            normalized_value,
        } => query_property_equals(
            conn,
            property_id,
            value_type,
            normalized_value,
            &last,
            limit + 1,
        )?,
        KnowledgeQuery::Labelled {
            label_id,
            property_id,
        } => query_labelled(conn, label_id, property_id.as_deref(), &last, limit + 1)?,
        KnowledgeQuery::IndexState { note_id } => {
            query_index_state(conn, note_id, &last, limit + 1)?
        }
    };

    let has_more = items.len() > limit as usize;
    if has_more {
        items.truncate(limit as usize);
    }
    let next_cursor = if has_more {
        let last_key = keys.get(limit as usize - 1).cloned().ok_or_else(|| {
            AppError::new("temporarily_unavailable: missing knowledge cursor key")
        })?;
        Some(serde_json::to_string(&Cursor {
            version: 1,
            generation,
            query_hash,
            last: last_key,
        })?)
    } else {
        None
    };
    Ok(KnowledgePage {
        items,
        next_cursor,
        generation,
    })
}

fn decode_cursor(raw: Option<&str>, generation: i64, query_hash: &str) -> AppResult<Vec<String>> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let cursor: Cursor = serde_json::from_str(raw)
        .map_err(|_| AppError::new("cursor_expired: invalid knowledge cursor"))?;
    if cursor.version != 1 || cursor.generation != generation || cursor.query_hash != query_hash {
        return Err(AppError::new("cursor_expired: knowledge index changed"));
    }
    Ok(cursor.last)
}

type QueryRows = (Vec<KnowledgeItem>, Vec<Vec<String>>);

fn query_properties(
    conn: &Connection,
    note_id: &str,
    last: &[String],
    limit: u32,
) -> AppResult<QueryRows> {
    let last_property = last.first().map(String::as_str).unwrap_or("");
    let last_ordinal = last
        .get(1)
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    let mut stmt = conn.prepare(
        "SELECT p.note_id, n.path, p.property_id, p.ordinal, p.value_type,
                p.normalized_value, p.text_value, p.number_value, p.boolean_value, p.raw_json
           FROM knowledge_properties p JOIN notes n ON n.id = p.note_id
          WHERE p.note_id = ?1
            AND (p.property_id > ?2 OR (p.property_id = ?2 AND p.ordinal > ?3))
          ORDER BY p.property_id, p.ordinal LIMIT ?4",
    )?;
    let rows = stmt.query_map(
        params![note_id, last_property, last_ordinal, limit],
        |row| {
            let property_id: String = row.get(2)?;
            let ordinal: i64 = row.get(3)?;
            let boolean: Option<i64> = row.get(8)?;
            Ok((
                KnowledgeItem::Property {
                    note_id: row.get(0)?,
                    path: row.get(1)?,
                    property_id: property_id.clone(),
                    ordinal,
                    value_type: row.get(4)?,
                    normalized_value: row.get(5)?,
                    text_value: row.get(6)?,
                    number_value: row.get(7)?,
                    boolean_value: boolean.map(|value| value != 0),
                    raw_json: row.get(9)?,
                },
                vec![property_id, ordinal.to_string()],
            ))
        },
    )?;
    collect_rows(rows)
}

fn query_labels(
    conn: &Connection,
    note_id: &str,
    last: &[String],
    limit: u32,
) -> AppResult<QueryRows> {
    let a = last.first().map(String::as_str).unwrap_or("");
    let b = last.get(1).map(String::as_str).unwrap_or("");
    let c = last
        .get(2)
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    let mut stmt = conn.prepare(
        "SELECT l.note_id, n.path, l.property_id, l.label_id, l.ordinal, l.is_tag
           FROM knowledge_labels l JOIN notes n ON n.id = l.note_id
          WHERE l.note_id = ?1 AND
            (l.property_id > ?2 OR (l.property_id = ?2 AND l.label_id > ?3) OR
             (l.property_id = ?2 AND l.label_id = ?3 AND l.ordinal > ?4))
          ORDER BY l.property_id, l.label_id, l.ordinal LIMIT ?5",
    )?;
    let rows = stmt.query_map(params![note_id, a, b, c, limit], |row| {
        let property_id: String = row.get(2)?;
        let label_id: String = row.get(3)?;
        let ordinal: i64 = row.get(4)?;
        Ok((
            KnowledgeItem::Label {
                note_id: row.get(0)?,
                path: row.get(1)?,
                property_id: property_id.clone(),
                label_id: label_id.clone(),
                ordinal,
                is_tag: row.get::<_, i64>(5)? != 0,
            },
            vec![property_id, label_id, ordinal.to_string()],
        ))
    })?;
    collect_rows(rows)
}

fn query_backlinks(
    conn: &Connection,
    note_id: &str,
    last: &[String],
    limit: u32,
) -> AppResult<QueryRows> {
    let title = last.first().map(String::as_str).unwrap_or("");
    let source = last.get(1).map(String::as_str).unwrap_or("");
    let link_id = last
        .get(2)
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    let mut stmt = conn.prepare(
        "SELECT l.id, n.id, n.path, n.title, COALESCE(l.link_text, '')
           FROM links l JOIN notes n ON n.id = l.src_note_id
          WHERE l.dst_note_id = ?1 AND
            (n.title > ?2 OR (n.title = ?2 AND n.id > ?3) OR
             (n.title = ?2 AND n.id = ?3 AND l.id > ?4))
          ORDER BY n.title, n.id, l.id LIMIT ?5",
    )?;
    let rows = stmt.query_map(params![note_id, title, source, link_id, limit], |row| {
        let backlink_id: i64 = row.get(0)?;
        let source_note_id: String = row.get(1)?;
        let source_title: String = row.get(3)?;
        Ok((
            KnowledgeItem::Backlink {
                backlink_id,
                source_note_id: source_note_id.clone(),
                source_path: row.get(2)?,
                source_title: source_title.clone(),
                link_text: row.get(4)?,
            },
            vec![source_title, source_note_id, backlink_id.to_string()],
        ))
    })?;
    collect_rows(rows)
}

fn query_relationships(
    conn: &Connection,
    note_id: &str,
    direction: RelationshipDirection,
    relationship_ids: &[String],
    last: &[String],
    limit: u32,
) -> AppResult<QueryRows> {
    let relationship = last.first().map(String::as_str).unwrap_or("");
    let source = last.get(1).map(String::as_str).unwrap_or("");
    let ordinal = last
        .get(2)
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(-1);
    let mut sql = String::from(
        "SELECT r.source_note_id, src.path, r.relationship_id, r.ordinal,
                r.target_document_id, r.target_note_id, dst.path, r.resolution
           FROM knowledge_relationships r
           JOIN notes src ON src.id = r.source_note_id
           LEFT JOIN notes dst ON dst.id = r.target_note_id WHERE ",
    );
    match direction {
        RelationshipDirection::Outgoing => sql.push_str("r.source_note_id = ?1"),
        RelationshipDirection::Incoming => sql.push_str("r.target_note_id = ?1"),
    }
    let mut values = vec![rusqlite::types::Value::Text(note_id.to_string())];
    if !relationship_ids.is_empty() {
        sql.push_str(" AND r.relationship_id IN (");
        sql.push_str(&vec!["?"; relationship_ids.len()].join(","));
        sql.push(')');
        values.extend(
            relationship_ids
                .iter()
                .cloned()
                .map(rusqlite::types::Value::Text),
        );
    }
    sql.push_str(" AND (r.relationship_id > ? OR (r.relationship_id = ? AND r.source_note_id > ?) OR (r.relationship_id = ? AND r.source_note_id = ? AND r.ordinal > ?)) ORDER BY r.relationship_id, r.source_note_id, r.ordinal LIMIT ?");
    values.push(rusqlite::types::Value::Text(relationship.to_string()));
    values.push(rusqlite::types::Value::Text(relationship.to_string()));
    values.push(rusqlite::types::Value::Text(source.to_string()));
    values.push(rusqlite::types::Value::Text(relationship.to_string()));
    values.push(rusqlite::types::Value::Text(source.to_string()));
    values.push(rusqlite::types::Value::Integer(ordinal));
    values.push(rusqlite::types::Value::Integer(limit as i64));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(values), |row| {
        let source_note_id: String = row.get(0)?;
        let relationship_id: String = row.get(2)?;
        let ordinal: i64 = row.get(3)?;
        let target_document_id: String = row.get(4)?;
        Ok((
            KnowledgeItem::Relationship {
                edge_id: format!("{relationship_id}:{target_document_id}"),
                relationship_id: relationship_id.clone(),
                source_note_id: source_note_id.clone(),
                source_path: row.get(1)?,
                target_document_id,
                target_note_id: row.get(5)?,
                target_path: row.get(6)?,
                resolution: row.get(7)?,
                ordinal,
            },
            vec![relationship_id, source_note_id, ordinal.to_string()],
        ))
    })?;
    collect_rows(rows)
}

fn query_property_equals(
    conn: &Connection,
    property_id: &str,
    value_type: &str,
    normalized_value: &str,
    last: &[String],
    limit: u32,
) -> AppResult<QueryRows> {
    let after = last.first().map(String::as_str).unwrap_or("");
    let mut stmt = conn.prepare(
        "SELECT DISTINCT p.note_id, n.path
           FROM knowledge_properties p JOIN notes n ON n.id = p.note_id
          WHERE p.property_id = ?1 AND p.value_type = ?2 AND p.normalized_value = ?3
            AND p.note_id > ?4 ORDER BY p.note_id LIMIT ?5",
    )?;
    let rows = stmt.query_map(
        params![property_id, value_type, normalized_value, after, limit],
        |row| {
            let note_id: String = row.get(0)?;
            Ok((
                KnowledgeItem::Note {
                    note_id: note_id.clone(),
                    path: row.get(1)?,
                },
                vec![note_id],
            ))
        },
    )?;
    collect_rows(rows)
}

fn query_labelled(
    conn: &Connection,
    label_id: &str,
    property_id: Option<&str>,
    last: &[String],
    limit: u32,
) -> AppResult<QueryRows> {
    let after = last.first().map(String::as_str).unwrap_or("");
    let mut stmt = conn.prepare(
        "SELECT DISTINCT l.note_id, n.path
           FROM knowledge_labels l JOIN notes n ON n.id = l.note_id
          WHERE l.label_id = ?1 AND (?2 IS NULL OR l.property_id = ?2)
            AND l.note_id > ?3 ORDER BY l.note_id LIMIT ?4",
    )?;
    let rows = stmt.query_map(params![label_id, property_id, after, limit], |row| {
        let note_id: String = row.get(0)?;
        Ok((
            KnowledgeItem::Note {
                note_id: note_id.clone(),
                path: row.get(1)?,
            },
            vec![note_id],
        ))
    })?;
    collect_rows(rows)
}

fn query_index_state(
    conn: &Connection,
    note_id: &str,
    last: &[String],
    limit: u32,
) -> AppResult<QueryRows> {
    if !last.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let mut stmt = conn.prepare(
        "SELECT d.note_id, n.path, d.portable_document_id, d.identity_status,
                d.source_revision, d.index_revision, d.index_status, d.generation
           FROM knowledge_documents d JOIN notes n ON n.id = d.note_id
          WHERE d.note_id = ?1 LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![note_id, limit], |row| {
        let id: String = row.get(0)?;
        Ok((
            KnowledgeItem::IndexState {
                note_id: id.clone(),
                path: row.get(1)?,
                portable_document_id: row.get(2)?,
                identity_status: row.get(3)?,
                source_revision: row.get(4)?,
                index_revision: row.get(5)?,
                index_status: row.get(6)?,
                generation: row.get(7)?,
            },
            vec![id],
        ))
    })?;
    collect_rows(rows)
}

fn collect_rows<T>(rows: rusqlite::MappedRows<'_, T>) -> AppResult<QueryRows>
where
    T: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<(KnowledgeItem, Vec<String>)>,
{
    let pairs = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(pairs.into_iter().unzip())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn date_classification_is_strict_enough_for_indexing() {
        assert!(is_date("2026-09-19"));
        assert!(!is_date("2026-9-19"));
        assert!(is_datetime("2026-09-19T12:34:00Z"));
        assert!(!is_datetime("tomorrow"));
    }

    #[test]
    fn catalog_rejects_surrounding_whitespace_consistently() {
        let frontmatter = json!({
            "noam_kind": "knowledge-schema",
            "noam_knowledge_version": 1
        })
        .to_string();
        let base = json!({
            "version": 1,
            "properties": [{
                "id": "workflow",
                "key": "project_status",
                "name": "Status",
                "type": { "kind": "label", "cardinality": "one" },
                "allowedLabelIds": ["active"]
            }],
            "labels": [{ "id": "active", "name": "Active", "color": "blue" }],
            "relationships": [{
                "id": "parent",
                "name": "Parent",
                "cardinality": "one",
                "inverseName": "Child"
            }]
        });
        let invalid = [
            ("/properties/0/id", " workflow "),
            ("/properties/0/key", " project_status "),
            ("/properties/0/name", " Status "),
            ("/properties/0/type/kind", " label "),
            ("/labels/0/id", " active "),
            ("/labels/0/name", " Active "),
            ("/labels/0/color", " blue "),
            ("/relationships/0/id", " parent "),
            ("/relationships/0/name", " Parent "),
            ("/relationships/0/inverseName", " Child "),
        ];
        for (pointer, padded) in invalid {
            let mut catalog = base.clone();
            *catalog.pointer_mut(pointer).unwrap() = json!(padded);
            let body = format!("```json\n{}\n```", catalog);
            assert!(
                parse_catalog(Some(&frontmatter), &body).is_none(),
                "accepted surrounding whitespace at {pointer}"
            );
        }
    }

    #[test]
    fn ipc_contract_uses_camel_case_for_variant_fields() {
        let query: KnowledgeQuery = serde_json::from_value(json!({
            "kind": "relationships",
            "noteId": "note-a",
            "direction": "incoming",
            "relationshipIds": ["owner"]
        }))
        .unwrap();
        assert_eq!(
            query,
            KnowledgeQuery::Relationships {
                note_id: "note-a".into(),
                direction: RelationshipDirection::Incoming,
                relationship_ids: vec!["owner".into()],
            }
        );

        let item = KnowledgeItem::Relationship {
            edge_id: "edge-a".into(),
            relationship_id: "owner".into(),
            source_note_id: "note-a".into(),
            source_path: "A.md".into(),
            target_document_id: "doc-b".into(),
            target_note_id: Some("note-b".into()),
            target_path: Some("B.md".into()),
            resolution: "resolved".into(),
            ordinal: 0,
        };
        let encoded = serde_json::to_value(item).unwrap();
        assert_eq!(encoded["sourceNoteId"], "note-a");
        assert_eq!(encoded["targetDocumentId"], "doc-b");
        assert!(encoded.get("source_note_id").is_none());
    }

    #[test]
    fn backlink_queries_page_without_claiming_the_first_fifty_are_complete() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL);
             CREATE TABLE links (
               id INTEGER PRIMARY KEY,
               src_note_id TEXT NOT NULL,
               dst_note_id TEXT,
               link_text TEXT
             );",
        )
        .unwrap();
        migrate(&conn).unwrap();
        conn.execute("INSERT INTO notes VALUES ('target', 'Target.md', 'Target')", [])
            .unwrap();
        for index in 0..51 {
            let id = format!("source-{index:02}");
            let path = format!("Source {index:02}.md");
            let title = format!("Source {index:02}");
            conn.execute(
                "INSERT INTO notes (id, path, title) VALUES (?1, ?2, ?3)",
                params![id, path, title],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO links (src_note_id, dst_note_id, link_text) VALUES (?1, 'target', 'Target')",
                params![id],
            )
            .unwrap();
        }

        let first = query(
            &conn,
            &KnowledgeQuery::Backlinks { note_id: "target".into() },
            &KnowledgePageRequest { limit: Some(50), cursor: None },
        )
        .unwrap();
        assert_eq!(first.items.len(), 50);
        let second = query(
            &conn,
            &KnowledgeQuery::Backlinks { note_id: "target".into() },
            &KnowledgePageRequest { limit: Some(50), cursor: first.next_cursor },
        )
        .unwrap();
        assert_eq!(second.items.len(), 1);
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn label_display_names_are_not_storage_aliases() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let catalog = Catalog {
            version: 1,
            properties: Vec::new(),
            labels: vec![
                CatalogLabel { id: "active-a".into(), name: "Active".into(), color: None },
                CatalogLabel { id: "active-b".into(), name: "active".into(), color: None },
            ],
            relationships: Vec::new(),
        };
        index_labels(
            &conn,
            "note-a",
            "status",
            &json!("Active"),
            false,
            false,
            Some(&catalog),
        )
        .unwrap();
        let stored: String = conn
            .query_row(
                "SELECT label_id FROM knowledge_labels WHERE note_id = 'note-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, "Active");
    }
}
