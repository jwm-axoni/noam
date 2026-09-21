// Import/export is a DOCUMENTED SUBSET, and the report is the honest half of
// it: a setting we do not model is named, with the reason, instead of being
// dropped silently or guessed at.

import { describe, expect, it } from "vitest";
import { exportKanban, importKanban } from "../kanban";
import { parseBoard } from "../parse";
import { serializeBoard } from "../serialize";

const KANBAN = [
  "---",
  "",
  "kanban-plugin: basic",
  "",
  "---",
  "",
  "## Todo",
  "",
  "- [ ] Renew the lease @{2026-09-22}",
  "- [ ] Call the bank",
  "",
  "## Doing",
  "",
  "- [ ] Draft the deck",
  "",
  "***",
  "",
  "## Archive",
  "",
  "- [x] Pay the deposit @{2026-09-01}",
  "",
  "%% kanban:settings",
  "```",
  '{"kanban-plugin":"basic","lane-width":272,"list-collapse":[false,true],"date-trigger":"@","archive-with-date":true,"metadata-keys":[{"metadataKey":"owner"}]}',
  "```",
  "%%",
  "",
].join("\n");

describe("importKanban", () => {
  it("converts @{date} into the frozen due marker", () => {
    const { doc } = importKanban(KANBAN);
    expect(doc.lanes[0].cards[0].task.text).toBe("Renew the lease 📅 2026-09-22");
    expect(doc.lanes[0].cards[1].task.text).toBe("Call the bank");
    expect(doc.lanes[2].cards[0].task.text).toBe("Pay the deposit 📅 2026-09-01");
  });

  it("keeps lanes, the archive and lane collapse", () => {
    const { doc } = importKanban(KANBAN);
    expect(doc.lanes.map((l) => l.title)).toEqual(["Todo", "Doing", "Archive"]);
    expect(doc.lanes.map((l) => l.archive)).toEqual([false, false, true]);
    expect(doc.lanes.map((l) => l.collapsed)).toEqual([false, true, false]);
  });

  it("itemizes every setting it does not model", () => {
    const { report } = importKanban(KANBAN);
    const named = report.unsupported.map((u) => u.setting);
    expect(named).toContain("archive-with-date");
    expect(named).toContain("metadata-keys");
    expect(named).not.toContain("lane-width");
    expect(named).not.toContain("list-collapse");
    expect(named).not.toContain("date-trigger");
    for (const item of report.unsupported) expect(item.reason.length).toBeGreaterThan(0);
  });

  it("reports a date trigger it cannot read", () => {
    const odd = KANBAN.replace('"date-trigger":"@"', '"date-trigger":"!"');
    const { doc, report } = importKanban(odd);
    expect(report.unsupported.map((u) => u.setting)).toContain("date-trigger");
    expect(doc.lanes[0].cards[0].task.text).toBe("Renew the lease @{2026-09-22}");
  });
});

describe("exportKanban", () => {
  const NOAM = [
    "---",
    "noam_kind: board",
    "---",
    "",
    "## Todo",
    "",
    "- [ ] Renew the lease 📅 2026-09-22",
    "- [ ] Chase the invoice ⏳ 2026-09-25",
    "",
    "## Done",
    "",
    "- [x] Pay the deposit 📅 2026-09-01",
    "",
  ].join("\n");

  it("writes a file Obsidian Kanban opens", () => {
    const { text } = exportKanban(parseBoard(NOAM));
    expect(text).toContain("kanban-plugin: basic");
    expect(text).toContain("- [ ] Renew the lease @{2026-09-22}");
    expect(text).toContain("%% kanban:settings");
    expect(text).toContain('"kanban-plugin":"basic"');
    expect(parseBoard(text).lanes.map((l) => l.title)).toEqual(["Todo", "Done"]);
  });

  it("names the markers Kanban cannot show", () => {
    const { report } = exportKanban(parseBoard(NOAM));
    expect(report.unsupported.map((u) => u.setting)).toContain("⏳");
    expect(report.unsupported.every((u) => u.reason.length > 0)).toBe(true);
  });

  it("keeps a board that came from Kanban a Kanban board", () => {
    const { doc } = importKanban(KANBAN);
    const { text } = exportKanban(doc);
    expect(text).toContain("- [ ] Renew the lease @{2026-09-22}");
    expect(text).toContain('"lane-width":272');
    expect(parseBoard(text).lanes.map((l) => l.archive)).toEqual([false, false, true]);
  });

  it("writes lane collapse back", () => {
    const { doc } = importKanban(KANBAN);
    const { text } = exportKanban(doc);
    expect(text).toContain('"list-collapse":[false,true]');
    expect(serializeBoard(parseBoard(text))).toBe(text);
  });
});
