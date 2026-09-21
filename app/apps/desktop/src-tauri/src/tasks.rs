//! Rebuildable task index derived from Markdown task lines.
//!
//! The mirror of `src/lib/tasks/parse.ts`, and the same promise: the `.md`
//! file is canonical, these tables are a DERIVED projection that any rebuild
//! can throw away and rebuild from the files alone. Nothing is stored here
//! that is not on a line in a note.
//!
//! Why the index lives in Rust next to the notes and not in the UI:
//!   - it is written inside the SAME transaction as the note row, so the tasks
//!     of a note can never disagree with the note;
//!   - a relaunch costs zero file reads;
//!   - the watcher reaches these rows before the UI hears about the change;
//!   - "due this week, grouped by note" is one indexed query, not a scan of
//!     every note the renderer has ever opened.
//!
//! `char_from`/`char_to` are UTF-16 offsets, matching the editor's coordinate
//! space — and they are HINTS. Every write goes through `resolveTask` against
//! live text; an offset from this table must never reach one.

use crate::error::{AppError, AppResult};
use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};

/// A page is a panel, not an export. Mirrors `MAX_QUERY_LIMIT` in
/// `src/lib/tasks/contracts.ts`; paging is the answer to "I have more".
pub const MAX_PAGE_SIZE: u32 = 500;
pub const DEFAULT_PAGE_SIZE: u32 = 100;

