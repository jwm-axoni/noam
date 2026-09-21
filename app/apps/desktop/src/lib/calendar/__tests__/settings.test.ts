import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALENDAR_SETTINGS,
  parseCalendarSettings,
  serializeCalendarSettings,
} from "../settings";
import type { CalendarSettings } from "../../tasks/contracts";

const VALID = `---
noam_kind: calendar-settings
---

\`\`\`json noam-calendar
{
  "version": 1,
  "daily": { "pathTemplate": "Journal/{{date:YYYY}}/{{date:YYYY-MM-DD}}.md" },
  "weekly": { "pathTemplate": "Journal/{{date:GGGG}}/Week {{date:WW}}.md" },
  "weekStart": 1
}
\`\`\`
`;

describe("parseCalendarSettings", () => {
  it("parses a well-formed note", () => {
    const { settings, issues } = parseCalendarSettings(VALID);
    expect(issues).toEqual([]);
    expect(settings).toEqual({
      version: 1,
      daily: { pathTemplate: "Journal/{{date:YYYY}}/{{date:YYYY-MM-DD}}.md" },
      weekly: { pathTemplate: "Journal/{{date:GGGG}}/Week {{date:WW}}.md" },
      weekStart: 1,
    });
  });

  it("falls back to defaults with an issue when the frontmatter marker is missing", () => {
    const { settings, issues } = parseCalendarSettings("# Just a note\n");
    expect(settings).toBe(DEFAULT_CALENDAR_SETTINGS);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.code).toBe("not-calendar-settings");
  });

  it("falls back to defaults with an issue when the fence is missing", () => {
    const { settings, issues } = parseCalendarSettings("---\nnoam_kind: calendar-settings\n---\nNo fence here.\n");
    expect(settings).toBe(DEFAULT_CALENDAR_SETTINGS);
    expect(issues.some((i) => i.code === "missing-fence")).toBe(true);
  });

  it("falls back to defaults with an issue on invalid JSON", () => {
    const md = "---\nnoam_kind: calendar-settings\n---\n```json noam-calendar\n{ not json\n```\n";
    const { settings, issues } = parseCalendarSettings(md);
    expect(settings).toBe(DEFAULT_CALENDAR_SETTINGS);
    expect(issues.some((i) => i.code === "bad-json")).toBe(true);
  });

  it("falls back to defaults with an issue on an invalid weekStart", () => {
    const md = VALID.replace('"weekStart": 1', '"weekStart": 3');
    const { settings, issues } = parseCalendarSettings(md);
    expect(settings).toBe(DEFAULT_CALENDAR_SETTINGS);
    expect(issues.some((i) => i.field === "weekStart")).toBe(true);
  });

  it("preserves an unknown top-level key with a warning", () => {
    const md = VALID.replace('"weekStart": 1', '"weekStart": 1,\n  "customThing": "kept"');
    const { settings, issues } = parseCalendarSettings(md);
    expect(settings.customThing).toBe("kept");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning", code: "unknown-field", field: "customThing" });
  });
});

describe("serializeCalendarSettings", () => {
  it("round-trips through parseCalendarSettings", () => {
    const settings: CalendarSettings = {
      version: 1,
      daily: { pathTemplate: "Journal/{{date:YYYY-MM-DD}}.md", template: "Templates/Daily.md" },
      weekly: { pathTemplate: "Journal/Week {{date:WW}}.md" },
      weekStart: 0,
      locale: "en-US",
    };
    const markdown = serializeCalendarSettings(settings);
    const { settings: parsed, issues } = parseCalendarSettings(markdown);
    expect(issues).toEqual([]);
    expect(parsed).toEqual(settings);
  });

  it("round-trips an unknown top-level field", () => {
    const settings: CalendarSettings = {
      ...DEFAULT_CALENDAR_SETTINGS,
      mystery: 42,
    };
    const markdown = serializeCalendarSettings(settings);
    const { settings: parsed, issues } = parseCalendarSettings(markdown);
    expect(parsed.mystery).toBe(42);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("unknown-field");
  });
});
