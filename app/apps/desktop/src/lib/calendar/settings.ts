/**
 * Reading and writing `_Noam/Calendar.md`, the one-per-vault note that holds
 * the daily/weekly periodic-note templates and the vault's week start.
 *
 * Recognition mirrors the workflow note format (`workflows/engine/parse.ts`):
 * frontmatter `noam_kind: calendar-settings` AND exactly one fenced
 * ```json noam-calendar``` block. The fence scan below is the SAME algorithm
 * as `findWorkflowFences` (four-or-more backtick/tilde fences, info string
 * match), copied rather than imported so this module has no dependency on the
 * workflow engine's CodeMirror-backed frontmatter reader.
 *
 * Missing or invalid input never throws and never blocks the calendar: it
 * falls back to `DEFAULT_CALENDAR_SETTINGS` and reports why via `issues`.
 */

import {
  CALENDAR_FENCE_INFO,
  CALENDAR_KIND_VALUE,
  NOAM_KIND_KEY,
  type CalendarSettings,
  type PeriodicNoteSettings,
  type WeekStart,
} from "../tasks/contracts";

export interface CalendarSettingsIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  field?: string;
}

export const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = {
  version: 1,
  daily: { pathTemplate: "Journal/{{date:YYYY}}/{{date:YYYY-MM-DD}}.md" },
  weekly: { pathTemplate: "Journal/{{date:GGGG}}/Week {{date:WW}}.md" },
  weekStart: 1,
};

const KNOWN_FIELDS = ["version", "daily", "weekly", "weekStart", "locale"] as const;
const KNOWN = new Set<string>(KNOWN_FIELDS);
const WEEK_STARTS: readonly WeekStart[] = [0, 1, 6];

function issue(severity: CalendarSettingsIssue["severity"], code: string, message: string, field?: string): CalendarSettingsIssue {
  return { severity, code, message, ...(field === undefined ? {} : { field }) };
}

/** Does the frontmatter carry `noam_kind: calendar-settings`? A minimal, flat
 *  `key: value` reader is enough: this note's frontmatter has one key. */
function hasCalendarMarker(markdown: string): boolean {
  const lines = markdown.split("\n");
  if (lines[0] !== "---") return false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") return false; // closed without finding the key yet
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!match) continue;
    if (match[1] === NOAM_KIND_KEY && match[2]!.trim() === CALENDAR_KIND_VALUE) {
      // Keep scanning to the closing `---`; the key can appear anywhere.
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] === "---") return true;
      }
      return true; // unterminated frontmatter still carries the marker
    }
  }
  return false;
}

interface Fence {
  from: number;
  to: number;
}

/** Every fence whose info string starts with `json noam-calendar`. Copied
 *  from `workflows/engine/parse.ts findWorkflowFences`; see the module note. */
function findCalendarFences(markdown: string): Fence[] {
  const found: Fence[] = [];
  const lines = markdown.split("\n");
  let offset = 0;
  const starts = lines.map((line) => {
    const at = offset;
    offset += line.length + 1;
    return at;
  });

  let open: { char: string; length: number; bodyFrom: number; claimed: boolean } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) {
      if (!match) continue;
      const marker = match[1]!;
      const info = match[2]!.trim();
      if (marker[0] === "`" && info.includes("`")) continue;
      open = {
        char: marker[0]!,
        length: marker.length,
        bodyFrom: starts[i]! + line.length + 1,
        claimed: info.startsWith(CALENDAR_FENCE_INFO),
      };
      continue;
    }
    if (match && match[1]![0] === open.char && match[1]!.length >= open.length && match[2]!.trim() === "") {
      if (open.claimed) {
        const to = Math.max(open.bodyFrom - 1, starts[i]! - 1);
        found.push({ from: open.bodyFrom, to });
      }
      open = null;
    }
  }
  if (open?.claimed) found.push({ from: open.bodyFrom, to: markdown.length });
  return found;
}

function isPeriodicNoteSettings(value: unknown): value is PeriodicNoteSettings {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.pathTemplate !== "string" || record.pathTemplate === "") return false;
  if (record.template !== undefined && typeof record.template !== "string") return false;
  return true;
}