/// Frozen in `contracts.ts` as `TASK_LINE_RE`. Deliberately strict: a false
/// positive would put a line nobody meant as a task in front of an action.
static TASK_LINE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(\s*)([-*+])\s+\[([ xX/-])\]\s(.*)$").unwrap());
static TASK_ID_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s\^(t-[0-9a-z]{10})$").unwrap());
static PLAIN_DATE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());
static HEADING_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(#{1,6})\s+(.*)$").unwrap());
static FENCE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\s{0,3}(`{3,}|~{3,})").unwrap());
/// The same rule as `parse.rs TAG_RE` and the editor's `ofm/hashtag.ts`.
static TAG_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:^|[^\p{L}\p{N}_/])#(\d*[\p{L}_/-][\p{L}\p{N}_/-]*)").unwrap());

const DATE_MARKERS: [(&str, &str); 6] = [
    ("📅", "due"),
    ("⏳", "scheduled"),
    ("🛫", "start"),
    ("✅", "done"),
    ("❌", "cancelled"),
    ("➕", "created"),
];
// `▶️` (with VARIATION SELECTOR-16) must be tried before the bare `▶`.
const PRIORITY_MARKERS: [(&str, &str); 6] = [
    ("⏫", "highest"),
    ("🔼", "high"),
    ("▶\u{fe0f}", "medium"),
    ("▶", "medium"),
    ("🔽", "low"),
    ("⏬", "lowest"),
];
const RECURRENCE_MARKER: &str = "🔁";
/// Preserved, not modelled — they only have to end the field before them.
const OTHER_GLYPHS: [&str; 4] = ["🆔", "⛔", "🏁", "🔺"];

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub note_id: String,
    pub path: String,
    pub task_id: Option<String>,
    pub series_id: Option<String>,
    pub line: i64,
    pub char_from: i64,
    pub char_to: i64,
    pub source_text: String,
    pub status: String,
    pub text: String,
    pub priority: Option<String>,
    pub due: Option<String>,
    pub scheduled: Option<String>,
    pub start: Option<String>,
    pub done: Option<String>,
    pub cancelled: Option<String>,
    pub created: Option<String>,
    pub recurrence: Option<String>,
    pub section: Vec<String>,
    pub indent: String,
    pub tags: Vec<String>,
}

/// One parsed line, before it has a note to belong to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedTask {
    pub task_id: Option<String>,
    pub line: i64,
    pub char_from: i64,
    pub char_to: i64,
    pub source_text: String,
    pub status: String,
    pub text: String,
    pub priority: Option<String>,
    pub due: Option<String>,
    pub scheduled: Option<String>,
    pub start: Option<String>,
    pub done: Option<String>,
    pub cancelled: Option<String>,
    pub created: Option<String>,
    pub recurrence: Option<String>,
    pub section: Vec<String>,
    pub indent: String,
    pub tags: Vec<String>,
}

impl ParsedTask {
    /// A recurring line with no chain of its own heads its series — the same
    /// rule the TypeScript side applies (`SeriesId` in `contracts.ts`).
    fn series_id(&self) -> Option<String> {
        if self.recurrence.is_some() {
            self.task_id.clone()
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

fn tokens(s: &str) -> Vec<(usize, &str)> {
    let mut out: Vec<(usize, &str)> = Vec::new();
    let mut start: Option<usize> = None;
    for (i, ch) in s.char_indices() {
        if ch.is_whitespace() {
            if let Some(b) = start.take() {
                out.push((b, &s[b..i]));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(b) = start {
        out.push((b, &s[b..]));
    }
    out
}

fn glyph_at(token: &str) -> Option<&'static str> {
    for (glyph, _) in PRIORITY_MARKERS.iter() {
        if token.starts_with(glyph) {
            return Some(glyph);
        }
    }
    for (glyph, _) in DATE_MARKERS.iter() {
        if token.starts_with(glyph) {
            return Some(glyph);
        }
    }
    if token.starts_with(RECURRENCE_MARKER) {
        return Some(RECURRENCE_MARKER);
    }
    for glyph in OTHER_GLYPHS.iter() {
        if token.starts_with(glyph) {
            return Some(glyph);
        }
    }
    None
}

fn status_for(checkbox: &str) -> &'static str {
    match checkbox {
        "x" | "X" => "done",
        "/" => "in-progress",
        "-" => "cancelled",
        _ => "todo",
    }
}

fn tags_in(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for cap in TAG_RE.captures_iter(text) {
        let tag = cap[1].to_string();
        if !out.contains(&tag) {
            out.push(tag);
        }
    }
    out
}

/// Parse ONE line. `None` for anything that is not a task line.
pub fn parse_task_line(line: &str) -> Option<ParsedTask> {
    let caps = TASK_LINE_RE.captures(line)?;
    let indent = caps.get(1).map(|m| m.as_str()).unwrap_or("").to_string();
    let checkbox = caps.get(3).map(|m| m.as_str()).unwrap_or(" ");
    let rest = caps.get(4).map(|m| m.as_str()).unwrap_or("");
    let text_from = line.len() - rest.len();

    let (task_id, tail_end) = match TASK_ID_RE.captures(rest) {
        Some(m) => (
            Some(m[1].to_string()),
            text_from + rest.len() - m.get(0).unwrap().as_str().len(),
        ),
        None => (None, line.len()),
    };
    let tail = &line[text_from..tail_end];

    let mut task = ParsedTask {
        task_id,
        source_text: line.to_string(),
        status: status_for(checkbox).to_string(),
        indent,
        tags: tags_in(tail),
        ..Default::default()
    };

    let toks = tokens(tail);
    let mut description_end = tail.len();
    let mut saw_field = false;
    let mut i = 0usize;
    while i < toks.len() {
        let (at, token) = toks[i];
        let glyph = match glyph_at(token) {
            Some(g) => g,
            None => {
                i += 1;
                continue;
            }
        };
        if !saw_field {
            saw_field = true;
            description_end = at;
        }
        let inline = &token[glyph.len()..];

        if let Some((_, name)) = PRIORITY_MARKERS.iter().find(|(g, _)| *g == glyph) {
            if inline.is_empty() {
                if task.priority.is_none() {
                    task.priority = Some((*name).to_string());
                }
                i += 1;
                continue;
            }
        }
        if let Some((_, field)) = DATE_MARKERS.iter().find(|(g, _)| *g == glyph) {
            let (value, consumed) = if !inline.is_empty() {
                (inline.to_string(), 1)
            } else {
                (
                    toks.get(i + 1).map(|(_, t)| (*t).to_string()).unwrap_or_default(),
                    2,
                )
            };
            if PLAIN_DATE_RE.is_match(&value) {
                let slot = match *field {
                    "due" => &mut task.due,
                    "scheduled" => &mut task.scheduled,
                    "start" => &mut task.start,
                    "done" => &mut task.done,
                    "cancelled" => &mut task.cancelled,
                    _ => &mut task.created,
                };
                if slot.is_none() {
                    *slot = Some(value);
                }
                i += consumed;
                continue;
            }
            // Not a date: preserved on the line, absent from the index.
            i += consumed;
            continue;
        }
        if glyph == RECURRENCE_MARKER {
            let mut end = tail.len();
            for j in (i + 1)..toks.len() {
                if glyph_at(toks[j].1).is_some() {
                    end = toks[j - 1].0 + toks[j - 1].1.len();
                    break;
                }
            }
            let value = tail[at + glyph.len()..end].trim().to_string();
            if task.recurrence.is_none() && !value.is_empty() {
                task.recurrence = Some(value);
            }
            while i < toks.len() && toks[i].0 < end {
                i += 1;
            }
            continue;
        }
        // `🆔 abc`, `⛔ def`, `🏁 delete`: skip the value token too.
        if inline.is_empty() && glyph != "🔺" && toks.get(i + 1).is_some() {
            i += 2;
        } else {
            i += 1;
        }
    }

    task.text = tail[..description_end].trim().to_string();
    Some(task)
}

/// Every task line in a note, in document order. Frontmatter and fenced code
/// are skipped; headings above a line become its section trail.
pub fn parse_tasks(content: &str) -> Vec<ParsedTask> {
    let mut out: Vec<ParsedTask> = Vec::new();
    let mut section: Vec<(usize, String)> = Vec::new();
    let mut fence: Option<String> = None;
    let mut u16_offset: i64 = 0;
    // A leading `---` fence is frontmatter, but only when the first line is
    // EXACTLY `---` — `--- draft` or `----` is ordinary text, not a fence. The
    // same rule the TS parser applies in `src/lib/tasks/parse.ts`.
    let first_line = content
        .strip_prefix('\u{feff}')
        .unwrap_or(content)
        .split('\n')
        .next()
        .unwrap_or("");
    let first_line = first_line.strip_suffix('\r').unwrap_or(first_line);
    let mut in_frontmatter = first_line == "---";

    for (index, raw) in content.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let char_from = u16_offset;
        let char_to = char_from + line.encode_utf16().count() as i64;
        u16_offset += raw.encode_utf16().count() as i64 + 1;

        if in_frontmatter {
            if index > 0 && (line == "---" || line == "...") {
                in_frontmatter = false;
            }
            continue;
        }
        let fence_match = FENCE_RE.captures(line);
        if let Some(open) = fence.clone() {
            if let Some(m) = fence_match {
                let marker = m[1].to_string();
                if marker.starts_with(&open[..1]) && marker.len() >= open.len() {
                    fence = None;
                }
            }
            continue;
        }
        if let Some(m) = fence_match {
            fence = Some(m[1].to_string());
            continue;
        }
        if let Some(m) = HEADING_RE.captures(line) {
            let level = m[1].len();
            while section.last().map(|(l, _)| *l >= level).unwrap_or(false) {
                section.pop();
            }
            section.push((level, m[2].trim().to_string()));
            continue;
        }
        if let Some(mut task) = parse_task_line(line) {
            task.line = index as i64;
            task.char_from = char_from;
            task.char_to = char_to;
            task.section = section.iter().map(|(_, text)| text.clone()).collect();
            out.push(task);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

pub(crate) fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS tasks (
            row_id       INTEGER PRIMARY KEY,
            note_id      TEXT NOT NULL,
            task_id      TEXT,
            series_id    TEXT,
            line         INTEGER NOT NULL,
            char_from    INTEGER NOT NULL,
            char_to      INTEGER NOT NULL,
            source_text  TEXT NOT NULL,
            status       TEXT NOT NULL,
            text         TEXT NOT NULL,
            priority     TEXT,
            due          TEXT,
            scheduled    TEXT,
            start        TEXT,
            done         TEXT,
            cancelled    TEXT,
            created      TEXT,
            recurrence   TEXT,
            section      TEXT NOT NULL,
            indent       TEXT NOT NULL,
            generation   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS task_tags (
            row_id  INTEGER NOT NULL,
            tag     TEXT NOT NULL,
            PRIMARY KEY (row_id, tag)
        );

        CREATE TABLE IF NOT EXISTS task_meta (
            key    TEXT PRIMARY KEY,
            value  INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due);
        CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due);
        CREATE INDEX IF NOT EXISTS idx_tasks_note ON tasks(note_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_task_id ON tasks(task_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_series ON tasks(series_id);
        CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag, row_id);
        "#,
    )?;
    Ok(())
}

/// Bumped when the projection's SHAPE changes. A vault indexed by an older
/// build has `notes` rows whose mtimes match the disk, so `rebuild` would skip
/// every file and the task tables would stay empty; this marker is what makes
/// that one pass re-read them. The same trick `knowledge.rs` plays with
/// `knowledge_documents`.
const PROJECTION_VERSION: i64 = 1;

pub(crate) fn projection_ready(conn: &Connection) -> AppResult<bool> {
    let value: Option<i64> = conn
        .query_row(
            "SELECT value FROM task_meta WHERE key = 'projection'",
            [],
            |row| row.get(0),
        )
        .ok();
    Ok(value == Some(PROJECTION_VERSION))
}

pub(crate) fn mark_projection_ready(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "INSERT INTO task_meta (key, value) VALUES ('projection', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![PROJECTION_VERSION],
    )?;
    Ok(())
}

/// Replace every task row for one note. Called from `Index::index_one` inside
/// the note's own transaction, so tasks and notes commit together.
pub(crate) fn index_tasks(
    conn: &Connection,
    note_id: &str,
    content: &str,
    generation: i64,
) -> AppResult<usize> {
    remove_note(conn, note_id)?;
    let tasks = parse_tasks(content);
    for task in &tasks {
        let section = serde_json::to_string(&task.section)
            .map_err(|e| AppError(format!("task section: {e}")))?;
        conn.execute(
            "INSERT INTO tasks (
                note_id, task_id, series_id, line, char_from, char_to, source_text,
                status, text, priority, due, scheduled, start, done, cancelled,
                created, recurrence, section, indent, generation
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                       ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                note_id,
                task.task_id,
                task.series_id(),
                task.line,
                task.char_from,
                task.char_to,
                task.source_text,
                task.status,
                task.text,
                task.priority,
                task.due,
                task.scheduled,
                task.start,
                task.done,
                task.cancelled,
                task.created,
                task.recurrence,
                section,
                task.indent,
                generation,
            ],
        )?;
        let row_id = conn.last_insert_rowid();
        for tag in &task.tags {
            conn.execute(
                "INSERT OR IGNORE INTO task_tags (row_id, tag) VALUES (?1, ?2)",
                params![row_id, tag],
            )?;
        }
    }
    Ok(tasks.len())
}

/// Drop a note's tasks — on delete, and on a note that is no longer parsed
/// (an oversized file keeps its row in `notes` but has no tasks).
pub(crate) fn remove_note(conn: &Connection, note_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM task_tags WHERE row_id IN (SELECT row_id FROM tasks WHERE note_id = ?1)",
        params![note_id],
    )?;
    conn.execute("DELETE FROM tasks WHERE note_id = ?1", params![note_id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/// The bounded filter set. Everything here is an indexed column or a join on
/// one; there is no expression to evaluate and no free-form SQL to inject.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct TaskQuery {
    /// Empty means any status.
    pub statuses: Vec<String>,
    pub due_before: Option<String>,
    pub due_after: Option<String>,
    pub due_on: Option<String>,
    /// Only tasks with no due date.
    pub due_none: bool,
    /// Vault-relative path PREFIX, compared case-insensitively.
    pub path_prefix: Option<String>,
    pub tag: Option<String>,
    pub text_contains: Option<String>,
    pub note_id: Option<String>,
    pub task_id: Option<String>,
    pub series_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct TaskPageRequest {
    pub limit: u32,
    pub offset: u32,
}

impl Default for TaskPageRequest {
    fn default() -> Self {
        Self {
            limit: DEFAULT_PAGE_SIZE,
            offset: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskPage {
    pub items: Vec<TaskRow>,
    /// `None` when this page is the last one.
    pub next_offset: Option<u32>,
    /// Total matches, so a panel can say "12 of 340" without a second query.
    pub total: u32,
    pub generation: i64,
}

pub(crate) fn query(
    conn: &Connection,
    query: &TaskQuery,
    page: &TaskPageRequest,
) -> AppResult<TaskPage> {
    if page.limit == 0 || page.limit > MAX_PAGE_SIZE {
        return Err(AppError(format!(
            "limit_exceeded: task query limit must be between 1 and {MAX_PAGE_SIZE}"
        )));
    }

    let mut where_sql = String::from(" WHERE 1 = 1");
    let mut args: Vec<String> = Vec::new();

    if !query.statuses.is_empty() {
        let slots: Vec<String> = query
            .statuses
            .iter()
            .map(|status| {
                args.push(status.clone());
                format!("?{}", args.len())
            })
            .collect();
        where_sql.push_str(&format!(" AND t.status IN ({})", slots.join(", ")));
    }
    let push = |sql: &str, value: String, where_sql: &mut String, args: &mut Vec<String>| {
        args.push(value);
        where_sql.push_str(&sql.replace("?#", &format!("?{}", args.len())));
    };
    if let Some(value) = &query.due_before {
        push(" AND t.due IS NOT NULL AND t.due < ?#", value.clone(), &mut where_sql, &mut args);
    }
    if let Some(value) = &query.due_after {
        push(" AND t.due IS NOT NULL AND t.due > ?#", value.clone(), &mut where_sql, &mut args);
    }
    if let Some(value) = &query.due_on {
        push(" AND t.due = ?#", value.clone(), &mut where_sql, &mut args);
    }
    if query.due_none {
        where_sql.push_str(" AND t.due IS NULL");
    }
    if let Some(value) = &query.path_prefix {
        // `_` and `%` are LIKE wildcards; a path that literally contains one
        // must match itself, not every sibling. Escape them (and the escape
        // char) and declare the escape so the prefix stays a literal prefix.
        let escaped = value
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        push(
            " AND lower(n.path) LIKE lower(?#) || '%' ESCAPE '\\'",
            escaped,
            &mut where_sql,
            &mut args,
        );
    }
    if let Some(value) = &query.tag {
        push(
            " AND EXISTS (SELECT 1 FROM task_tags g WHERE g.row_id = t.row_id AND lower(g.tag) = lower(?#))",
            value.clone(),
            &mut where_sql,
            &mut args,
        );
    }
    if let Some(value) = &query.text_contains {
        push(
            " AND lower(t.text) LIKE '%' || lower(?#) || '%'",
            value.clone(),
            &mut where_sql,
            &mut args,
        );
    }
    if let Some(value) = &query.note_id {
        push(" AND t.note_id = ?#", value.clone(), &mut where_sql, &mut args);
    }
    if let Some(value) = &query.task_id {
        push(" AND t.task_id = ?#", value.clone(), &mut where_sql, &mut args);
    }
    if let Some(value) = &query.series_id {
        push(" AND t.series_id = ?#", value.clone(), &mut where_sql, &mut args);
    }

    let total: u32 = conn.query_row(
        &format!("SELECT COUNT(*) FROM tasks t JOIN notes n ON n.id = t.note_id{where_sql}"),
        params_from_iter(args.iter()),
        |row| row.get::<_, i64>(0),
    )? as u32;

    // A task with no due date sorts after the dated ones, then by position —
    // the same total order the TypeScript `sortTasks` falls through to.
    let sql = format!(
        "SELECT t.note_id, n.path, t.task_id, t.series_id, t.line, t.char_from, t.char_to,
                t.source_text, t.status, t.text, t.priority, t.due, t.scheduled, t.start,
                t.done, t.cancelled, t.created, t.recurrence, t.section, t.indent, t.row_id
         FROM tasks t JOIN notes n ON n.id = t.note_id{where_sql}
         ORDER BY (t.due IS NULL), t.due, n.path, t.line
         LIMIT {} OFFSET {}",
        page.limit, page.offset
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), |row| {
        let section: String = row.get(18)?;
        let row_id: i64 = row.get(20)?;
        Ok((
            TaskRow {
                note_id: row.get(0)?,
                path: row.get(1)?,
                task_id: row.get(2)?,
                series_id: row.get(3)?,
                line: row.get(4)?,
                char_from: row.get(5)?,
                char_to: row.get(6)?,
                source_text: row.get(7)?,
                status: row.get(8)?,
                text: row.get(9)?,
                priority: row.get(10)?,
                due: row.get(11)?,
                scheduled: row.get(12)?,
                start: row.get(13)?,
                done: row.get(14)?,
                cancelled: row.get(15)?,
                created: row.get(16)?,
                recurrence: row.get(17)?,
                section: serde_json::from_str(&section).unwrap_or_default(),
                indent: row.get(19)?,
                tags: Vec::new(),
            },
            row_id,
        ))
    })?;

    let mut items: Vec<TaskRow> = Vec::new();
    for row in rows {
        let (mut task, row_id) = row?;
        let mut tag_stmt =
            conn.prepare("SELECT tag FROM task_tags WHERE row_id = ?1 ORDER BY tag")?;
        task.tags = tag_stmt
            .query_map(params![row_id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        items.push(task);
    }

    let consumed = page.offset as u64 + items.len() as u64;
    let next_offset = if consumed < total as u64 && !items.is_empty() {
        Some(consumed as u32)
    } else {
        None
    };
    let generation: i64 = conn.query_row("SELECT COALESCE(MAX(generation), 0) FROM tasks", [], |r| {
        r.get(0)
    })?;

    Ok(TaskPage {
        items,
        next_offset,
        total,
        generation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE);",
        )
        .unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn note(conn: &Connection, id: &str, path: &str) {
        conn.execute(
            "INSERT OR REPLACE INTO notes (id, path) VALUES (?1, ?2)",
            params![id, path],
        )
        .unwrap();
    }

    #[test]
    fn parses_a_task_line_into_its_fields() {
        let task = parse_task_line(
            "  - [x] Ship it ⏫ 🔁 every week ➕ 2026-01-01 🛫 2026-01-02 ⏳ 2026-01-03 📅 2026-01-04 ❌ 2026-01-05 ✅ 2026-01-06 #work 🆔 abc ^t-k3x9f2a0b1",
        )
        .unwrap();
        assert_eq!(task.status, "done");
        assert_eq!(task.text, "Ship it");
        assert_eq!(task.indent, "  ");
        assert_eq!(task.priority.as_deref(), Some("highest"));
        assert_eq!(task.recurrence.as_deref(), Some("every week"));
        assert_eq!(task.created.as_deref(), Some("2026-01-01"));
        assert_eq!(task.start.as_deref(), Some("2026-01-02"));
        assert_eq!(task.scheduled.as_deref(), Some("2026-01-03"));
        assert_eq!(task.due.as_deref(), Some("2026-01-04"));
        assert_eq!(task.cancelled.as_deref(), Some("2026-01-05"));
        assert_eq!(task.done.as_deref(), Some("2026-01-06"));
        assert_eq!(task.tags, vec!["work".to_string()]);
        assert_eq!(task.task_id.as_deref(), Some("t-k3x9f2a0b1"));
        assert_eq!(task.series_id().as_deref(), Some("t-k3x9f2a0b1"));
    }

    #[test]
    fn rejects_everything_that_is_not_a_task_line() {
        for line in [
            "- [ ]",
            "-[ ] no space",
            "- [] empty",
            "- [?] unknown",
            "text - [ ] not at the start",
            "# Heading",
            "",
        ] {
            assert!(parse_task_line(line).is_none(), "{line}");
        }
        assert_eq!(parse_task_line("- [ ] ").unwrap().text, "");
    }

    #[test]
    fn reads_every_status_and_the_emoji_priority() {
        assert_eq!(parse_task_line("- [ ] a").unwrap().status, "todo");
        assert_eq!(parse_task_line("- [X] a").unwrap().status, "done");
        assert_eq!(parse_task_line("- [/] a").unwrap().status, "in-progress");
        assert_eq!(parse_task_line("- [-] a").unwrap().status, "cancelled");
        assert_eq!(
            parse_task_line("- [ ] a ▶\u{fe0f}").unwrap().priority.as_deref(),
            Some("medium")
        );
        assert_eq!(parse_task_line("- [ ] a ▶").unwrap().priority.as_deref(), Some("medium"));
    }

    #[test]
    fn never_invents_a_date_or_a_series() {
        let task = parse_task_line("- [ ] a 📅 next friday 🔺").unwrap();
        assert_eq!(task.due, None);
        assert_eq!(task.text, "a");
        assert_eq!(task.priority, None);
        assert_eq!(parse_task_line("- [ ] a ^t-k3x9f2a0b1").unwrap().series_id(), None);
    }

    #[test]
    fn skips_frontmatter_and_fenced_code_and_tracks_headings() {
        let content = "---\ntitle: T\n---\n- [ ] top\n# One\n- [ ] under one\n## Two\n- [ ] under two\n```\n- [ ] in a fence\n```\n- [ ] after the fence\n";
        let tasks = parse_tasks(content);
        assert_eq!(
            tasks.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
            vec!["top", "under one", "under two", "after the fence"]
        );
        assert!(tasks[0].section.is_empty());
        assert_eq!(tasks[2].section, vec!["One".to_string(), "Two".to_string()]);
    }

    #[test]
    fn offsets_are_utf16_and_land_on_the_line() {
        let content = "# 📅 Title\n- [ ] one\n- [ ] two 📅 2026-03-09\n";
        let utf16: Vec<u16> = content.encode_utf16().collect();
        for task in parse_tasks(content) {
            let slice = String::from_utf16(
                &utf16[task.char_from as usize..task.char_to as usize],
            )
            .unwrap();
            assert_eq!(slice, task.source_text);
        }
    }

    #[test]
    fn indexes_and_queries_a_note() {
        let conn = conn();
        note(&conn, "n1", "Projects/Work.md");
        let written = index_tasks(
            &conn,
            "n1",
            "# Work\n- [ ] Alpha ⏫ 📅 2026-03-09 #work\n- [x] Beta ✅ 2026-03-10\n- [ ] Gamma 🔁 every day 📅 2026-03-20 ^t-k3x9f2a0b1\n",
            1,
        )
        .unwrap();
        assert_eq!(written, 3);

        let all = query(&conn, &TaskQuery::default(), &TaskPageRequest::default()).unwrap();
        assert_eq!(all.total, 3);
        assert_eq!(all.generation, 1);
        assert_eq!(all.next_offset, None);
        // Due order first, undated last.
        assert_eq!(all.items[0].text, "Alpha");
        assert_eq!(all.items[0].tags, vec!["work".to_string()]);
        assert_eq!(all.items[0].section, vec!["Work".to_string()]);
        assert_eq!(all.items.last().unwrap().text, "Beta");

        let todo = query(
            &conn,
            &TaskQuery {
                statuses: vec!["todo".into()],
                ..Default::default()
            },
            &TaskPageRequest::default(),
        )
        .unwrap();
        assert_eq!(todo.total, 2);

        let due = query(
            &conn,
            &TaskQuery {
                due_before: Some("2026-03-10".into()),
                ..Default::default()
            },
            &TaskPageRequest::default(),
        )
        .unwrap();
        assert_eq!(due.items.len(), 1);
        assert_eq!(due.items[0].text, "Alpha");

        for (q, expected) in [
            (
                TaskQuery {
                    due_none: true,
                    ..Default::default()
                },
                "Beta",
            ),
            (
                TaskQuery {
                    tag: Some("WORK".into()),
                    ..Default::default()
                },
                "Alpha",
            ),
            (
                TaskQuery {
                    text_contains: Some("amm".into()),
                    ..Default::default()
                },
                "Gamma",
            ),
            (
                TaskQuery {
                    path_prefix: Some("projects/".into()),
                    ..Default::default()
                },
                "Alpha",
            ),
            (
                TaskQuery {
                    task_id: Some("t-k3x9f2a0b1".into()),
                    ..Default::default()
                },
                "Gamma",
            ),
            (
                TaskQuery {
                    series_id: Some("t-k3x9f2a0b1".into()),
                    ..Default::default()
                },
                "Gamma",
            ),
        ] {
            let page = query(&conn, &q, &TaskPageRequest::default()).unwrap();
            assert_eq!(page.items[0].text, expected, "{q:?}");
        }
    }

    #[test]
    fn re_indexing_replaces_a_notes_rows_and_deleting_clears_them() {
        let conn = conn();
        note(&conn, "n1", "A.md");
        index_tasks(&conn, "n1", "- [ ] one\n- [ ] two\n", 1).unwrap();
        index_tasks(&conn, "n1", "- [ ] one\n", 2).unwrap();
        let page = query(&conn, &TaskQuery::default(), &TaskPageRequest::default()).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.generation, 2);
        remove_note(&conn, "n1").unwrap();
        let empty = query(&conn, &TaskQuery::default(), &TaskPageRequest::default()).unwrap();
        assert_eq!(empty.total, 0);
        let orphans: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_tags", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphans, 0);
    }

    #[test]
    fn path_prefix_treats_underscore_and_percent_literally() {
        let conn = conn();
        note(&conn, "n1", "Projects/a_b/x.md");
        note(&conn, "n2", "Projects/aXb/decoy.md"); // matches only if `_` is a wildcard
        note(&conn, "n3", "Notes/50%/y.md");
        note(&conn, "n4", "Notes/5099/z.md"); // matches only if `%` is a wildcard
        index_tasks(&conn, "n1", "- [ ] one\n", 1).unwrap();
        index_tasks(&conn, "n2", "- [ ] two\n", 1).unwrap();
        index_tasks(&conn, "n3", "- [ ] three\n", 1).unwrap();
        index_tasks(&conn, "n4", "- [ ] four\n", 1).unwrap();

        let underscore = query(
            &conn,
            &TaskQuery {
                path_prefix: Some("Projects/a_b/".into()),
                ..Default::default()
            },
            &TaskPageRequest::default(),
        )
        .unwrap();
        assert_eq!(
            underscore.items.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
            vec!["one"]
        );

        let percent = query(
            &conn,
            &TaskQuery {
                path_prefix: Some("Notes/50%/".into()),
                ..Default::default()
            },
            &TaskPageRequest::default(),
        )
        .unwrap();
        assert_eq!(
            percent.items.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
            vec!["three"]
        );
    }

    #[test]
    fn a_loose_leading_dashes_line_is_not_frontmatter() {
        // `--- draft` is not an exact fence, so the task below it is kept.
        let tasks = parse_tasks("--- draft\n- [ ] Task\n");
        assert_eq!(
            tasks.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
            vec!["Task"]
        );

        // A proper `---` fence still opens frontmatter and swallows its keys.
        let tasks = parse_tasks("---\nkey: val\n---\n- [ ] Task\n");
        assert_eq!(
            tasks.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
            vec!["Task"]
        );
    }

    #[test]
    fn the_projection_marker_forces_one_backfill_pass() {
        let conn = conn();
        assert!(!projection_ready(&conn).unwrap());
        mark_projection_ready(&conn).unwrap();
        assert!(projection_ready(&conn).unwrap());
    }

    #[test]
    fn a_page_is_bounded_and_pages_forward() {
        let conn = conn();
        note(&conn, "n1", "A.md");
        let body: String = (1..=5)
            .map(|i| format!("- [ ] task {i} 📅 2026-03-0{i}\n"))
            .collect();
        index_tasks(&conn, "n1", &body, 1).unwrap();

        let first = query(
            &conn,
            &TaskQuery::default(),
            &TaskPageRequest {
                limit: 2,
                offset: 0,
            },
        )
        .unwrap();
        assert_eq!(first.items.len(), 2);
        assert_eq!(first.total, 5);
        assert_eq!(first.next_offset, Some(2));

        let last = query(
            &conn,
            &TaskQuery::default(),
            &TaskPageRequest {
                limit: 2,
                offset: 4,
            },
        )
        .unwrap();
        assert_eq!(last.items.len(), 1);
        assert_eq!(last.next_offset, None);

        for limit in [0, MAX_PAGE_SIZE + 1] {
            assert!(query(&conn, &TaskQuery::default(), &TaskPageRequest { limit, offset: 0 }).is_err());
        }
    }
}
