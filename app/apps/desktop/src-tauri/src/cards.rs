//! Folder-gallery card data (plan `docs/PLAN-INTERACTIVE-VIEWS.md` Part 3).
//!
//! The gallery never renders markdown per card. What a card shows besides the
//! filename is derived ONCE, at index time, from the same bytes the rest of the
//! index reads, and stored on the `notes` row:
//!
//! - `excerpt` — the first meaningful paragraph as plain text, at most
//!   [`EXCERPT_MAX_CHARS`] characters. Frontmatter, headings, fenced code, rules
//!   and image-only lines are skipped; markdown syntax is stripped and wikilinks
//!   become their display text.
//! - `first_image` — the vault-relative path of the first embedded image
//!   (`![alt](path)` or `![[file.png]]`); remote images never count.
//!
//! Both are derived and rebuildable like every other `notes` column (see
//! `Index::rebuild`'s `card_version` check), never vault data.
//!
//! [`list_folder_cards`] then answers one folder's direct children from the
//! index plus one `read_dir`: no note is read to build a gallery.

use crate::error::{AppError, AppResult};
use crate::index::Index;
use crate::vault::{is_ignored_name, is_image_file, rel_path_is_ignored, resolve_in_vault};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use std::path::Path;

/// Upper bound on a stored excerpt, ellipsis included.
pub const EXCERPT_MAX_CHARS: usize = 240;

/// Bumped whenever the derivation below changes, so `rebuild` re-derives every
/// note once (an unchanged mtime would otherwise skip it forever).
pub const CARD_VERSION: i64 = 1;

/// One card of a folder gallery: a direct child of the listed folder.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum FolderCard {
    Folder {
        path: String,
        name: String,
        /// Notes anywhere under this folder, from the index.
        note_count: i64,
    },
    Note {
        path: String,
        /// The filename stem — the UI's title rule (`noteLabel`).
        name: String,
        /// `None` only while the watcher has not indexed a brand-new file yet.
        doc_id: Option<String>,
        excerpt: Option<String>,
        first_image: Option<String>,
        /// mtime in epoch millis; 0 when the OS will not say.
        modified: u64,
        /// A 0-byte file: a server-only note that has not hydrated yet.
        empty: bool,
    },
}

/// Card fields the index stores per note.
#[derive(Debug, Clone, Default)]
pub struct CardRow {
    pub id: String,
    pub excerpt: Option<String>,
    pub first_image: Option<String>,
}

// ---- Excerpt ---------------------------------------------------------------

