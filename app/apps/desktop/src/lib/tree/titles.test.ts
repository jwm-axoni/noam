import { describe, expect, it } from "vitest";
import type { NoteTitle } from "../ipc";
import { applyTitlePatch } from "./titles";

const t = (
  path: string,
  title: string,
  id = path,
  presentation: Partial<NoteTitle> = {},
): NoteTitle => ({ id, path, title, ...presentation });

describe("applyTitlePatch", () => {
  const base = [t("a.md", "Alpha"), t("b.md", "Beta"), t("c.md", "Gamma")];

  it("replaces changed rows, adds new ones and drops removed paths, keeping title order", () => {
    const next = applyTitlePatch(base, [t("b.md", "Zeta"), t("d.md", "Delta")], ["c.md"]);
    expect(next.map((x) => x.title)).toEqual(["Alpha", "Delta", "Zeta"]);
    expect(next.find((x) => x.path === "b.md")?.title).toBe("Zeta");
  });

  it("returns the same array when nothing changed (no store write)", () => {
    expect(applyTitlePatch(base, [t("a.md", "Alpha")], [])).toBe(base);
    expect(applyTitlePatch(base, [], [])).toBe(base);
  });

  it.each([
    ["icon", "lucide:leaf"],
    ["iconColor", "green"],
    ["kind", "folder-presentation"],
    ["cover", "attachments/noam/covers/leaf.png"],
  ] as const)("replaces a row when only %s changes", (field, value) => {
    const row = t("a.md", "Alpha", "a", {
      icon: "lucide:star",
      iconColor: "blue",
      kind: null,
      cover: null,
    });
    const updated = { ...row, [field]: value };
    const rows = [row];
    const next = applyTitlePatch(rows, [updated], []);

    expect(next).not.toBe(rows);
    expect(next[0]).toBe(updated);
  });

  it("reuses the existing array when presentation metadata is unchanged", () => {
    const row = t("a.md", "Alpha", "a", {
      icon: "lucide:star",
      iconColor: "blue",
      kind: null,
      cover: "attachments/noam/covers/leaf.png",
    });
    const rows = [row];
    expect(applyTitlePatch(rows, [{ ...row }], [])).toBe(rows);
  });

  it("a removal wins over an update for the same path", () => {
    const next = applyTitlePatch(base, [t("a.md", "Alpha 2")], ["a.md"]);
    expect(next.map((x) => x.path)).toEqual(["b.md", "c.md"]);
  });

  it("does not mutate the input", () => {
    const copy = base.map((x) => ({ ...x }));
    applyTitlePatch(base, [t("a.md", "Changed")], ["b.md"]);
    expect(base).toEqual(copy);
  });
});
