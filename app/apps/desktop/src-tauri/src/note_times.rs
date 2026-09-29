//! The two read-only system properties every note has: `created` and `modified`.
//!
//! Both are epoch MILLISECONDS (UTC) everywhere they cross a seam, so the local
//! index and the server's `query_knowledge` compare the same integers. The
//! timestamp grammar below is mirrored byte-for-byte by the server
//! (`server/src/knowledge/system.ts`); change one, change both, and re-run the
//! shared parity fixture (`packages/contracts/fixtures/knowledge-sort-parity.json`).
//!
//! `created` resolves in this order (docs/specs/06-note-knowledge-contract.md):
//! 1. frontmatter `created:` when it parses (user-owned, travels with the file);
//! 2. the server's `notes.created_at` for synced notes, which the registry pull
//!    records through `record_server_created_times` (not re-derivable from the
//!    file, so `rebuild` never touches it — like the CRDT tables);
//! 3. the file's birthtime, local-only vaults' last resort. Atomic saves
//!    (temp + rename) give the file a new inode on every write, so the index
//!    keeps the EARLIEST birthtime it has seen for a note rather than the
//!    current one. Some filesystems have no birthtime at all → null.
//!
//! `modified` is the indexed file mtime. On a freshly synced device every mtime
//! is the moment the note was materialized there, not when anyone edited it:
//! fine for sorting, and documented rather than papered over.

pub const CREATED: &str = "created";
pub const MODIFIED: &str = "modified";

/// Frontmatter key that supplies `created` when present and parseable.
pub const CREATED_FRONTMATTER_KEY: &str = "created";

const DAY_MS: i64 = 86_400_000;

/// Is `id` one of the reserved system property ids?
pub fn is_system_property(id: &str) -> bool {
    id == CREATED || id == MODIFIED
}

/// A parsed timestamp: its instant, and whether it named a whole day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timestamp {
    pub ms: i64,
    pub date_only: bool,
}

fn digits(bytes: &[u8], from: usize, len: usize) -> Option<i64> {
    let slice = bytes.get(from..from + len)?;
    if !slice.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(slice.iter().fold(0i64, |acc, b| acc * 10 + i64::from(b - b'0')))
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        _ => 28,
    }
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Parse `YYYY-MM-DD` or `YYYY-MM-DD[T ]HH:MM[:SS[.fff…]][Z|±HH:MM|±HHMM]`.
///
/// A date alone is that day's UTC midnight; a datetime without an offset is
/// read as UTC, so every device (and the server) derives the same instant from
/// the same bytes. Fractions are truncated to milliseconds. Anything else —
/// including out-of-range fields — is `None`, never a guess.
pub fn parse_timestamp(raw: &str) -> Option<Timestamp> {
    let s = raw.trim();
    let b = s.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let year = digits(b, 0, 4)?;
    let month = digits(b, 5, 2)?;
    let day = digits(b, 8, 2)?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let date_ms = days_from_civil(year, month, day) * DAY_MS;
    if b.len() == 10 {
        return Some(Timestamp {
            ms: date_ms,
            date_only: true,
        });
    }
    if !matches!(b[10], b'T' | b' ') || b.get(13) != Some(&b':') {
        return None;
    }
    let hour = digits(b, 11, 2)?;
    let minute = digits(b, 14, 2)?;
    let mut pos = 16;
    let mut second = 0;
    let mut millis = 0;
    if b.get(pos) == Some(&b':') {
        second = digits(b, pos + 1, 2)?;
        pos += 3;
        if b.get(pos) == Some(&b'.') {
            let start = pos + 1;
            let mut end = start;
            while b.get(end).is_some_and(u8::is_ascii_digit) {
                end += 1;
            }
            if end == start {
                return None;
            }
            for (i, byte) in b[start..end.min(start + 3)].iter().enumerate() {
                millis += i64::from(byte - b'0') * [100, 10, 1][i];
            }
            pos = end;
        }
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let offset_minutes = match b.get(pos) {
        None => 0,
        Some(b'Z') if pos + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) => {
            let oh = digits(b, pos + 1, 2)?;
            let rest = &b[pos + 3..];
            let om = match rest {
                [b':', ..] if rest.len() == 3 => digits(rest, 1, 2)?,
                _ if rest.len() == 2 => digits(rest, 0, 2)?,
                _ => return None,
            };
            if oh > 23 || om > 59 {
                return None;
            }
            let total = oh * 60 + om;
            if *sign == b'-' {
                -total
            } else {
                total
            }
        }
        _ => return None,
    };
    let local_ms = date_ms + ((hour * 60 + minute) * 60 + second) * 1000 + millis;
    Some(Timestamp {
        ms: local_ms - offset_minutes * 60_000,
        date_only: false,
    })
}

/// The frontmatter `created:` instant, when the note has a parseable one.
pub fn frontmatter_created_ms(frontmatter: &serde_json::Map<String, serde_json::Value>) -> Option<i64> {
    frontmatter
        .get(CREATED_FRONTMATTER_KEY)
        .and_then(serde_json::Value::as_str)
        .and_then(parse_timestamp)
        .map(|ts| ts.ms)
}

