/**
 * The task line parser.
 *
 * One line at a time, because that is the unit everything else works in: the
 * index stores one row per line, the adapter re-finds one line in live text,
 * and every write is a span inside one line. Nothing here reads a file, hashes
 * anything or knows what a note is.
 *
 * Two things this file is strict about:
 *
 *   1. NOTHING IS LOST. Every byte after the checkbox is accounted for by
 *      exactly one of: the description, a recognised field, an `unparsed`
 *      entry, or the whitespace recorded as a segment's `gap`. `serializeTask`
 *      (in `serialize.ts`) walks the same structure back, so a line we only
 *      half understand round-trips byte for byte.
 *   2. NOTHING IS GUESSED. `📅 next friday` is not a date, so the whole
 *      `📅 next friday` stays verbatim in `unparsed` instead of becoming a
 *      date we invented. The same goes for a recurrence rule outside the
 *      supported subset — it keeps its `raw` and gets `rule: null`.
 *
 * `scanTaskLine` is the shared internal: `serialize.ts` and `edit.ts` use it to
 * find the span a field occupies, which is why no other module has to know how
 * a marker is spelled.
 */

import {
  CHECKBOX_STATUS,
  MARKERS,
  PLAIN_DATE_RE,
  PRIORITY_MARKERS,
  TASK_ID_SUFFIX_RE,
  TASK_LINE_RE,
  type MarkerField,
  type PlainDate,
  type Priority,
  type Recurrence,
  type Task,
  type TaskStatus,
} from "./contracts";
import { parseRecurrence } from "./recurrence";

/** The six markers whose value is a `PlainDate`. */
export const DATE_FIELDS = [
  "created",
  "start",
  "scheduled",
  "due",
  "cancelled",
  "done",
] as const;
export type TaskDateField = (typeof DATE_FIELDS)[number];

/**
 * `▶️` is `▶` plus VARIATION SELECTOR-16. Editors and phone keyboards emit the
 * emoji-presentation form; the frozen marker is the bare glyph. We READ both
 * and WRITE the frozen one — but only when the priority itself is edited, so a
 * file that says `▶️` keeps saying `▶️` until someone changes its priority.
 */
export const PRIORITY_MEDIUM_EMOJI = "▶️";

/**
 * Glyphs that begin a FIELD rather than a word. Recognised fields are parsed;
 * the rest are preserved verbatim. `🔺` (Obsidian Tasks' highest) and `🏁`
 * (its on-completion action) are listed so they are preserved as fields
 * instead of being mistaken for description words.
 */
const VALUE_GLYPHS = [MARKERS.id, MARKERS.dependsOn, "🏁"];
const STANDALONE_GLYPHS = ["🔺"];

const PRIORITY_GLYPHS: ReadonlyArray<[string, Priority]> = [
  [PRIORITY_MARKERS.highest, "highest"],
  [PRIORITY_MARKERS.high, "high"],
  [PRIORITY_MEDIUM_EMOJI, "medium"],
  [PRIORITY_MARKERS.medium, "medium"],
  [PRIORITY_MARKERS.low, "low"],
  [PRIORITY_MARKERS.lowest, "lowest"],
];

const DATE_GLYPHS: ReadonlyArray<[string, TaskDateField]> = DATE_FIELDS.map(
  (field) => [MARKERS[field], field] as [string, TaskDateField],
);

/** Every glyph that ends the previous field's value. Order matters only in
 *  that `▶️` must be tried before `▶`. */
const ALL_GLYPHS: readonly string[] = [
  ...PRIORITY_GLYPHS.map(([g]) => g),
  ...DATE_GLYPHS.map(([g]) => g),
  MARKERS.recurrence,
  ...VALUE_GLYPHS,
  ...STANDALONE_GLYPHS,
];

/** Mirrors Rust `parse.rs TAG_RE` exactly — one contract, two implementations. */
export const TAG_RE = /(?:^|[^\p{L}\p{N}_/])#(\d*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export type SegmentKind = "date" | "priority" | "recurrence" | "unparsed";

