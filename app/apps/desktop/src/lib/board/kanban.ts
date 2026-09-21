/**
 * Obsidian Kanban compatibility — a DOCUMENTED SUBSET with an itemized report.
 *
 * What crosses the bridge: lanes, cards and their bodies, the `***` + archive
 * lane, `@{YYYY-MM-DD}` dates (Kanban's `date-trigger`) against the frozen 📅
 * due marker, and lane collapse (`list-collapse`). Everything else in the
 * settings block is PRESERVED VERBATIM and NAMED in `report.unsupported`, so a
 * setting we do not model is visible rather than silently dropped or guessed.
 *
 * Import and export are text-to-text: both run through `parseBoard`, so the
 * bytes we do not convert are the bytes that were there.
 */

import { MARKERS, TASK_LINE_RE } from "../tasks/contracts";
import {
  frontmatterCloseOffset,
  kanbanPluginValue,
  parseBoard,
  type ParseOptions,
  type ParsedBoard,
} from "./parse";
import { serializeBoard } from "./serialize";
import { appendSettingsBlock, scanJsonObject } from "./settings";

export interface KanbanIssue {
  /** The settings key, or the marker glyph, that has no equivalent. */
  setting: string;
  reason: string;
}

export interface KanbanReport {
  unsupported: KanbanIssue[];
}

/** Settings we act on. Everything else is reported and left untouched. */
const MODELLED = new Set(["kanban-plugin", "lane-width", "show-checkboxes", "list-collapse"]);

const KANBAN_DATE_RE = /@\{(\d{4}-\d{2}-\d{2})\}/g;
const DUE_DATE_RE = new RegExp(`${MARKERS.due}\\s*(\\d{4}-\\d{2}-\\d{2})`, "g");

/** Markers Obsidian Kanban has no idea about. They survive as card text. */
const FOREIGN_MARKERS: Array<[string, string]> = [
  [MARKERS.scheduled, "scheduled date"],
  [MARKERS.start, "start date"],
  [MARKERS.done, "done date"],
  [MARKERS.created, "created date"],
  [MARKERS.cancelled, "cancelled date"],
  [MARKERS.recurrence, "recurrence rule"],
  [MARKERS.dependsOn, "dependency"],
];

/** Rewrite only the CARD lines; a body line or the settings JSON is not ours. */
function mapCardLines(text: string, map: (line: string) => string): string {
  return text
    .split("\n")
    .map((line) => {
      const cr = line.endsWith("\r") ? "\r" : "";
      const bare = cr ? line.slice(0, -1) : line;
      return (TASK_LINE_RE.test(bare) ? map(bare) : bare) + cr;
    })
    .join("\n");
}

function settingsEntries(text: string) {
  const raw = parseBoard(text).settings.raw;
  return raw === null ? [] : (scanJsonObject(raw)?.entries ?? []);
}

/**
 * Read an Obsidian Kanban board. The returned document is a Noam board: the
 * dates use the frozen 📅 marker, the lanes carry `collapsed`, and every
 * setting — modelled or not — is still in the settings block, byte for byte.
 */
export function importKanban(text: string, opts: ParseOptions = {}): { doc: ParsedBoard; report: KanbanReport } {
  const unsupported: KanbanIssue[] = [];
  const entries = settingsEntries(text);
  const trigger = entries.find((e) => e.key === "date-trigger");
  const triggerOk = trigger === undefined || trigger.value === "@";
  if (!triggerOk) {
    unsupported.push({
      setting: "date-trigger",
      reason: `Noam reads @{YYYY-MM-DD} dates; this board triggers dates with ${JSON.stringify(trigger?.value)}, so its dates are left as text.`,
    });
  }
  for (const entry of entries) {
    if (entry.key === "date-trigger" || MODELLED.has(entry.key)) continue;
    unsupported.push({
      setting: entry.key,
      reason: "Noam has no equivalent. The value is kept verbatim in the settings block and written back unchanged.",
    });
  }

  const converted = triggerOk
    ? mapCardLines(text, (line) => line.replace(KANBAN_DATE_RE, `${MARKERS.due} $1`))
    : text;
  const doc = parseBoard(converted, opts);

  const collapse = entries.find((e) => e.key === "list-collapse")?.value;
  if (Array.isArray(collapse)) {
    const live = doc.lanes.filter((lane) => !lane.archive);
    live.forEach((lane, at) => {
      lane.collapsed = collapse[at] === true;
    });
  }

  return { doc, report: { unsupported } };
}

/**
 * Write a board Obsidian Kanban opens: `kanban-plugin: basic` in the
 * frontmatter, `@{…}` dates, a settings block. Markers Kanban cannot show stay
 * in the card text (where Kanban renders them as text) and are named in the
 * report — dropping them would lose data the task engine owns.
 */
export function exportKanban(doc: ParsedBoard): { text: string; report: KanbanReport } {
  const unsupported: KanbanIssue[] = [];
  const source = serializeBoard(doc);

  for (const [glyph, what] of FOREIGN_MARKERS) {
    const used = doc.lanes.some((lane) => lane.cards.some((card) => card.task.sourceText.includes(glyph)));
    if (used) {
      unsupported.push({
        setting: glyph,
        reason: `Obsidian Kanban has no ${what}; the marker stays in the card text.`,
      });
    }
  }

  let text = mapCardLines(source, (line) => line.replace(DUE_DATE_RE, "@{$1}"));

  if (kanbanPluginValue(text) === null) {
    const close = frontmatterCloseOffset(text);
    text =
      close === null
        ? `---\n\nkanban-plugin: basic\n\n---\n\n${text}`
        : `${text.slice(0, close)}kanban-plugin: basic\n${text.slice(close)}`;
  }

  if (parseBoard(text).settingsBlock === null) {
    const collapse = doc.lanes.filter((lane) => !lane.archive).map((lane) => lane.collapsed);
    const pairs = ['"kanban-plugin":"basic"'];
    if (doc.settings.laneWidth !== undefined) pairs.push(`"lane-width":${doc.settings.laneWidth}`);
    if (collapse.some(Boolean)) pairs.push(`"list-collapse":[${collapse.join(",")}]`);
    const change = appendSettingsBlock(text, `{${pairs.join(",")}}`);
    text = text.slice(0, change.from) + change.insert;
  }

  return { text, report: { unsupported } };
}
