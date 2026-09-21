/**
 * Board settings as a MINIMAL SPAN EDIT of the JSON Obsidian Kanban wrote.
 *
 * The temptation is to `JSON.parse`, set a field and `JSON.stringify` back.
 * That silently reorders keys, reformats numbers and — the one that actually
 * hurts — drops every setting this version of Noam does not model. So nothing
 * here reserializes the object: a change replaces the SLICE of the raw text
 * that holds one value, and a new key is appended immediately before the
 * closing brace. Unknown keys and key order survive because they are never
 * touched.
 */

import type { BoardSettings, SpanChange } from "../tasks/contracts";
import type { ParsedBoard } from "./parse";
import { serializeBoard } from "./serialize";

/** The subset we model. Everything else lives only in `settings.raw`. */
export const SETTING_KEYS = {
  laneWidth: "lane-width",
  showCheckboxes: "show-checkboxes",
  archiveLaneTitle: "archive-lane-title",
} as const;

export type SettingsPatch = Partial<{
  laneWidth: number;
  showCheckboxes: boolean;
  archiveLaneTitle: string;
}>;

// ---------------------------------------------------------------------------
// A tolerant JSON object scanner — spans, not values
// ---------------------------------------------------------------------------

export interface JsonEntry {
  key: string;
  /** Offsets RELATIVE to the raw JSON text. */
  valueFrom: number;
  valueTo: number;
  value: unknown;
}

export interface JsonObject {
  entries: JsonEntry[];
  /** Offset of the closing `}`, where a new key is appended. */
  close: number;
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i += 1;
  return i;
}

function endOfString(s: string, i: number): number {
  i += 1;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s[i] === '"') return i + 1;
    i += 1;
  }
  return -1;
}

function endOfValue(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return endOfString(s, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    let j = i;
    while (j < s.length) {
      const d = s[j];
      if (d === '"') {
        j = endOfString(s, j);
        if (j === -1) return -1;
        continue;
      }
      if (d === "{" || d === "[") depth += 1;
      else if (d === "}" || d === "]") {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
      j += 1;
    }
    return -1;
  }
  let j = i;
  while (j < s.length && !/[,}\]\s]/.test(s[j])) j += 1;
  return j;
}

/** Scan the top-level object. Null when the text is not one we can edit. */
export function scanJsonObject(raw: string): JsonObject | null {
  const open = raw.indexOf("{");
  if (open === -1) return null;
  const entries: JsonEntry[] = [];
  let i = skipWs(raw, open + 1);
  while (i < raw.length && raw[i] !== "}") {
    if (raw[i] !== '"') return null;
    const keyEnd = endOfString(raw, i);
    if (keyEnd === -1) return null;
    let key: string;
    try {
      key = JSON.parse(raw.slice(i, keyEnd)) as string;
    } catch {
      return null;
    }
    i = skipWs(raw, keyEnd);
    if (raw[i] !== ":") return null;
    const valueFrom = skipWs(raw, i + 1);
    const valueTo = endOfValue(raw, valueFrom);
    if (valueTo === -1 || valueTo <= valueFrom) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw.slice(valueFrom, valueTo));
    } catch {
      value = undefined;
    }
    entries.push({ key, valueFrom, valueTo, value });
    i = skipWs(raw, valueTo);
    if (raw[i] === ",") i = skipWs(raw, i + 1);
    else if (raw[i] !== "}") return null;
  }
  return raw[i] === "}" ? { entries, close: i } : null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The recognised subset of a raw settings JSON. Used by `parseBoard`. */