/** One field-shaped run of the line, with the whitespace that precedes it. */
export interface TailSegment {
  kind: SegmentKind;
  /** For `date` and `recurrence`: which field. */
  field?: MarkerField;
  /** Offsets RELATIVE TO THE LINE. */
  from: number;
  to: number;
  /** The whitespace immediately before `from`, verbatim. */
  gap: string;
  /** `line.slice(from, to)`. */
  raw: string;
  /** Date string or recurrence text; absent for `priority`/`unparsed`. */
  value?: string;
  /** Span of `value` within the line, for a minimal replacement. */
  valueFrom?: number;
  valueTo?: number;
  /** Priority, when `kind === "priority"`. */
  priority?: Priority;
}

/**
 * The shape of a task line, with every offset relative to the line's own
 * start. `edit.ts` adds `task.from` to reach doc-absolute coordinates.
 */
export interface TaskLineScan {
  indent: string;
  bullet: string;
  /** Between the bullet and `[` — `\s+`, so it can be more than one space. */
  bulletGap: string;
  checkbox: string;
  /** Offset of the checkbox character itself. */
  checkboxAt: number;
  /** The single `\s` after `]`, which the regex consumes. */
  separator: string;
  /** Offset where the description text begins (after the separator). */
  textFrom: number;
  /** Whitespace between the separator and the description. */
  leadGap: string;
  /** The description, verbatim, with no leading or trailing whitespace. */
  description: string;
  descriptionFrom: number;
  descriptionTo: number;
  /** Whitespace after the description when nothing else follows it. */
  trailGap: string;
  segments: TailSegment[];
  /** Offset where the tail ends: the start of the id suffix, or the line end. */
  tailEnd: number;
  id: string | null;
  /** The `\s` before `^`, when there is an id. */
  idGap: string;
}

function glyphAt(token: string): string | null {
  for (const glyph of ALL_GLYPHS) if (token.startsWith(glyph)) return glyph;
  return null;
}

/**
 * Split a line into its parts without interpreting any of them. Returns `null`
 * for anything that is not a task line, which is the only "is this a task"
 * test in the codebase.
 */