static HEADING_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^#{1,6}(\s|$)").unwrap());
static RULE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$").unwrap());
static SETEXT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(=+|-+)$").unwrap());
static BLOCK_PREFIX_RE: Lazy<Regex> = Lazy::new(|| {
    // Blockquote markers, then an optional callout tag, list marker and task box.
    Regex::new(r"^(>\s?)*(\[![\w-]+\][+-]?\s*)?(([-*+]|\d+[.)])\s+)?(\[.\]\s+)?").unwrap()
});
static OFM_COMMENT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"%%.*?%%").unwrap());
static HTML_COMMENT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"<!--.*?-->").unwrap());
static WIKI_EMBED_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"!\[\[[^\]\n]*\]\]").unwrap());
static MD_IMAGE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"!\[[^\]\n]*\]\([^)\n]*\)").unwrap());
static WIKILINK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\[\[([^\]|\n]*?)(?:\|([^\]\n]*))?\]\]").unwrap());
static MD_LINK_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[([^\]\n]*)\](\([^)\n]*\)|\[[^\]\n]*\])").unwrap());
static AUTOLINK_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"<((?:https?|mailto):[^>\s]+)>").unwrap());
static HTML_TAG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"</?[A-Za-z][^>]*>").unwrap());
static CODE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"`+([^`]*)`+").unwrap());
static STRONG_STAR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\*\*(.+?)\*\*").unwrap());
static STRONG_UNDER_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"__(.+?)__").unwrap());
static STRIKE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"~~(.+?)~~").unwrap());
static HIGHLIGHT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"==(.+?)==").unwrap());
static EM_STAR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\*([^*\s](?:[^*]*[^*\s])?)\*").unwrap());
// `_x_` only at word edges, so `snake_case_name` keeps its underscores.
static EM_UNDER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(^|[^\p{L}\p{N}_])_([^_\s](?:[^_]*[^_\s])?)_($|[^\p{L}\p{N}_])").unwrap());
static ESCAPE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\\([\\`*_{}\[\]()#+\-.!|~=<>])").unwrap());
static SPACE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());

/// Inline markdown → plain text, whitespace collapsed.
fn plain_inline(text: &str) -> String {
    // Park `\*`-style escapes in the private-use area first, so no later rule
    // mistakes an escaped marker for syntax; they come back as literals last.
    const PARK: u32 = 0xE000;
    let parked = ESCAPE_RE.replace_all(text, |c: &regex::Captures| {
        let ch = c[1].chars().next().unwrap_or(' ');
        char::from_u32(PARK + ch as u32).unwrap_or(ch).to_string()
    });
    let s = OFM_COMMENT_RE.replace_all(&parked, "");
    let s = HTML_COMMENT_RE.replace_all(&s, "");
    let s = WIKI_EMBED_RE.replace_all(&s, "");
    let s = MD_IMAGE_RE.replace_all(&s, "");
    let s = WIKILINK_RE.replace_all(&s, |c: &regex::Captures| {
        if let Some(alias) = c.get(2).map(|m| m.as_str().trim()).filter(|a| !a.is_empty()) {
            return alias.to_string();
        }
        let raw = c.get(1).map(|m| m.as_str()).unwrap_or("");
        let (target, heading) = raw.split_once('#').unwrap_or((raw, ""));
        let target = target.trim();
        if target.is_empty() { heading.trim().to_string() } else { target.to_string() }
    });
    let s = MD_LINK_RE.replace_all(&s, "$1");
    let s = AUTOLINK_RE.replace_all(&s, "$1");
    let s = HTML_TAG_RE.replace_all(&s, "");
    let s = CODE_RE.replace_all(&s, "$1");
    let s = STRONG_STAR_RE.replace_all(&s, "$1");
    let s = STRONG_UNDER_RE.replace_all(&s, "$1");
    let s = STRIKE_RE.replace_all(&s, "$1");
    let s = HIGHLIGHT_RE.replace_all(&s, "$1");
    let s = EM_STAR_RE.replace_all(&s, "$1");
    let s = EM_UNDER_RE.replace_all(&s, "$1$2$3");
    let s: String = s
        .chars()
        .map(|c| match c as u32 {
            n if (PARK..PARK + 0x80).contains(&n) => char::from_u32(n - PARK).unwrap_or(c),
            _ => c,
        })
        .collect();
    SPACE_RE.replace_all(&s, " ").trim().to_string()
}

/// Cut to [`EXCERPT_MAX_CHARS`] on a word boundary when one is near, with `…`.
fn truncate_excerpt(text: String) -> String {
    if text.chars().count() <= EXCERPT_MAX_CHARS {
        return text;
    }
    let budget = EXCERPT_MAX_CHARS - 1; // room for the ellipsis
    let cut: String = text.chars().take(budget).collect();
    // Prefer the last space, unless that would throw away most of a long word run.
    let trimmed = match cut.rfind(char::is_whitespace) {
        Some(at) if cut[..at].chars().count() >= budget * 3 / 4 => cut[..at].to_string(),
        _ => cut,
    };
    let trimmed = trimmed.trim_end_matches(|c: char| c.is_whitespace() || ",;:-".contains(c));
    format!("{trimmed}…")
}

/// The first meaningful paragraph of a note BODY (frontmatter already removed,
/// as `parse_note` hands it over), as plain text. `None` when nothing qualifies.
pub fn derive_excerpt(body: &str) -> Option<String> {
    let mut fence: Option<&str> = None;
    let mut para: Vec<&str> = Vec::new();

    let flush = |para: &mut Vec<&str>| -> Option<String> {
        if para.is_empty() {
            return None;
        }
        let joined = para
            .iter()
            .map(|line| BLOCK_PREFIX_RE.replace(line, "").into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        para.clear();
        let text = plain_inline(&joined);
        (!text.is_empty()).then(|| truncate_excerpt(text))
    };

    for line in body.lines() {
        let t = line.trim();
        if let Some(marker) = fence {
            if t.starts_with(marker) {
                fence = None;
            }
            continue;
        }
        if t.starts_with("```") || t.starts_with("~~~") {
            if let Some(out) = flush(&mut para) {
                return Some(out);
            }
            fence = Some(if t.starts_with("```") { "```" } else { "~~~" });
            continue;
        }
        if t.is_empty() {
            if let Some(out) = flush(&mut para) {
                return Some(out);
            }
            continue;
        }
        // A setext underline turns the lines above it into a heading: drop them.
        if !para.is_empty() && SETEXT_RE.is_match(t) {
            para.clear();
            continue;
        }
        if HEADING_RE.is_match(t) || RULE_RE.is_match(t) || t.starts_with('|') {
            if let Some(out) = flush(&mut para) {
                return Some(out);
            }
            continue;
        }
        para.push(t);
    }
    flush(&mut para)
}

