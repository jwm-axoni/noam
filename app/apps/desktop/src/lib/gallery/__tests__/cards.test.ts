import { describe, expect, it } from "vitest";
import type { FolderCard } from "../../ipc";
import { breadcrumbs, fullDate, nextCardIndex, orderCards, relativeDate } from "../cards";

const note = (path: string, modified: number): FolderCard => ({
  kind: "note",
  path,
  name: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""),
  docId: `id:${path}`,
  excerpt: null,
  firstImage: null,
  modified,
  empty: false,
});
const folder = (path: string): FolderCard => ({
  kind: "folder",
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  noteCount: 0,
});

const CARDS: FolderCard[] = [
  note("Trips/b.md", 300),
  folder("Trips/Zeta"),
  note("Trips/a.md", 100),
  folder("Trips/Alpha"),
  note("Trips/c.md", 200),
];
const paths = (cards: FolderCard[]) => cards.map((c) => c.path);

describe("orderCards follows the folder's sidebar sort", () => {
  it("uses the global sort when the folder has no override", () => {
    expect(paths(orderCards(CARDS, "Trips", "recent", {}))).toEqual([
      "Trips/Alpha", "Trips/Zeta", "Trips/b.md", "Trips/c.md", "Trips/a.md",
    ]);
    expect(paths(orderCards(CARDS, "Trips", "name", {}))).toEqual([
      "Trips/Alpha", "Trips/Zeta", "Trips/a.md", "Trips/b.md", "Trips/c.md",
    ]);
  });

  it("uses THIS folder's override over the global sort", () => {
    expect(paths(orderCards(CARDS, "Trips", "recent", { Trips: "name-desc" }))).toEqual([
      "Trips/Zeta", "Trips/Alpha", "Trips/c.md", "Trips/b.md", "Trips/a.md",
    ]);
    expect(paths(orderCards(CARDS, "Trips", "name", { Trips: "modified-asc" }))).toEqual([
      "Trips/Alpha", "Trips/Zeta", "Trips/a.md", "Trips/c.md", "Trips/b.md",
    ]);
  });

  it("ignores another folder's override", () => {
    expect(paths(orderCards(CARDS, "Trips", "name", { Other: "name-desc" }))).toEqual([
      "Trips/Alpha", "Trips/Zeta", "Trips/a.md", "Trips/b.md", "Trips/c.md",
    ]);
  });

  it("follows a Created sort with the store's created times", () => {
    // b oldest, a newest; c has no created date, so it goes last either way.
    const created = new Map([["Trips/a.md", 3000], ["Trips/b.md", 1000]]);
    expect(paths(orderCards(CARDS, "Trips", "created-desc", {}, {}, created))).toEqual([
      "Trips/Alpha", "Trips/Zeta", "Trips/a.md", "Trips/b.md", "Trips/c.md",
    ]);
    expect(paths(orderCards(CARDS, "Trips", "name", { Trips: "created-asc" }, {}, created))).toEqual([
      "Trips/Alpha", "Trips/Zeta", "Trips/b.md", "Trips/a.md", "Trips/c.md",
    ]);
  });

  it("keeps a hand-made arrangement on top, like the sidebar", () => {
    const order = { Trips: ["Trips/c.md", "Trips/Zeta"] };
    expect(paths(orderCards(CARDS, "Trips", "name", {}, order))).toEqual([
      "Trips/c.md", "Trips/Zeta", "Trips/Alpha", "Trips/a.md", "Trips/b.md",
    ]);
  });

  it("works at the vault root", () => {
    const root = [note("z.md", 1), folder("A"), note("a.md", 2)];
    expect(paths(orderCards(root, "", "name", { "": "name-desc" }))).toEqual(["A", "z.md", "a.md"]);
  });
});

describe("relativeDate", () => {
  const now = Date.UTC(2026, 8, 29, 12, 0, 0);
  const day = 24 * 3600_000;

  it("reads like a person would say it", () => {
    expect(relativeDate(now - 20_000, now)).toBe("just now");
    expect(relativeDate(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(relativeDate(now - 2 * 3600_000, now)).toBe("2 hours ago");
    expect(relativeDate(now - day, now)).toBe("yesterday");
    expect(relativeDate(now - 3 * day, now)).toBe("3 days ago");
    expect(relativeDate(now - 14 * day, now)).toBe("2 weeks ago");
    expect(relativeDate(now - 65 * day, now)).toBe("2 months ago");
    expect(relativeDate(now - 800 * day, now)).toBe("2 years ago");
  });

  it("handles clock skew into the future and unknown times", () => {
    expect(relativeDate(now + 3 * 3600_000, now)).toBe("in 3 hours");
    expect(relativeDate(0, now)).toBe("");
    expect(relativeDate(Number.NaN, now)).toBe("");
    expect(fullDate(0)).toBe("");
    expect(fullDate(now, "en-US")).toContain("2026");
  });
});

describe("nextCardIndex", () => {
  it("moves across and down a wrapped grid, clamping at the edges", () => {
    // 10 cards, 4 columns: rows [0..3] [4..7] [8,9]
    expect(nextCardIndex("ArrowRight", 0, 10, 4)).toBe(1);
    expect(nextCardIndex("ArrowLeft", 0, 10, 4)).toBe(0);
    expect(nextCardIndex("ArrowRight", 9, 10, 4)).toBe(9);
    expect(nextCardIndex("ArrowDown", 1, 10, 4)).toBe(5);
    expect(nextCardIndex("ArrowDown", 6, 10, 4)).toBe(6); // no card under it
    expect(nextCardIndex("ArrowUp", 5, 10, 4)).toBe(1);
    expect(nextCardIndex("ArrowUp", 2, 10, 4)).toBe(2);
    expect(nextCardIndex("Home", 7, 10, 4)).toBe(0);
    expect(nextCardIndex("End", 0, 10, 4)).toBe(9);
  });

  it("leaves other keys (and empty grids) alone", () => {
    expect(nextCardIndex("Enter", 0, 10, 4)).toBeNull();
    expect(nextCardIndex("a", 0, 10, 4)).toBeNull();
    expect(nextCardIndex("ArrowRight", 0, 0, 4)).toBeNull();
    expect(nextCardIndex("ArrowDown", 0, 3, 0)).toBe(1); // a zero-width read acts as one column
  });
});

describe("breadcrumbs", () => {
  it("splits a folder path into clickable ancestors", () => {
    expect(breadcrumbs("")).toEqual([]);
    expect(breadcrumbs("A/B/C")).toEqual([
      { name: "A", path: "A" },
      { name: "B", path: "A/B" },
      { name: "C", path: "A/B/C" },
    ]);
  });
});
