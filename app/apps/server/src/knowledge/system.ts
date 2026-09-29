/**
 * The read-only system properties `created` and `modified`, and the ordering
 * rules for `query_knowledge`'s `sort` (docs/specs/06-note-knowledge-contract.md).
 *
 * Everything here mirrors the desktop's Rust (`src-tauri/src/note_times.rs` and
 * the `notes` query in `knowledge.rs`) byte-for-byte in behaviour; the shared
 * fixture `packages/contracts/fixtures/knowledge-sort-parity.json` pins both.
 *
 * Server semantics:
 * - `created` = frontmatter `created:` when it parses, else `notes.created_at`.
 * - `modified` = `notes.last_edited_at`, else `notes.created_at`. That column is
 *   stamped only by CONTENT edits (sync, MCP, reverts — never a rename or move,
 *   which bump `updated_at` instead), so it matches what a file mtime means on a
 *   desktop. It is throttled to one stamp per editor per minute
 *   (`versions/capture.ts`), so it is minute-accurate, not keystroke-accurate.
 * Both are epoch milliseconds (UTC).
 */

export const SYSTEM_PROPERTY_IDS = ["created", "modified"] as const;
export type SystemPropertyId = (typeof SYSTEM_PROPERTY_IDS)[number];

export function isSystemProperty(id: string): id is SystemPropertyId {
  return id === "created" || id === "modified";
}

const DAY_MS = 86_400_000;

export interface Timestamp {
  ms: number;
  dateOnly: boolean;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const GRAMMAR =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}(?::?\d{2}))?)?$/;

/**
 * `YYYY-MM-DD` or `YYYY-MM-DD[T ]HH:MM[:SS[.fff…]][Z|±HH:MM|±HHMM]`. A date is
 * that day's UTC midnight; a datetime without an offset is read as UTC; the
 * fraction is truncated to milliseconds. Anything else is null, never a guess.
 */
export function parseTimestamp(raw: string): Timestamp | null {
  const match = GRAMMAR.exec(raw.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  // Date.UTC maps years 0–99 to 1900–1999; setUTCFullYear keeps them literal.
  const date = new Date(Date.UTC(2000, month - 1, day));
  date.setUTCFullYear(year, month - 1, day);
  const dayMs = date.getTime();
  if (h === undefined) return { ms: dayMs, dateOnly: true };
  const hour = Number(h);
  const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const millis = frac === undefined ? 0 : Number(frac.slice(0, 3).padEnd(3, "0"));
  let offsetMinutes = 0;
  if (zone && zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    if (digits.length !== 4) return null;
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2));
    if (oh > 23 || om > 59) return null;
    offsetMinutes = (zone[0] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  return {
    ms: dayMs + ((hour * 60 + minute) * 60 + second) * 1000 + millis - offsetMinutes * 60_000,
    dateOnly: false,
  };
}

/** A predicate on a system property as a half-open `[lo, hi)` ms range. */
export interface MsRange {
  lo: number | null;
  hi: number | null;
}

/**
 * The range one predicate selects, or null when the predicate is not valid for
 * a system property (`contains`, a boolean, an unparseable string). A number is
 * an epoch-ms instant; a date-only string means the whole UTC day.
 */
export function systemRange(op: string, value: unknown): MsRange | null {
  let start: number;
  let end: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    start = Math.floor(value);
    end = start + 1;
  } else if (typeof value === "string") {
    const ts = parseTimestamp(value);
    if (!ts) return null;
    start = ts.ms;
    end = ts.ms + (ts.dateOnly ? DAY_MS : 1);
  } else {
    return null;
  }
  switch (op) {
    case "eq": return { lo: start, hi: end };
    case "lt": return { lo: null, hi: start };
    case "lte": return { lo: null, hi: end };
    case "gt": return { lo: end, hi: null };
    case "gte": return { lo: start, hi: null };
    default: return null;
  }
}

export type SortKeySpec = "name" | "created" | "modified" | { propertyId: string };

export interface KnowledgeSort {
  key: SortKeySpec;
  direction: "asc" | "desc";
}

/** Rank then value: numbers < booleans < text, like the Rust `SortValue`. */
export type SortValue =
  | { t: "n"; v: number }
  | { t: "b"; v: boolean }
  | { t: "s"; v: string };

const RANK = { n: 0, b: 1, s: 2 } as const;

/** ASCII-only case folding: identical to Rust's `to_ascii_lowercase`. */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

export function textSortValue(value: string | null | undefined): SortValue | null {
  return value ? { t: "s", v: asciiLower(value) } : null;
}

/** UTF-8 byte order (Rust's `str` order), not JS's UTF-16 code-unit order. */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function compareValues(a: SortValue, b: SortValue): number {
  if (a.t !== b.t) return RANK[a.t] - RANK[b.t];
  if (a.t === "n") return Math.sign(a.v - (b as { v: number }).v);
  if (a.t === "b") return Number(a.v) - Number((b as { v: boolean }).v);
  return compareBytes(a.v, (b as { v: string }).v);
}

/**
 * Present values in `direction`, absent values LAST in both directions, and
 * every tie broken by doc id ascending.
 */
export function compareSorted(
  a: { key: SortValue | null; docId: string },
  b: { key: SortValue | null; docId: string },
  direction: "asc" | "desc",
): number {
  let order = 0;
  if (a.key && b.key) {
    order = compareValues(a.key, b.key);
    if (direction === "desc") order = -order;
  } else if (a.key) {
    order = -1;
  } else if (b.key) {
    order = 1;
  }
  return order !== 0 ? order : compareBytes(a.docId, b.docId);
}

/** The filename stem the UI shows — the `name` sort key. */
export function noteName(relPath: string): string {
  const base = relPath.replace(/^.*\//, "");
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