/** Read `_Noam/Calendar.md`. Never throws: every failure falls back to
 *  `DEFAULT_CALENDAR_SETTINGS` and is reported in `issues`. */
export function parseCalendarSettings(
  markdown: string,
): { settings: CalendarSettings; issues: CalendarSettingsIssue[] } {
  const issues: CalendarSettingsIssue[] = [];
  const fallback = () => ({ settings: DEFAULT_CALENDAR_SETTINGS, issues });

  if (!hasCalendarMarker(markdown)) {
    issues.push(
      issue(
        "error",
        "not-calendar-settings",
        `Needs \`${NOAM_KIND_KEY}: ${CALENDAR_KIND_VALUE}\` in its frontmatter.`,
        NOAM_KIND_KEY,
      ),
    );
    return fallback();
  }

  const fences = findCalendarFences(markdown);
  if (fences.length === 0) {
    issues.push(issue("error", "missing-fence", `Needs one \`\`\`${CALENDAR_FENCE_INFO} block.`));
    return fallback();
  }
  if (fences.length > 1) {
    issues.push(
      issue("error", "duplicate-fence", `Has ${fences.length} \`${CALENDAR_FENCE_INFO}\` blocks; expected one.`),
    );
    return fallback();
  }

  const fence = fences[0]!;
  const body = markdown.slice(fence.from, fence.to);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (err) {
    issues.push(issue("error", "bad-json", `The settings are not valid JSON: ${(err as Error).message}`));
    return fallback();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push(issue("error", "bad-shape", "The settings must be a JSON object."));
    return fallback();
  }

  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    issues.push(issue("error", "bad-shape", "`version` must be 1.", "version"));
    return fallback();
  }
  if (!isPeriodicNoteSettings(record.daily)) {
    issues.push(issue("error", "bad-shape", "`daily.pathTemplate` must be a non-empty string.", "daily"));
    return fallback();
  }
  if (!isPeriodicNoteSettings(record.weekly)) {
    issues.push(issue("error", "bad-shape", "`weekly.pathTemplate` must be a non-empty string.", "weekly"));
    return fallback();
  }
  if (!WEEK_STARTS.includes(record.weekStart as WeekStart)) {
    issues.push(issue("error", "bad-shape", "`weekStart` must be 0, 1 or 6.", "weekStart"));
    return fallback();
  }
  if (record.locale !== undefined && typeof record.locale !== "string") {
    issues.push(issue("error", "bad-shape", "`locale` must be a string.", "locale"));
    return fallback();
  }

  const settings: CalendarSettings = {
    version: 1,
    daily: record.daily as PeriodicNoteSettings,
    weekly: record.weekly as PeriodicNoteSettings,
    weekStart: record.weekStart as WeekStart,
    ...(typeof record.locale === "string" ? { locale: record.locale } : {}),
  };

  for (const key of Object.keys(record)) {
    if (KNOWN.has(key)) continue;
    settings[key] = record[key];
    issues.push(
      issue("warning", "unknown-field", `"${key}" is not part of the calendar settings schema; kept as-is.`, key),
    );
  }

  return { settings, issues };
}

function orderedSettings(settings: CalendarSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of KNOWN_FIELDS) {
    if (settings[key] !== undefined) out[key] = settings[key];
  }
  for (const key of Object.keys(settings)) {
    if (!KNOWN.has(key) && settings[key] !== undefined) out[key] = settings[key];
  }
  return out;
}

/** Render `settings` as the `_Noam/Calendar.md` note. Round-trips with
 *  `parseCalendarSettings` (modulo issues, which a clean file has none of). */
export function serializeCalendarSettings(settings: CalendarSettings): string {
  const head = `---\n${NOAM_KIND_KEY}: ${CALENDAR_KIND_VALUE}\n---\n`;
  const json = JSON.stringify(orderedSettings(settings), null, 2);
  return `${head}\n\`\`\`${CALENDAR_FENCE_INFO}\n${json}\n\`\`\`\n`;
}
