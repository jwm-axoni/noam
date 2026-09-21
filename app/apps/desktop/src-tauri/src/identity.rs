//! Safe, revision-checked inspection of Noam's portable document identity.
//!
//! The Markdown file is canonical. This module never accepts replacement
//! content from the webview and never serializes frontmatter. It rereads the
//! note and validates the caller's source revision before the live Yjs writer
//! may insert the reserved key.

use crate::error::{AppError, AppResult};
use crate::index::Index;
use crate::notefile::{self, sha256_hex};
use crate::vault::resolve_in_vault;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::path::Path;

const DOCUMENT_ID_KEY: &str = "noam_document_id";
const MAX_FRONTMATTER_BYTES: usize = 64 * 1024;
const MAX_FRONTMATTER_SIGILS: usize = 32;

static DOCUMENT_ID_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$").unwrap());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InspectDocumentIdentityResult {
    pub document_id: String,
    pub source_revision: String,
    pub source_file_identity: String,
    pub insertion_required: bool,
}

struct Frontmatter<'a> {
    yaml: &'a str,
}

fn coded(code: &str, message: impl AsRef<str>) -> AppError {
    AppError::new(format!("{code}: {}", message.as_ref()))
}

fn split_bom(content: &str) -> (&str, &str) {
    content
        .strip_prefix('\u{feff}')
        .map_or(("", content), |rest| ("\u{feff}", rest))
}

/// Locate a leading, closed frontmatter block without changing its bytes.
fn frontmatter(content: &str) -> AppResult<Option<Frontmatter<'_>>> {
    let (_, text) = split_bom(content);
    let mut cursor = if text.starts_with("---\r\n") {
        5
    } else if text.starts_with("---\n") {
        4
    } else {
        // A leading fence line is an attempted frontmatter block. Refuse an
        // incomplete one instead of treating it as body and adding a second.
        if text == "---" || text.starts_with("---\r") {
            return Err(coded(
                "unsupported_frontmatter",
                "frontmatter opening fence is unterminated",
            ));
        }
        return Ok(None);
    };

    let yaml_start = cursor;
    while cursor <= text.len() {
        let line_end = text[cursor..]
            .find('\n')
            .map(|offset| cursor + offset)
            .unwrap_or(text.len());
        let line = text[cursor..line_end]
            .strip_suffix('\r')
            .unwrap_or(&text[cursor..line_end]);
        if line == "---" {
            return Ok(Some(Frontmatter {
                yaml: &text[yaml_start..cursor],
            }));
        }
        if line_end == text.len() {
            break;
        }
        cursor = line_end + 1;
    }

    Err(coded(
        "unsupported_frontmatter",
        "frontmatter opening fence has no closing fence",
    ))
}

fn parse_mapping(yaml: &str) -> AppResult<serde_yaml::Mapping> {
    if yaml.len() > MAX_FRONTMATTER_BYTES {
        return Err(coded(
            "unsupported_frontmatter",
            "frontmatter exceeds the safe parsing limit",
        ));
    }
    let sigils = yaml
        .bytes()
        .filter(|byte| matches!(byte, b'&' | b'*'))
        .count();
    if sigils > MAX_FRONTMATTER_SIGILS {
        return Err(coded(
            "unsupported_frontmatter",
            "frontmatter has too many YAML anchors or aliases",
        ));
    }
    if yaml.trim().is_empty() {
        return Ok(serde_yaml::Mapping::new());
    }
    match serde_yaml::from_str::<Value>(yaml) {
        Ok(Value::Mapping(mapping)) => Ok(mapping),
        Ok(_) => Err(coded(
            "unsupported_frontmatter",
            "frontmatter root must be a YAML mapping",
        )),
        Err(error) => Err(coded(
            "unsupported_frontmatter",
            format!("frontmatter is malformed or has duplicate keys: {error}"),
        )),
    }
}

fn identity_from(mapping: &serde_yaml::Mapping) -> AppResult<Option<String>> {
    let key = Value::String(DOCUMENT_ID_KEY.to_string());
    let Some(value) = mapping.get(&key) else {
        return Ok(None);
    };
    let Value::String(document_id) = value else {
        return Err(coded(
            "schema_invalid",
            format!("{DOCUMENT_ID_KEY} must be a valid string id"),
        ));
    };
    if !DOCUMENT_ID_RE.is_match(document_id) {
        return Err(coded(
            "schema_invalid",
            format!("{DOCUMENT_ID_KEY} is invalid"),
        ));
    }
    Ok(Some(document_id.clone()))
}

fn assert_unclaimed(index: &Index, path: &str, document_id: &str) -> AppResult<()> {
    if let Some(owner) = index.portable_document_identity_owner(document_id, path)? {
        return Err(coded(
            "duplicate_document_identity",
            format!("{document_id} is already used by {owner}"),
        ));
    }
    Ok(())
}

