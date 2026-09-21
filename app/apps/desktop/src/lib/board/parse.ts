/**
 * A board is an ordinary Markdown note. This file turns one into spans.
 *
 * Three rules shape everything here:
 *
 * 1. NOTHING IS REFORMATTED. The parse keeps every byte it did not model —
 *    blank lines, trailing spaces, an Obsidian Kanban `**Complete**` marker,
 *    a `\r` — as verbatim text blocks, so `serializeBoard(parseBoard(t)) === t`
 *    for any `t`. Simply OPENING someone's board must not rewrite it.
 * 2. OFFSETS ARE HINTS. `from`/`to` describe the text they were parsed from.
 *    A write re-parses the LIVE text and plans against THOSE offsets (see
 *    `./move.ts`); an indexed offset never reaches a write.
 * 3. THE TASK LINE IS PARSED SHALLOWLY. A card is a task line, but the marker
 *    grammar (dates, priority, recurrence, tags) belongs to the task engine
 *    (`src/lib/tasks/parse.ts`). Here we read exactly what the board needs —
 *    the checkbox, the text and the `^t-` block id — and leave every marker in
 *    `task.text` verbatim. The board never writes a marker, so it cannot lose
 *    one; a caller that needs the structured fields re-parses the line with
 *    the engine's parser.
 */

import {
  BOARD_ARCHIVE_SEPARATOR,
  BOARD_KIND_VALUE,
  CHECKBOX_STATUS,
  KANBAN_PLUGIN_KEY,
  NOAM_KIND_KEY,
  TASK_ID_SUFFIX_RE,
  TASK_LINE_RE,
  type BoardCard,
  type BoardDocument,
  type BoardLane,
  type Task,
} from "../tasks/contracts";
import { readRecognisedSettings } from "./settings";

export interface Span {
  from: number;
  to: number;
}

/** A card plus the verbatim source it came from. */
export interface ParsedCard extends BoardCard {
  /** The card line AND its body lines, terminators included. What a move
   *  deletes from one place and inserts in another, unchanged. */
  raw: string;
  /** Span of `raw`. `task.from`/`task.to` are the card LINE alone. */
  from: number;
  to: number;
}

/** Either a card or the bytes between cards, in source order. */
export type LaneBlock =
  | { kind: "card"; card: ParsedCard }
  | { kind: "text"; text: string; from: number; to: number };

export interface ParsedLane extends BoardLane {
  cards: ParsedCard[];
  /** Bytes between the previous lane and this heading — the `***` rule and the
   *  blank lines around it. Empty for every lane that does not follow one. */
  before: string;
  /** The heading line, verbatim, terminator included. */
  heading: string;
  /** Everything under the heading, cards and filler alike, in source order. */
  blocks: LaneBlock[];
  /** Obsidian Kanban's `list-collapse`, positional over the live lanes. */
  collapsed: boolean;
}

export interface ParsedBoard extends BoardDocument {
  lanes: ParsedLane[];
  /** Everything before the first lane heading, frontmatter included. */
  preamble: string;
  /** Everything after the last lane, the settings block included. */
  tail: string;
  /** Span of the whole `%% kanban:settings … %%` block, or null. */
  settingsBlock: Span | null;
  /** Length of the text this was parsed from. A HINT, like every offset. */
  length: number;
  /** Hash of that text when the caller had one. */
  revision: string | null;
}