export function scanTaskLine(line: string): TaskLineScan | null {
  const m = TASK_LINE_RE.exec(line);
  if (!m) return null;
  const indent = m[1]!;
  const bullet = m[2]!;
  const checkbox = m[3]!;
  const rest = m[4]!;
  // The regex's fixed suffix is `[c]` + one `\s`, so the geometry is exact.
  const textFrom = line.length - rest.length;
  const checkboxAt = textFrom - 3;
  const separator = line.slice(textFrom - 1, textFrom);
  const bulletGap = line.slice(indent.length + 1, checkboxAt - 1);

  // The id suffix comes off first: it is anchored to the end of the line and
  // must not be mistaken for a field or a word.
  const idMatch = TASK_ID_SUFFIX_RE.exec(rest);
  const id = idMatch ? idMatch[1]! : null;
  const idGap = idMatch ? idMatch[0]!.slice(0, 1) : "";
  const tailEnd = idMatch ? textFrom + rest.length - idMatch[0]!.length : line.length;
  const tail = line.slice(textFrom, tailEnd);

  const leadGap = /^\s*/.exec(tail)![0]!;
  const segments: TailSegment[] = [];

  const tokenRe = /\S+/g;
  let token: RegExpExecArray | null;
  const tokens: Array<{ text: string; at: number }> = [];
  while ((token = tokenRe.exec(tail)) !== null) {
    tokens.push({ text: token[0]!, at: token.index });
  }

  let firstSegmentAt = tail.length;
  let i = 0;
  const push = (from: number, to: number, extra: Partial<TailSegment> & { kind: SegmentKind }) => {
    const absFrom = textFrom + from;
    const absTo = textFrom + to;
    // The whitespace before a segment belongs to the segment, so dropping the
    // segment drops its separator too and serialization stays byte-exact.
    const gapStart =
      segments.length === 0
        ? textFrom + leadGap.length + tail.slice(leadGap.length, from).replace(/\s+$/, "").length
        : segments[segments.length - 1]!.to;
    segments.push({
      ...extra,
      from: absFrom,
      to: absTo,
      gap: line.slice(gapStart, absFrom),
      raw: line.slice(absFrom, absTo),
    });
  };

  while (i < tokens.length) {
    const tk = tokens[i]!;
    const glyph = glyphAt(tk.text);
    if (glyph === null) {
      // Ordinary word. Before the first field it is description; after one it
      // is preserved verbatim rather than folded back into the description,
      // because we cannot put it back where it was otherwise.
      if (segments.length === 0) {
        i += 1;
        continue;
      }
      push(tk.at, tk.at + tk.text.length, { kind: "unparsed" });
      i += 1;
      continue;
    }
    if (segments.length === 0) firstSegmentAt = tk.at;

    const inline = tk.text.slice(glyph.length);
    const priority = PRIORITY_GLYPHS.find(([g]) => g === glyph)?.[1];
    if (priority && inline === "") {
      push(tk.at, tk.at + tk.text.length, { kind: "priority", priority });
      i += 1;
      continue;
    }
    const dateField = DATE_GLYPHS.find(([g]) => g === glyph)?.[1];
    if (dateField) {
      // `📅 2026-03-09` and `📅2026-03-09` are both real in the wild.
      const next = tokens[i + 1];
      const valueText = inline !== "" ? inline : (next?.text ?? "");
      const valueAt = inline !== "" ? tk.at + glyph.length : (next?.at ?? tk.at + tk.text.length);
      const consumed = inline !== "" ? i + 1 : i + 2;
      if (PLAIN_DATE_RE.test(valueText)) {
        push(tk.at, valueAt + valueText.length, {
          kind: "date",
          field: dateField,
          value: valueText,
          valueFrom: textFrom + valueAt,
          valueTo: textFrom + valueAt + valueText.length,
        });
        i = consumed;
        continue;
      }
      // Not a date: keep the glyph AND whatever followed it, verbatim.
      const end = next && inline === "" ? next.at + next.text.length : tk.at + tk.text.length;
      push(tk.at, end, { kind: "unparsed" });
      i = next && inline === "" ? i + 2 : i + 1;
      continue;
    }
    if (glyph === MARKERS.recurrence) {
      // The rule runs to the end of the tail or to the next field glyph.
      let end = tail.length;
      for (let j = i + 1; j < tokens.length; j += 1) {
        if (glyphAt(tokens[j]!.text) !== null) {
          end = tokens[j - 1]!.at + tokens[j - 1]!.text.length;
          break;
        }
      }
      const valueAt = tk.at + glyph.length;
      const rawValue = tail.slice(valueAt, end);
      const trimmedStart = valueAt + (/^\s*/.exec(rawValue)![0]!.length);
      const value = tail.slice(trimmedStart, end);
      push(tk.at, end, {
        kind: "recurrence",
        field: "recurrence",
        value,
        valueFrom: textFrom + trimmedStart,
        valueTo: textFrom + end,
      });
      while (i < tokens.length && tokens[i]!.at < end) i += 1;
      continue;
    }
    // Preserved-but-not-modelled: `🆔 abc`, `⛔ abc`, `🏁 delete`, `🔺`.
    if (VALUE_GLYPHS.includes(glyph) && inline === "" && tokens[i + 1]) {
      const next = tokens[i + 1]!;
      push(tk.at, next.at + next.text.length, { kind: "unparsed" });
      i += 2;
      continue;
    }
    push(tk.at, tk.at + tk.text.length, { kind: "unparsed" });
    i += 1;
  }

  const descriptionRaw = tail.slice(leadGap.length, firstSegmentAt);
  const description = descriptionRaw.replace(/\s+$/, "");
  // Whatever whitespace is left over at the end of the tail (before the id
  // suffix) has to be recorded somewhere, or the round-trip loses it.
  const trailGap =
    segments.length === 0
      ? descriptionRaw.slice(description.length)
      : line.slice(segments[segments.length - 1]!.to, tailEnd);

  return {
    indent,
    bullet,
    bulletGap,
    checkbox,
    checkboxAt,
    separator,
    textFrom,
    leadGap,
    description,
    descriptionFrom: textFrom + leadGap.length,
    descriptionTo: textFrom + leadGap.length + description.length,
    trailGap,
    segments,
    tailEnd,
    id,
    idGap,
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Where the line sits. Everything here is a HINT except `docId`. */
export interface TaskLineContext {
  docId: string;
  path: string;
  /** Zero-based line number. */
  line: number;
  /** Doc-absolute offset of the line's first character. */
  from: number;
  /** Heading trail above the line, outermost first. */
  section?: string[];
}

export function tagsIn(text: string): string[] {
  const out: string[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text)) !== null) {
    const tag = m[1]!;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Parse ONE line. Returns `null` when the line is not a task. */
export function parseTaskLine(line: string, ctx: TaskLineContext): Task | null {
  const scan = scanTaskLine(line);
  if (!scan) return null;

  const status: TaskStatus = CHECKBOX_STATUS[scan.checkbox] ?? "todo";
  const dates: Record<TaskDateField, PlainDate | null> = {
    created: null,
    start: null,
    scheduled: null,
    due: null,
    cancelled: null,
    done: null,
  };
  let priority: Priority | null = null;
  let recurrence: Recurrence | null = null;
  const unparsed: string[] = [];
  for (const segment of scan.segments) {
    switch (segment.kind) {
      case "date":
        // First wins: a line with two `📅` keeps the second verbatim rather
        // than silently preferring one of them.
        if (dates[segment.field as TaskDateField] === null) {
          dates[segment.field as TaskDateField] = segment.value!;
        } else {
          unparsed.push(segment.raw);
        }
        break;
      case "priority":
        if (priority === null) priority = segment.priority!;
        else unparsed.push(segment.raw);
        break;
      case "recurrence":
        if (recurrence === null) recurrence = parseRecurrence(segment.value!);
        else unparsed.push(segment.raw);
        break;
      default:
        unparsed.push(segment.raw);
    }
  }

  return {
    id: scan.id,
    // A recurring line with no chain of its own heads its series; see the
    // `SeriesId` contract note.
    seriesId: recurrence ? scan.id : null,
    docId: ctx.docId,
    path: ctx.path,
    line: ctx.line,
    from: ctx.from,
    to: ctx.from + line.length,
    sourceText: line,
    status,
    text: scan.description,
    unparsed,
    priority,
    tags: tagsIn(line.slice(scan.textFrom, scan.tailEnd)),
    due: dates.due,
    scheduled: dates.scheduled,
    start: dates.start,
    done: dates.done,
    cancelled: dates.cancelled,
    created: dates.created,
    recurrence,
    section: ctx.section ? [...ctx.section] : [],
    indent: scan.indent,
  };
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Every task line in a note, in document order.
 *
 * Frontmatter and fenced code are skipped: a `- [ ] ` inside a code block is
 * documentation about tasks, not a task, and writing to it would corrupt the
 * example. Headings above a line become its `section` trail.
 */
export function parseTasks(markdown: string, docId: string, path: string): Task[] {
  const tasks: Task[] = [];
  const lines = markdown.split("\n");
  const section: Array<{ level: number; text: string }> = [];
  let offset = 0;
  let fence: string | null = null;
  let inFrontmatter = false;
  let i = 0;

  // A leading `---` fence is frontmatter, not a horizontal rule.
  const first = (lines[0] ?? "").replace(/\r$/, "");
  if (first.replace(/^﻿/, "") === "---") inFrontmatter = true;

  for (; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const from = offset;
    offset += raw.length + 1;

    if (inFrontmatter) {
      if (i > 0 && (line === "---" || line === "...")) inFrontmatter = false;
      continue;
    }
    const fenceMatch = FENCE_RE.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!) && fenceMatch[1]!.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      while (section.length > 0 && section[section.length - 1]!.level >= level) section.pop();
      section.push({ level, text: heading[2]!.trim() });
      continue;
    }
    const task = parseTaskLine(line, {
      docId,
      path,
      line: i,
      from,
      section: section.map((s) => s.text),
    });
    if (task) tasks.push(task);
  }
  return tasks;
}