/// A file's birthtime in epoch ms, or `None` where the filesystem has none.
pub fn file_birthtime_ms(abs: &std::path::Path) -> Option<i64> {
    std::fs::metadata(abs)
        .and_then(|m| m.created())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

/// Where a note's `created` value came from.
pub fn created_source(
    frontmatter: Option<i64>,
    server: Option<i64>,
    birthtime: Option<i64>,
) -> (Option<i64>, Option<&'static str>) {
    if let Some(ms) = frontmatter {
        (Some(ms), Some("frontmatter"))
    } else if let Some(ms) = server {
        (Some(ms), Some("server"))
    } else if let Some(ms) = birthtime {
        (Some(ms), Some("birthtime"))
    } else {
        (None, None)
    }
}

/// A `where` predicate on a system property, reduced to a half-open integer
/// range `[lo, hi)`. A date-only value means the whole UTC day, so
/// `created eq 2026-09-01` matches anything created that day and
/// `created lte 2026-09-01` includes all of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MsRange {
    pub lo: Option<i64>,
    pub hi: Option<i64>,
}

impl MsRange {
    pub fn contains(&self, value: i64) -> bool {
        self.lo.is_none_or(|lo| value >= lo) && self.hi.is_none_or(|hi| value < hi)
    }
}

/// `op` is one of eq/lt/lte/gt/gte. `start..end` is the value's own span: one
/// millisecond for an instant, one day for a date.
pub fn system_range(op: &str, start: i64, end: i64) -> Option<MsRange> {
    Some(match op {
        "eq" => MsRange {
            lo: Some(start),
            hi: Some(end),
        },
        "lt" => MsRange {
            lo: None,
            hi: Some(start),
        },
        "lte" => MsRange {
            lo: None,
            hi: Some(end),
        },
        "gt" => MsRange {
            lo: Some(end),
            hi: None,
        },
        "gte" => MsRange {
            lo: Some(start),
            hi: None,
        },
        _ => return None,
    })
}

/// The span a predicate value names: a number is an epoch-ms instant, a string
/// a timestamp in the grammar above.
pub fn value_span(value: &serde_json::Value) -> Option<(i64, i64)> {
    match value {
        serde_json::Value::Number(n) => {
            let ms = n.as_i64().or_else(|| n.as_f64().map(|f| f.floor() as i64))?;
            Some((ms, ms + 1))
        }
        serde_json::Value::String(s) => {
            let ts = parse_timestamp(s)?;
            Some((ts.ms, ts.ms + if ts.date_only { DAY_MS } else { 1 }))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dates_and_datetimes_to_utc_millis() {
        assert_eq!(parse_timestamp("1970-01-01").unwrap().ms, 0);
        assert!(parse_timestamp("1970-01-01").unwrap().date_only);
        assert_eq!(parse_timestamp("2026-09-01").unwrap().ms, 1_788_220_800_000);
        assert_eq!(
            parse_timestamp("2026-09-01T10:30").unwrap().ms,
            1_788_220_800_000 + 37_800_000
        );
        assert_eq!(
            parse_timestamp("2026-09-01 10:30:15.1239Z").unwrap().ms,
            1_788_220_800_000 + 37_815_123
        );
        assert_eq!(
            parse_timestamp("2026-09-01T12:30:00+02:00").unwrap().ms,
            parse_timestamp("2026-09-01T10:30:00Z").unwrap().ms
        );
        assert_eq!(
            parse_timestamp("2026-09-01T05:30:00-0500").unwrap().ms,
            parse_timestamp("2026-09-01T10:30:00Z").unwrap().ms
        );
        assert_eq!(parse_timestamp("2024-02-29").unwrap().ms, 1_709_164_800_000);
        assert_eq!(parse_timestamp("1969-12-31").unwrap().ms, -86_400_000);
    }

    #[test]
    fn rejects_everything_outside_the_grammar() {
        for bad in [
            "", "2026", "2026-9-01", "2026-13-01", "2026-02-30", "2025-02-29",
            "2026-09-01T25:00", "2026-09-01T10:60", "2026-09-01T10:00:60",
            "2026-09-01T10", "2026-09-01T10:00:00.", "2026-09-01T10:00Zjunk",
            "2026-09-01T10:00+2", "2026-09-01t10:00", "yesterday", "2026-09-01x",
        ] {
            assert!(parse_timestamp(bad).is_none(), "accepted {bad:?}");
        }
    }

    #[test]
    fn date_only_predicates_cover_the_whole_day() {
        let (start, end) = value_span(&serde_json::json!("2026-09-01")).unwrap();
        assert_eq!(end - start, DAY_MS);
        let eq = system_range("eq", start, end).unwrap();
        assert!(eq.contains(start) && eq.contains(end - 1) && !eq.contains(end));
        assert!(system_range("lte", start, end).unwrap().contains(end - 1));
        assert!(!system_range("gt", start, end).unwrap().contains(end - 1));
        assert!(system_range("contains", start, end).is_none());
        assert_eq!(value_span(&serde_json::json!(5)), Some((5, 6)));
        assert!(value_span(&serde_json::json!(true)).is_none());
    }

    #[test]
    fn created_resolution_prefers_frontmatter_then_server_then_birthtime() {
        assert_eq!(created_source(Some(1), Some(2), Some(3)), (Some(1), Some("frontmatter")));
        assert_eq!(created_source(None, Some(2), Some(3)), (Some(2), Some("server")));
        assert_eq!(created_source(None, None, Some(3)), (Some(3), Some("birthtime")));
        assert_eq!(created_source(None, None, None), (None, None));
    }
}