export interface ParseOptions {
  path?: string;
  docId?: string;
  revision?: string;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

interface RawLine {
  /** The line without its terminator and without a CRLF's `\r`. */
  content: string;
  from: number;
  /** End of `content`. */
  to: number;
  /** End of the line including `\r\n`. */
  end: number;
}

function splitLines(text: string): RawLine[] {
  const out: RawLine[] = [];
  let from = 0;
  for (;;) {
    const nl = text.indexOf("\n", from);
    if (nl === -1) {
      if (from < text.length) {
        const cr = text.endsWith("\r") ? 1 : 0;
        out.push({ content: text.slice(from, text.length - cr), from, to: text.length - cr, end: text.length });
      }
      return out;
    }
    const cr = nl > from && text[nl - 1] === "\r" ? 1 : 0;
    out.push({ content: text.slice(from, nl - cr), from, to: nl - cr, end: nl + 1 });
    from = nl + 1;
  }
}

// ---------------------------------------------------------------------------
// Frontmatter — two keys, read only
// ---------------------------------------------------------------------------

const FM_KEY_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

/** The frontmatter BODY (between the fences), or null when there is none. */
function frontmatterBody(text: string): string | null {
  if (!/^---[ \t]*\r?\n/.test(text)) return null;
  const start = text.indexOf("\n") + 1;
  const close = /^(?:---|\.\.\.)[ \t]*$/m;
  const rest = text.slice(start);
  const m = close.exec(rest);
  if (!m) return null;
  return rest.slice(0, m.index);
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

function frontmatterValue(body: string, key: string): string | null {
  for (const line of body.split("\n")) {
    const m = FM_KEY_RE.exec(line.replace(/\r$/, ""));
    if (m && m[1] === key) return unquote(m[2]);
  }
  return null;
}

/**
 * Is this note a board? `noam_kind: board` for a Noam-native one, or any
 * `kanban-plugin` value for a board Obsidian Kanban wrote. The key has to be
 * in the FRONTMATTER — the same words in the body are just words.
 */
export function isBoardDocument(text: string): boolean {
  const body = frontmatterBody(text);
  if (body === null) return false;
  if (frontmatterValue(body, NOAM_KIND_KEY) === BOARD_KIND_VALUE) return true;
  const plugin = frontmatterValue(body, KANBAN_PLUGIN_KEY);
  return plugin !== null && plugin !== "";
}

/** The `kanban-plugin` frontmatter value, or null. Exported for the exporter. */
export function kanbanPluginValue(text: string): string | null {
  const body = frontmatterBody(text);
  return body === null ? null : frontmatterValue(body, KANBAN_PLUGIN_KEY);
}

/** Span of the frontmatter's closing fence line, for an exporter that needs to
 *  add a key. Null when the note has no frontmatter. */
export function frontmatterCloseOffset(text: string): number | null {
  if (!/^---[ \t]*\r?\n/.test(text)) return null;
  const start = text.indexOf("\n") + 1;
  const m = /^(?:---|\.\.\.)[ \t]*$/m.exec(text.slice(start));
  return m ? start + m.index : null;
}

// ---------------------------------------------------------------------------
// The settings block
// ---------------------------------------------------------------------------

const SETTINGS_OPEN_RE = /^%%\s*kanban:settings\s*(?:%%)?\s*$/;
const SETTINGS_CLOSE_RE = /^%%\s*$/;
const FENCE_RE = /^\s*```/;

interface SettingsBlock {
  /** Index of the opening `%%` line. */
  line: number;
  from: number;
  to: number;
  json: Span | null;
}

function findSettingsBlock(lines: RawLine[]): SettingsBlock | null {
  let open = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (SETTINGS_OPEN_RE.test(lines[i].content)) {
      open = i;
      break;
    }
  }
  if (open === -1) return null;
  let close = -1;
  for (let i = open + 1; i < lines.length; i += 1) {
    if (SETTINGS_CLOSE_RE.test(lines[i].content)) {
      close = i;
      break;
    }
  }
  if (close === -1) return null;

  // The JSON is normally inside a fenced code block; older boards wrote it
  // bare. Either way the span is the JSON and nothing else, because a settings
  // edit replaces a slice of it (see `./settings.ts`).
  let first = open + 1;
  let last = close - 1;
  if (first <= last && FENCE_RE.test(lines[first].content) && FENCE_RE.test(lines[last].content)) {
    first += 1;
    last -= 1;
  }
  while (first <= last && lines[first].content.trim() === "") first += 1;
  while (last >= first && lines[last].content.trim() === "") last -= 1;
  return {
    line: open,
    from: lines[open].from,
    to: lines[close].to,
    json: first <= last ? { from: lines[first].from, to: lines[last].to } : null,
  };
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

const HEADING_RE = /^##\s+(.*)$/;

function headingOf(line: RawLine): string | null {
  const m = HEADING_RE.exec(line.content);
  return m ? m[1].trim() : null;
}

function isSeparator(line: RawLine): boolean {
  return line.content.trim() === BOARD_ARCHIVE_SEPARATOR;
}

/** A body line is indented and not blank; a blank line ends the card. */
function isBodyLine(content: string): boolean {
  return /^[ \t]+\S/.test(content);
}

function stripIndent(content: string, indent: string): string {
  return indent && content.startsWith(indent) ? content.slice(indent.length) : content;
}

export function parseBoard(text: string, opts: ParseOptions = {}): ParsedBoard {
  const path = opts.path ?? "";
  const docId = opts.docId ?? "";
  const lines = splitLines(text);
  const block = findSettingsBlock(lines);
  const limit = block ? block.line : lines.length;
  const scanEnd = block ? block.from : text.length;

  let i = 0;
  while (i < limit && headingOf(lines[i]) === null) i += 1;
  const preamble = text.slice(0, i < limit ? lines[i].from : scanEnd);

  const lanes: ParsedLane[] = [];
  let before = "";
  let archiveSeen = false;

  while (i < limit) {
    const title = headingOf(lines[i]);
    if (title === null) break;
    const head = lines[i];
    const lane: ParsedLane = {
      title,
      from: head.from,
      to: head.end,
      cards: [],
      archive: archiveSeen,
      before,
      heading: text.slice(head.from, head.end),
      blocks: [],
      collapsed: false,
    };
    before = "";
    i += 1;

    let fillerFrom = -1;
    const flush = (upto: number) => {
      if (fillerFrom >= 0 && upto > fillerFrom) {
        lane.blocks.push({ kind: "text", text: text.slice(fillerFrom, upto), from: fillerFrom, to: upto });
      }
      fillerFrom = -1;
    };

    while (i < limit) {
      const line = lines[i];
      if (headingOf(line) !== null) break;
      if (!archiveSeen && isSeparator(line)) break;

      const m = TASK_LINE_RE.exec(line.content);
      if (m && m[1] === "") {
        flush(line.from);
        let j = i + 1;
        while (j < limit && isBodyLine(lines[j].content)) j += 1;
        const cardTo = lines[j - 1].end;
        const rest = m[4];
        const idm = TASK_ID_SUFFIX_RE.exec(rest);
        const task: Task = {
          id: idm ? idm[1] : null,
          seriesId: null,
          docId,
          path,
          line: i,
          from: line.from,
          to: line.to,
          sourceText: line.content,
          status: CHECKBOX_STATUS[m[3]] ?? "todo",
          text: (idm ? rest.slice(0, idm.index) : rest).trim(),
          unparsed: [],
          priority: null,
          tags: [],
          due: null,
          scheduled: null,
          start: null,
          done: null,
          cancelled: null,
          created: null,
          recurrence: null,
          section: [title],
          indent: m[1],
        };
        const card: ParsedCard = {
          task,
          body: lines.slice(i + 1, j).map((b) => stripIndent(b.content, m[1])),
          raw: text.slice(line.from, cardTo),
          from: line.from,
          to: cardTo,
        };
        lane.cards.push(card);
        lane.blocks.push({ kind: "card", card });
        i = j;
        continue;
      }

      if (fillerFrom < 0) fillerFrom = line.from;
      i += 1;
    }

    const laneEnd = i < limit ? lines[i].from : scanEnd;
    flush(laneEnd);
    lane.to = laneEnd;
    lanes.push(lane);

    // The `***` rule and the blank lines after it belong to the archive lane
    // that follows, so a move into the archive cannot swallow the rule.
    if (i < limit && !archiveSeen && isSeparator(lines[i])) {
      const sepFrom = lines[i].from;
      let j = i + 1;
      while (j < limit && headingOf(lines[j]) === null && lines[j].content.trim() === "") j += 1;
      const stop = j < limit ? lines[j].from : scanEnd;
      if (j < limit && headingOf(lines[j]) !== null) {
        before = text.slice(sepFrom, stop);
        archiveSeen = true;
        i = j;
      } else {
        // A rule with no lane after it is just text at the end of the board.
        break;
      }
    }
  }

  const tail = before + text.slice(i < limit ? lines[i].from : scanEnd);
  const raw = block?.json ? text.slice(block.json.from, block.json.to) : null;
  const fm = frontmatterBody(text);

  return {
    path,
    docId,
    lanes,
    settings: {
      kanbanPlugin: fm === null ? null : frontmatterValue(fm, KANBAN_PLUGIN_KEY),
      raw,
      span: block?.json ?? null,
      ...readRecognisedSettings(raw),
    },
    issues: [],
    preamble,
    tail,
    settingsBlock: block ? { from: block.from, to: block.to } : null,
    length: text.length,
    revision: opts.revision ?? null,
  };
}