// ---- First image -----------------------------------------------------------

static EMBED_RE: Lazy<Regex> = Lazy::new(|| {
    // 1: a wiki embed target; 2: a markdown image destination.
    Regex::new(r"!\[\[([^\]\n]+)\]\]|!\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+[^)]*)?\)").unwrap()
});
static SCHEME_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9+.-]*:").unwrap());

/// Percent-decode one path segment; a malformed sequence stays literal (the
/// same leniency as the TS `resolveVaultReference`).
fn percent_decode(segment: &str) -> String {
    fn hex(b: u8) -> Option<u8> {
        (b as char).to_digit(16).map(|d| d as u8)
    }
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| segment.to_string())
}

/// Join `path` onto `base` segments, collapsing `.`/`..`; `None` on an escape.
fn normalize_onto(base: &[&str], path: &str, decode: bool) -> Option<String> {
    let mut segments: Vec<String> = base.iter().map(|s| s.to_string()).collect();
    for raw in path.split('/') {
        let part = if decode { percent_decode(raw) } else { raw.to_string() };
        if part.contains('\\') || part.contains('\0') {
            return None;
        }
        match part.as_str() {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            _ => segments.push(part),
        }
    }
    (!segments.is_empty()).then(|| segments.join("/"))
}

fn note_dir(note_rel: &str) -> Vec<&str> {
    match note_rel.rsplit_once('/') {
        Some((dir, _)) => dir.split('/').collect(),
        None => Vec::new(),
    }
}

/// `![alt](src)`: the TS `resolveVaultReference` rules — schemes (http, data,
/// …) and `//host` are not vault files; `?`/`#` decorations drop; a leading `/`
/// is vault-root relative, anything else relative to the note's folder.
fn resolve_markdown_src(note_rel: &str, src: &str) -> Option<String> {
    let src = src.trim().trim_start_matches('<').trim_end_matches('>').trim();
    if src.is_empty() || src.starts_with("//") || SCHEME_RE.is_match(src) {
        return None;
    }
    let end = src.find(['?', '#']).unwrap_or(src.len());
    let path = &src[..end];
    if path.is_empty() {
        return None;
    }
    let base = if path.starts_with('/') { Vec::new() } else { note_dir(note_rel) };
    normalize_onto(&base, path, true)
}