export function readRecognisedSettings(
  raw: string | null,
): Pick<BoardSettings, "laneWidth" | "showCheckboxes" | "archiveLaneTitle"> {
  const out: Pick<BoardSettings, "laneWidth" | "showCheckboxes" | "archiveLaneTitle"> = {};
  if (raw === null) return out;
  const object = scanJsonObject(raw);
  if (!object) return out;
  for (const entry of object.entries) {
    if (entry.key === SETTING_KEYS.laneWidth && typeof entry.value === "number") {
      out.laneWidth = entry.value;
    } else if (entry.key === SETTING_KEYS.showCheckboxes && typeof entry.value === "boolean") {
      out.showCheckboxes = entry.value;
    } else if (entry.key === SETTING_KEYS.archiveLaneTitle && typeof entry.value === "string") {
      out.archiveLaneTitle = entry.value;
    }
  }
  return out;
}

/** The settings the board view acts on — never `raw`/`span`, which are spans
 *  for the planner, not values for the UI. */
export type RecognisedSettings = { kanbanPlugin: string | null } & Pick<
  BoardSettings,
  "laneWidth" | "showCheckboxes" | "archiveLaneTitle"
>;

export function readSettings(doc: ParsedBoard): RecognisedSettings {
  return {
    kanbanPlugin: doc.settings.kanbanPlugin,
    ...readRecognisedSettings(doc.settings.raw),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function jsonFor(patch: SettingsPatch, key: keyof SettingsPatch): string {
  return JSON.stringify(patch[key]);
}

/** A whole block, for a board that has never had one. */
function blockText(precedingText: string, json: string): string {
  const gap = precedingText.endsWith("\n\n") || precedingText === "" ? "" : precedingText.endsWith("\n") ? "\n" : "\n\n";
  return `${gap}%% kanban:settings\n\`\`\`\n${json}\n\`\`\`\n%%\n`;
}

/** Serialize a patch as a fresh JSON object (only when there is none to edit). */
export function settingsJson(kanbanPlugin: string | null, patch: SettingsPatch): string {
  const pairs: string[] = [];
  if (kanbanPlugin) pairs.push(`"kanban-plugin":${JSON.stringify(kanbanPlugin)}`);
  for (const key of Object.keys(SETTING_KEYS) as Array<keyof SettingsPatch>) {
    if (patch[key] !== undefined) pairs.push(`"${SETTING_KEYS[key]}":${jsonFor(patch, key)}`);
  }
  return `{${pairs.join(",")}}`;
}

/** The whole `%% kanban:settings … %%` block for text that has none. */
export function appendSettingsBlock(text: string, json: string): SpanChange {
  return { from: text.length, to: text.length, insert: blockText(text, json) };
}

/**
 * Plan a settings change. Returns changes in the coordinates of the text `doc`
 * was parsed from, ordered from the end backwards. An empty patch plans
 * nothing — a no-op must not touch the file.
 */
export function planUpdateSettings(doc: ParsedBoard, patch: SettingsPatch): SpanChange[] {
  const keys = (Object.keys(SETTING_KEYS) as Array<keyof SettingsPatch>).filter(
    (key) => patch[key] !== undefined,
  );
  if (keys.length === 0) return [];

  const { raw, span } = doc.settings;
  const object = raw === null || span === null ? null : scanJsonObject(raw);
  if (raw === null || span === null || object === null) {
    // No block, or one we could not scan: append a fresh block rather than
    // rewrite text we do not understand.
    return [
      appendSettingsBlock(serializeBoard(doc), settingsJson(doc.settings.kanbanPlugin, patch)),
    ];
  }

  const changes: SpanChange[] = [];
  const appended: string[] = [];
  for (const key of keys) {
    const name = SETTING_KEYS[key];
    const entry = object.entries.find((e) => e.key === name);
    if (entry) {
      changes.push({
        from: span.from + entry.valueFrom,
        to: span.from + entry.valueTo,
        insert: jsonFor(patch, key),
      });
    } else {
      appended.push(`"${name}":${jsonFor(patch, key)}`);
    }
  }
  if (appended.length > 0) {
    const at = span.from + object.close;
    const lead = object.entries.length > 0 ? "," : "";
    changes.push({ from: at, to: at, insert: lead + appended.join(",") });
  }
  return changes.sort((a, b) => b.from - a.from);
}