/// Inspect the current file and reserve a safe identity choice for the live
/// Yjs writer. This function never writes Markdown. The caller must apply any
/// required insertion through the note's one shared CRDT document, then call
/// this again against the resulting source revision to confirm it.
pub fn inspect_document_identity(
    vault: &Path,
    index: &Index,
    path: &str,
    expected_local_note_id: &str,
    synced_document_id: Option<&str>,
    expected_source_revision: &str,
) -> AppResult<InspectDocumentIdentityResult> {
    let proposed_document_id = synced_document_id.unwrap_or(expected_local_note_id);
    if !DOCUMENT_ID_RE.is_match(proposed_document_id) {
        return Err(coded("schema_invalid", "proposed document id is invalid"));
    }

    let local_note_id = index
        .get_note_meta(path)?
        .ok_or_else(|| coded("not_found", "note is not in the local index"))?
        .id;
    if expected_local_note_id != local_note_id {
        return Err(coded("stale_edit", "the indexed note identity changed"));
    }

    let snapshot = notefile::read_note_snapshot(vault, path).map_err(|error| {
        if resolve_in_vault(vault, path).is_ok_and(|abs| !abs.is_file()) {
            coded("not_found", "note does not exist")
        } else {
            error
        }
    })?;
    let content = snapshot.content;
    let current_revision = sha256_hex(&content);
    if current_revision != expected_source_revision {
        return Err(coded("stale_edit", "note changed since the caller read it"));
    }

    let frontmatter = frontmatter(&content)?;
    let existing = match &frontmatter {
        Some(block) => identity_from(&parse_mapping(block.yaml)?)?,
        None => None,
    };
    if let Some(document_id) = existing {
        assert_unclaimed(index, path, &document_id)?;
        return Ok(InspectDocumentIdentityResult {
            document_id,
            source_revision: current_revision,
            source_file_identity: snapshot.file_identity,
            insertion_required: false,
        });
    }

    assert_unclaimed(index, path, proposed_document_id)?;
    Ok(InspectDocumentIdentityResult {
        document_id: proposed_document_id.to_string(),
        source_revision: current_revision,
        source_file_identity: snapshot.file_identity,
        insertion_required: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::{KnowledgeItem, KnowledgePageRequest, KnowledgeQuery};
    use tempfile::TempDir;

    fn fixture(notes: &[(&str, &str)]) -> (TempDir, Index) {
        let vault = tempfile::tempdir().unwrap();
        for (path, content) in notes {
            notefile::write_note(vault.path(), path, content).unwrap();
        }
        let index = Index::open(vault.path()).unwrap();
        index.rebuild(vault.path()).unwrap();
        (vault, index)
    }

    fn inspect(
        vault: &TempDir,
        index: &Index,
        path: &str,
        synced_document_id: Option<&str>,
        source: &str,
    ) -> AppResult<InspectDocumentIdentityResult> {
        let local_id = canonical_id(index, path);
        inspect_document_identity(
            vault.path(),
            index,
            path,
            &local_id,
            synced_document_id,
            &sha256_hex(source),
        )
    }

    fn canonical_id(index: &Index, path: &str) -> String {
        index.get_note_meta(path).unwrap().unwrap().id
    }

    #[test]
    fn reports_missing_frontmatter_without_touching_the_note() {
        let source = "# Ada\nBody.\n";
        let (vault, index) = fixture(&[("Ada.md", source)]);
        let expected = canonical_id(&index, "Ada.md");
        let result = inspect(&vault, &index, "Ada.md", None, source).unwrap();
        assert_eq!(result.document_id, expected);
        assert_eq!(result.source_revision, sha256_hex(source));
        assert!(result.insertion_required);
        assert_eq!(notefile::read_note(vault.path(), "Ada.md").unwrap(), source);
    }

    #[test]
    fn accepts_supported_and_bounded_unsupported_yaml_without_rewriting() {
        let supported =
            "---\n# keep this comment\ntitle: 'Ada'\ntags: [person, engineer]\n---\nBody\n";
        let unsupported_by_properties =
            "---\nprofile:\n  role: engineer\nsummary: |\n  Line one\n  Line two\n---\nBody\n";
        let (vault, index) = fixture(&[
            ("Supported.md", supported),
            ("Nested.md", unsupported_by_properties),
        ]);

        let supported_result =
            inspect(&vault, &index, "Supported.md", None, supported).unwrap();
        let nested_result = inspect(
            &vault,
            &index,
            "Nested.md",
            None,
            unsupported_by_properties,
        )
        .unwrap();
        assert!(supported_result.insertion_required);
        assert!(nested_result.insertion_required);
        assert_eq!(
            notefile::read_note(vault.path(), "Supported.md").unwrap(),
            supported
        );
        assert_eq!(
            notefile::read_note(vault.path(), "Nested.md").unwrap(),
            unsupported_by_properties
        );
    }

    #[test]
    fn returns_an_existing_valid_id_without_rewriting() {
        let source = "---\ntitle: Ada\nnoam_document_id: stable-id\n---\nBody\n";
        let (vault, index) = fixture(&[("Ada.md", source)]);
        let result = inspect(&vault, &index, "Ada.md", None, source).unwrap();
        assert_eq!(result.document_id, "stable-id");
        assert_eq!(result.source_revision, sha256_hex(source));
        assert!(!result.insertion_required);
        assert_eq!(notefile::read_note(vault.path(), "Ada.md").unwrap(), source);
    }

    #[test]
    fn refuses_an_id_claimed_by_another_note() {
        let target = "---\nnoam_document_id: already-used\n---\n# Target\n";
        let owner = "---\nnoam_document_id: already-used\n---\n# Owner\n";
        let (vault, index) = fixture(&[("Target.md", target), ("Owner.md", owner)]);
        let error = inspect(&vault, &index, "Target.md", None, target).unwrap_err();
        assert!(
            error.0.starts_with("duplicate_document_identity:"),
            "{}",
            error.0
        );
        assert_eq!(
            notefile::read_note(vault.path(), "Target.md").unwrap(),
            target
        );
    }

    #[test]
    fn refuses_a_stale_source_revision_and_invalid_proposal() {
        let source = "Body\n";
        let invalid_existing = "---\nnoam_document_id: bad:id\n---\nBody\n";
        let (vault, index) = fixture(&[("A.md", source), ("Invalid.md", invalid_existing)]);
        let stale =
            inspect_document_identity(
                vault.path(),
                &index,
                "A.md",
                &canonical_id(&index, "A.md"),
                None,
                "0",
            )
            .unwrap_err();
        assert!(stale.0.starts_with("stale_edit:"), "{}", stale.0);
        let invalid = inspect(&vault, &index, "A.md", Some("bad:id"), source).unwrap_err();
        assert!(invalid.0.starts_with("schema_invalid:"), "{}", invalid.0);
        let noncanonical = inspect_document_identity(
            vault.path(),
            &index,
            "A.md",
            "valid-but-wrong",
            None,
            &sha256_hex(source),
        )
        .unwrap_err();
        assert!(
            noncanonical.0.starts_with("stale_edit:"),
            "{}",
            noncanonical.0
        );
        let invalid =
            inspect(&vault, &index, "Invalid.md", None, invalid_existing).unwrap_err();
        assert!(invalid.0.starts_with("schema_invalid:"), "{}", invalid.0);
        assert_eq!(notefile::read_note(vault.path(), "A.md").unwrap(), source);
        assert_eq!(
            notefile::read_note(vault.path(), "Invalid.md").unwrap(),
            invalid_existing
        );
    }

    #[test]
    fn preserves_bom_and_crlf() {
        let source = "\u{feff}---\r\n# comment\r\ntitle: Ada\r\n---\r\nBody\r\n";
        let (vault, index) = fixture(&[("Ada.md", source)]);
        let result = inspect(&vault, &index, "Ada.md", None, source).unwrap();
        assert!(result.insertion_required);
        assert_eq!(notefile::read_note(vault.path(), "Ada.md").unwrap(), source);
    }

    #[test]
    fn accepts_a_distinct_synced_document_id_for_a_bound_local_note() {
        let source = "# Synced\n";
        let (vault, index) = fixture(&[("Synced.md", source)]);
        let result = inspect(
            &vault,
            &index,
            "Synced.md",
            Some("server-document-id"),
            source,
        )
        .unwrap();
        assert_eq!(result.document_id, "server-document-id");
        assert!(result.insertion_required);
    }

    #[test]
    fn refuses_duplicate_malformed_and_unterminated_frontmatter() {
        let duplicate = "---\nstatus: one\nstatus: two\n---\nBody\n";
        let malformed = "---\ntags: [one, two\n---\nBody\n";
        let unterminated = "---\ntitle: Ada\nBody\n";
        let (vault, index) = fixture(&[
            ("Duplicate.md", duplicate),
            ("Malformed.md", malformed),
            ("Unterminated.md", unterminated),
        ]);
        for (path, source) in [
            ("Duplicate.md", duplicate),
            ("Malformed.md", malformed),
            ("Unterminated.md", unterminated),
        ] {
            let error = inspect(&vault, &index, path, None, source).unwrap_err();
            assert!(
                error.0.starts_with("unsupported_frontmatter:"),
                "{}",
                error.0
            );
            assert_eq!(notefile::read_note(vault.path(), path).unwrap(), source);
        }
    }

    #[test]
    fn confirms_the_identity_after_the_live_writer_reindexes() {
        let source = "---\nstatus: draft\nnoam_document_id: doc-a\n---\nBody\n";
        let (vault, index) = fixture(&[("A.md", source)]);
        let note_id = index.get_note_meta("A.md").unwrap().unwrap().id;
        let result = inspect(&vault, &index, "A.md", None, source).unwrap();
        let page = index
            .query_knowledge(
                &KnowledgeQuery::IndexState { note_id },
                &KnowledgePageRequest::default(),
            )
            .unwrap();
        assert!(matches!(
            page.items.as_slice(),
            [KnowledgeItem::IndexState {
                portable_document_id: Some(document_id),
                source_revision: Some(source_revision),
                index_revision: Some(index_revision),
                index_status,
                ..
            }] if document_id == "doc-a"
                && source_revision == &result.source_revision
                && index_revision == &result.source_revision
                && index_status == "current"
        ));
        assert!(!result.insertion_required);
    }
}