/// `![[file.png]]` (Obsidian): a target with a `/` is a vault path; a bare name
/// is looked up beside the note, then at the vault root, then under
/// `attachments/` (where the app's own paste/drop saves images). The first that
/// exists wins; a bare name found nowhere yields nothing rather than a guess.
fn resolve_wiki_target(vault: &Path, note_rel: &str, target: &str) -> Option<String> {
    let target = target.split('|').next().unwrap_or("");
    let target = target.split('#').next().unwrap_or("").trim();
    if target.is_empty() || SCHEME_RE.is_match(target) {
        return None;
    }
    if target.contains('/') {
        return normalize_onto(&[], target.trim_start_matches('/'), false);
    }
    let beside = normalize_onto(&note_dir(note_rel), target, false);
    let candidates = [beside, Some(target.to_string()), Some(format!("attachments/{target}"))];
    candidates.into_iter().flatten().find(|rel| {
        resolve_in_vault(vault, rel).map(|abs| abs.is_file()).unwrap_or(false)
    })
}

/// The first embedded IMAGE in a note body (outside fenced code), resolved to a
/// vault-relative path. Embeds of other kinds (PDF, audio) and remote images
/// are passed over, not stopped at.
pub fn first_image(vault: &Path, note_rel: &str, body: &str) -> Option<String> {
    let mut fence: Option<&str> = None;
    for line in body.lines() {
        let t = line.trim_start();
        if let Some(marker) = fence {
            if t.starts_with(marker) {
                fence = None;
            }
            continue;
        }
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = Some(if t.starts_with("```") { "```" } else { "~~~" });
            continue;
        }
        let line = CODE_RE.replace_all(line, "");
        for cap in EMBED_RE.captures_iter(&line) {
            let resolved = if let Some(target) = cap.get(1) {
                resolve_wiki_target(vault, note_rel, target.as_str())
            } else {
                cap.get(2).and_then(|src| resolve_markdown_src(note_rel, src.as_str()))
            };
            let Some(rel) = resolved else { continue };
            let name = rel.rsplit('/').next().unwrap_or(&rel);
            if is_image_file(name) && !rel_path_is_ignored(&rel) {
                return Some(rel);
            }
        }
    }
    None
}

// ---- Listing ---------------------------------------------------------------

fn modified_millis(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_folder(folder: &str) -> String {
    folder.trim_matches('/').to_string()
}

/// One folder's direct children as gallery cards: subfolders and `.md` notes.
///
/// Returns `Ok(None)` when the folder does not exist (the gallery then says so);
/// an unsafe path (`..`, absolute, or anything under an ignored name such as
/// `.context/`) is an error. Order is name order — the UI applies the folder's
/// own sort (`sortTree`), so this is not the order a user sees.
pub fn list_folder_cards(
    vault: &Path,
    index: &Index,
    folder: &str,
) -> AppResult<Option<Vec<FolderCard>>> {
    let folder = normalize_folder(folder);
    if rel_path_is_ignored(&folder) {
        return Err(AppError::new("that folder is not part of the vault"));
    }
    let dir = if folder.is_empty() { vault.to_path_buf() } else { resolve_in_vault(vault, &folder)? };
    if !dir.is_dir() {
        return Ok(None);
    }
    let rows = index.card_rows_in(&folder)?;

    let mut folders: Vec<FolderCard> = Vec::new();
    let mut notes: Vec<FolderCard> = Vec::new();
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_name(&name) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else { continue };
        let rel = if folder.is_empty() { name.clone() } else { format!("{folder}/{name}") };
        if file_type.is_dir() {
            // Root `attachments/` is binary-sync plumbing, hidden like the tree hides it.
            if folder.is_empty() && name == "attachments" {
                continue;
            }
            let note_count = index.count_notes_under(&rel)?;
            folders.push(FolderCard::Folder { path: rel, name, note_count });
        } else if file_type.is_file() {
            // `.md` is ASCII, so a case-insensitive suffix match leaves a
            // char boundary exactly three bytes from the end.
            if !name.to_ascii_lowercase().ends_with(".md") || name.len() <= 3 {
                continue;
            }
            let stem = &name[..name.len() - 3];
            let meta = entry.metadata().ok();
            let row = rows.get(&rel).cloned().unwrap_or_default();
            let empty = meta.as_ref().map(|m| m.len() == 0).unwrap_or(false);
            notes.push(FolderCard::Note {
                name: stem.to_string(),
                doc_id: (!row.id.is_empty()).then_some(row.id),
                excerpt: if empty { None } else { row.excerpt },
                first_image: if empty { None } else { row.first_image },
                modified: meta.as_ref().map(modified_millis).unwrap_or(0),
                empty,
                path: rel,
            });
        }
    }
    let key = |c: &FolderCard| match c {
        FolderCard::Folder { name, .. } | FolderCard::Note { name, .. } => name.to_lowercase(),
    };
    folders.sort_by_key(key);
    notes.sort_by_key(key);
    folders.extend(notes);
    Ok(Some(folders))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn excerpt_skips_frontmatter_via_parse_and_leading_h1() {
        let content = "---\ntitle: T\ntags: [a]\n---\n# Big Title\n\nFirst real paragraph.\n\nSecond.";
        let parsed = crate::parse::parse_note(content, "stem");
        assert_eq!(derive_excerpt(&parsed.body).as_deref(), Some("First real paragraph."));
    }

    #[test]
    fn excerpt_skips_headings_code_rules_and_image_only_lines() {
        let body = "# Title\n## Sub\n\n```rust\nlet x = 1;\n```\n\n---\n\n![pic](a.png)\n\n![[b.png]]\n\nThe *actual* text.";
        assert_eq!(derive_excerpt(body).as_deref(), Some("The actual text."));
    }

    #[test]
    fn excerpt_joins_a_multiline_paragraph_and_collapses_whitespace() {
        let body = "Line one\n   line   two\nline three\n\nnext";
        assert_eq!(derive_excerpt(body).as_deref(), Some("Line one line two line three"));
    }

    #[test]
    fn excerpt_strips_markdown_syntax() {
        let body = "**Bold** and __strong__, *em* and _em2_, ~~gone~~ ==hi== `code` \
                    [a link](https://x.y) <b>tag</b> %%secret%% <!-- c --> snake_case_name \\*lit\\*";
        assert_eq!(
            derive_excerpt(body).as_deref(),
            Some("Bold and strong, em and em2, gone hi code a link tag snake_case_name *lit*")
        );
    }

    #[test]
    fn excerpt_turns_wikilinks_into_their_text() {
        let body = "See [[Target Note]], [[Other|the alias]] and [[Third#Section]] and [[#Local]].";
        assert_eq!(
            derive_excerpt(body).as_deref(),
            Some("See Target Note, the alias and Third and Local.")
        );
    }

    #[test]
    fn excerpt_strips_list_quote_and_task_markers() {
        assert_eq!(derive_excerpt("- [ ] buy milk\n- eggs").as_deref(), Some("buy milk eggs"));
        assert_eq!(derive_excerpt("> [!note] Heads up\n> quoted").as_deref(), Some("Heads up quoted"));
        assert_eq!(derive_excerpt("1. first\n2. second").as_deref(), Some("first second"));
    }

    #[test]
    fn excerpt_drops_setext_headings() {
        assert_eq!(derive_excerpt("Title\n=====\n\nBody text").as_deref(), Some("Body text"));
    }

    #[test]
    fn excerpt_truncates_on_a_word_boundary() {
        let body = "word ".repeat(200);
        let out = derive_excerpt(&body).unwrap();
        assert!(out.chars().count() <= EXCERPT_MAX_CHARS, "{} chars", out.chars().count());
        assert!(out.ends_with("word…"), "{out}");
        // Multi-byte text truncates by characters, never mid-codepoint.
        let wide = "é".repeat(500);
        let out = derive_excerpt(&wide).unwrap();
        assert_eq!(out.chars().count(), EXCERPT_MAX_CHARS);
    }

    #[test]
    fn excerpt_is_none_for_empty_or_structure_only_notes() {
        assert_eq!(derive_excerpt(""), None);
        assert_eq!(derive_excerpt("# Only a title\n\n![x](y.png)\n"), None);
    }

    #[test]
    fn first_image_resolves_markdown_images_like_the_editor() {
        let v = tempfile::tempdir().unwrap();
        let vault = v.path();
        // Relative to the note's folder, with `..` collapsed and %-decoding.
        assert_eq!(
            first_image(vault, "Trips/Rome.md", "text\n![a](img/My%20Pic.png)").as_deref(),
            Some("Trips/img/My Pic.png")
        );
        assert_eq!(
            first_image(vault, "Trips/Rome.md", "![a](../shared/b.jpg \"title\")").as_deref(),
            Some("shared/b.jpg")
        );
        // Vault-root relative, with a decoration dropped (the paste handler's shape).
        assert_eq!(
            first_image(vault, "Trips/Rome.md", "![](/attachments/ab12.png?w=20)").as_deref(),
            Some("attachments/ab12.png")
        );
        // Angle-bracket destinations may hold spaces.
        assert_eq!(
            first_image(vault, "n.md", "![x](<pics/a b.webp>)").as_deref(),
            Some("pics/a b.webp")
        );
    }

    #[test]
    fn first_image_ignores_remote_non_image_and_escaping_embeds() {
        let v = tempfile::tempdir().unwrap();
        let vault = v.path();
        let body = "![r](https://example.com/x.png)\n![d](data:image/png;base64,AAA)\n\
                    ![p](doc.pdf)\n![e](../../outside.png)\n![c](.context/x.png)\n`![code](c.png)`\n\
                    ```\n![fenced](f.png)\n```\n![real](real.gif)";
        assert_eq!(first_image(vault, "n.md", body).as_deref(), Some("real.gif"));
        assert_eq!(first_image(vault, "n.md", "![r](http://x/y.png)"), None);
    }

    #[test]
    fn first_image_resolves_wiki_embeds_by_location() {
        let v = tempfile::tempdir().unwrap();
        let vault = v.path();
        fs::create_dir_all(vault.join("Trips")).unwrap();
        fs::create_dir_all(vault.join("attachments")).unwrap();
        fs::write(vault.join("Trips/beside.png"), b"x").unwrap();
        fs::write(vault.join("root.png"), b"x").unwrap();
        fs::write(vault.join("attachments/pasted.png"), b"x").unwrap();

        let at = |body: &str| first_image(vault, "Trips/Rome.md", body);
        assert_eq!(at("![[beside.png]]").as_deref(), Some("Trips/beside.png"));
        assert_eq!(at("![[root.png|200]]").as_deref(), Some("root.png"));
        assert_eq!(at("![[pasted.png]]").as_deref(), Some("attachments/pasted.png"));
        // A path-qualified target is a vault path, whether or not it exists yet.
        assert_eq!(at("![[media/cover.jpg]]").as_deref(), Some("media/cover.jpg"));
        // A bare name found nowhere is skipped, and a non-image embed is passed over.
        assert_eq!(at("![[missing.png]] ![[Other note]] ![[doc.pdf]] ![[root.png]]").as_deref(), Some("root.png"));
        // Whichever syntax comes first wins.
        assert_eq!(at("![a](x/first.png) ![[root.png]]").as_deref(), Some("Trips/x/first.png"));
    }

    fn seed() -> (tempfile::TempDir, Index) {
        let v = tempfile::tempdir().unwrap();
        let root = v.path();
        fs::create_dir_all(root.join("Trips/Italy")).unwrap();
        fs::create_dir_all(root.join("Trips/.hidden")).unwrap();
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::write(root.join("Trips/Rome.md"), "# Rome\n\nPasta and ruins.\n\n![](/attachments/r.png)").unwrap();
        fs::write(root.join("Trips/Stub.md"), "").unwrap();
        fs::write(root.join("Trips/photo.png"), b"x").unwrap();
        fs::write(root.join("Trips/Italy/Florence.md"), "Art.").unwrap();
        fs::write(root.join("Trips/Italy/Venice.md"), "Canals.").unwrap();
        fs::write(root.join("Top.md"), "top").unwrap();
        let index = Index::open(root).unwrap();
        index.rebuild(root).unwrap();
        (v, index)
    }

    #[test]
    fn list_folder_cards_returns_direct_children_with_card_data() {
        let (v, index) = seed();
        let cards = list_folder_cards(v.path(), &index, "Trips").unwrap().unwrap();
        let mut paths: Vec<&str> = cards
            .iter()
            .map(|c| match c {
                FolderCard::Folder { path, .. } | FolderCard::Note { path, .. } => path.as_str(),
            })
            .collect();
        paths.sort();
        // Direct children only; no image files, no dot-folders, no grandchildren.
        assert_eq!(paths, vec!["Trips/Italy", "Trips/Rome.md", "Trips/Stub.md"]);

        let italy = cards.iter().find(|c| matches!(c, FolderCard::Folder { .. })).unwrap();
        assert_eq!(
            italy,
            &FolderCard::Folder { path: "Trips/Italy".into(), name: "Italy".into(), note_count: 2 }
        );
        let rome = cards
            .iter()
            .find(|c| matches!(c, FolderCard::Note { name, .. } if name == "Rome"))
            .unwrap();
        let FolderCard::Note { doc_id, excerpt, first_image, empty, modified, .. } = rome else {
            unreachable!()
        };
        assert!(doc_id.is_some());
        assert_eq!(excerpt.as_deref(), Some("Pasta and ruins."));
        assert_eq!(first_image.as_deref(), Some("attachments/r.png"));
        assert!(!empty);
        assert!(*modified > 0);
    }

    #[test]
    fn list_folder_cards_marks_zero_byte_notes_empty() {
        let (v, index) = seed();
        let cards = list_folder_cards(v.path(), &index, "Trips").unwrap().unwrap();
        let stub = cards
            .iter()
            .find(|c| matches!(c, FolderCard::Note { name, .. } if name == "Stub"))
            .unwrap();
        assert!(matches!(stub, FolderCard::Note { empty: true, excerpt: None, first_image: None, .. }));
    }

    #[test]
    fn list_folder_cards_at_root_hides_attachments_and_counts_recursively() {
        let (v, index) = seed();
        let cards = list_folder_cards(v.path(), &index, "").unwrap().unwrap();
        let json = serde_json::to_value(&cards).unwrap();
        let arr = json.as_array().unwrap();
        assert_eq!(arr.len(), 2, "{json}");
        assert_eq!(arr[0]["kind"], "folder");
        assert_eq!(arr[0]["noteCount"], 4);
        assert_eq!(arr[1]["kind"], "note");
        assert_eq!(arr[1]["name"], "Top");
        assert!(arr[1]["docId"].is_string());
        assert!(arr[1].get("firstImage").is_some());
    }

    #[test]
    fn list_folder_cards_refuses_unsafe_paths_and_reports_missing() {
        let (v, index) = seed();
        assert!(list_folder_cards(v.path(), &index, "../").is_err());
        assert!(list_folder_cards(v.path(), &index, "Trips/../../x").is_err());
        // A leading slash is trimmed: "/etc" means the vault's own `etc`, absent here.
        assert_eq!(list_folder_cards(v.path(), &index, "/etc").unwrap(), None);
        assert!(list_folder_cards(v.path(), &index, ".context").is_err());
        assert!(list_folder_cards(v.path(), &index, "Trips/.hidden").is_err());
        assert_eq!(list_folder_cards(v.path(), &index, "Gone").unwrap(), None);
    }
}
