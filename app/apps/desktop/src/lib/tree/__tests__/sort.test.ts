import { describe, expect, it } from "vitest";
import type { TreeNode } from "../../ipc";
import { isTimeSort, parseTreeSort, pinModified, sortTree, TREE_SORTS } from "../sort";
import { applyOrder } from "../../ordering";

const dir = (name: string, modified: number, children: TreeNode[] = []): TreeNode => ({
  id: name,
  name,
  path: name,
  isDir: true,
  modified,
  children,
  childrenLoaded: true,
});

const file = (path: string, modified: number): TreeNode => ({
  id: path,
  name: path.split("/").pop()!,
  path,
  isDir: false,
  modified,
});

const names = (ns: TreeNode[]) => ns.map((n) => n.name);

describe("sortTree", () => {
  it("puts folders before files in both modes", () => {
    const nodes = [file("z.md", 9), dir("Archive", 1), file("a.md", 1), dir("Work", 9)];
    expect(names(sortTree(nodes, "recent"))).toEqual(["Archive", "Work", "z.md", "a.md"]);
    expect(names(sortTree(nodes, "name"))).toEqual(["Archive", "Work", "a.md", "z.md"]);
  });

  it("orders files newest first under 'recent'", () => {
    const nodes = [file("old.md", 100), file("newest.md", 300), file("mid.md", 200)];
    expect(names(sortTree(nodes, "recent"))).toEqual(["newest.md", "mid.md", "old.md"]);
  });

  // A folder's mtime moves whenever anything inside it is saved, so sorting
  // folders by recency would reshuffle the sidebar's skeleton on every edit.
  it("keeps folders alphabetical even under 'recent'", () => {
    const nodes = [dir("Zoo", 999), dir("Apple", 1)];
    expect(names(sortTree(nodes, "recent"))).toEqual(["Apple", "Zoo"]);
  });

  it("breaks ties (and missing mtimes) by name so the result is stable", () => {
    const nodes = [file("b.md", 5), file("a.md", 5), { ...file("c.md", 0), modified: undefined }];
    expect(names(sortTree(nodes, "recent"))).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("compares names naturally and case-insensitively", () => {
    const nodes = [file("note 10.md", 1), file("note 9.md", 1), file("Note 1.md", 1)];
    expect(names(sortTree(nodes, "name"))).toEqual(["Note 1.md", "note 9.md", "note 10.md"]);
  });

  it("sorts every level, not just the top", () => {
    // "a.md" is oldest, so the two modes disagree — which is the point.
    const tree = [dir("Work", 1, [file("Work/a.md", 1), file("Work/z.md", 9)])];
    expect(names(sortTree(tree, "recent")[0].children!)).toEqual(["z.md", "a.md"]);
    expect(names(sortTree(tree, "name")[0].children!)).toEqual(["a.md", "z.md"]);
  });

  it("does not mutate the input", () => {
    const nodes = [file("b.md", 1), file("a.md", 2)];
    const snapshot = names(nodes);
    sortTree(nodes, "name");
    expect(names(nodes)).toEqual(snapshot);
  });
});

describe("sortTree — every mode", () => {
  const level = () => [
    file("b.md", 200),
    dir("beta", 5),
    file("A.md", 300),
    dir("Alpha", 900),
    file("c.md", 100),
  ];

  it("Name, A–Z: folders then files, both ascending", () => {
    expect(names(sortTree(level(), "name"))).toEqual(["Alpha", "beta", "A.md", "b.md", "c.md"]);
  });

  it("Name, Z–A: folders then files, both descending", () => {
    expect(names(sortTree(level(), "name-desc"))).toEqual([
      "beta",
      "Alpha",
      "c.md",
      "b.md",
      "A.md",
    ]);
  });

  it("Modified, newest first: files by mtime, folders still A–Z", () => {
    expect(names(sortTree(level(), "recent"))).toEqual(["Alpha", "beta", "A.md", "b.md", "c.md"]);
  });

  it("Modified, oldest first: files by mtime ascending, folders still A–Z", () => {
    expect(names(sortTree(level(), "modified-asc"))).toEqual([
      "Alpha",
      "beta",
      "c.md",
      "b.md",
      "A.md",
    ]);
  });

  it("Z–A reverses natural order too ('note 10' before 'note 9')", () => {
    const nodes = [file("note 9.md", 1), file("note 10.md", 1), file("Note 1.md", 1)];
    expect(names(sortTree(nodes, "name-desc"))).toEqual(["note 10.md", "note 9.md", "Note 1.md"]);
  });

  it("names equal to the collator still land in one fixed order", () => {
    const a = [file("a.md", 1), file("A.md", 1)];
    const b = [file("A.md", 1), file("a.md", 1)];
    expect(names(sortTree(a, "name"))).toEqual(names(sortTree(b, "name")));
  });

  it("ties in time fall back to A–Z in BOTH time directions", () => {
    const nodes = [file("b.md", 5), file("a.md", 5)];
    expect(names(sortTree(nodes, "recent"))).toEqual(["a.md", "b.md"]);
    expect(names(sortTree(nodes, "modified-asc"))).toEqual(["a.md", "b.md"]);
  });

  // An unknown mtime is not "the oldest": flipping to oldest-first must not
  // float every undated row to the top.
  it("puts missing mtimes last in both time directions, A–Z among themselves", () => {
    const nodes = [
      { ...file("z-undated.md", 0), modified: undefined },
      file("new.md", 20),
      file("a-undated.md", 0),
      file("old.md", 10),
    ];
    expect(names(sortTree(nodes, "recent"))).toEqual([
      "new.md",
      "old.md",
      "a-undated.md",
      "z-undated.md",
    ]);
    expect(names(sortTree(nodes, "modified-asc"))).toEqual([
      "old.md",
      "new.md",
      "a-undated.md",
      "z-undated.md",
    ]);
  });
});

describe("sortTree — per-folder overrides", () => {
  // Work holds a subfolder, so the "not recursive" rule has something to bite.
  const build = () => [
    dir("Work", 1, [
      { ...dir("Work/Sub", 1, [file("Work/Sub/a.md", 10), file("Work/Sub/z.md", 90)]), name: "Sub" },
      { ...dir("Work/Old", 1), name: "Old" },
      file("Work/a.md", 10),
      file("Work/z.md", 90),
    ]),
    dir("Home", 1, [file("Home/a.md", 10), file("Home/z.md", 90)]),
    file("a.md", 10),
    file("z.md", 90),
  ];
  const at = (tree: TreeNode[], path: string) => {
    let level = tree;
    let acc = "";
    for (const seg of path.split("/")) {
      acc = acc ? `${acc}/${seg}` : seg;
      level = level.find((n) => n.path === acc)!.children!;
    }
    return names(level);
  };

  it("applies to that folder's direct children only", () => {
    const out = sortTree(build(), "recent", { Work: "name-desc" });
    expect(at(out, "Work")).toEqual(["Sub", "Old", "z.md", "a.md"]);
    // Not inherited: Work/Sub keeps the global default.
    expect(at(out, "Work/Sub")).toEqual(["z.md", "a.md"]);
    // Siblings and the root keep the default too.
    expect(at(out, "Home")).toEqual(["z.md", "a.md"]);
    expect(names(out)).toEqual(["Home", "Work", "z.md", "a.md"]);
  });

  it("can give a subfolder its own override independently", () => {
    const out = sortTree(build(), "name", { "Work/Sub": "recent" });
    expect(at(out, "Work")).toEqual(["Old", "Sub", "a.md", "z.md"]);
    expect(at(out, "Work/Sub")).toEqual(["z.md", "a.md"]);
  });

  it("a time override keeps that folder's subfolders A–Z", () => {
    const out = sortTree(build(), "name-desc", { Work: "modified-asc" });
    expect(at(out, "Work")).toEqual(["Old", "Sub", "a.md", "z.md"]);
  });

  it("an override for a path that isn't in the tree changes nothing", () => {
    expect(sortTree(build(), "name", { Gone: "recent" })).toEqual(sortTree(build(), "name"));
  });

  it("keeps a hand-made arrangement on top of an overridden folder", () => {
    const order = { Work: ["Work/a.md"] };
    const out = applyOrder(sortTree(build(), "name", { Work: "recent" }), "", order);
    // a.md is pinned first; the rest follow the override (newest first).
    expect(at(out, "Work")).toEqual(["a.md", "Old", "Sub", "z.md"]);
  });
});

describe("sort ids", () => {
  it("still knows the two ids earlier builds persisted", () => {
    expect(parseTreeSort("recent")).toBe("recent");
    expect(parseTreeSort("name")).toBe("name");
  });

  it("rejects anything it doesn't offer", () => {
    expect(parseTreeSort("created-desc")).toBeNull();
    expect(parseTreeSort(null)).toBeNull();
    expect(parseTreeSort(3)).toBeNull();
  });

  it("offers the four modes, and marks exactly the modified ones as time sorts", () => {
    expect(TREE_SORTS.map((s) => s.id)).toEqual(["name", "name-desc", "recent", "modified-asc"]);
    expect(TREE_SORTS.filter((s) => isTimeSort(s.id)).map((s) => s.id)).toEqual([
      "recent",
      "modified-asc",
    ]);
  });
});

// The contract the whole feature rests on: changing the sort must never undo a
// drag-and-drop arrangement, while still reaching everything nobody arranged.
describe("sortTree + applyOrder — the two layers", () => {
  // Inside Alpha, "a.md" is the OLDEST and "z.md" the newest, so the two sort
  // modes must produce opposite orders there.
  const build = () => [
    dir("Alpha", 1, [file("Alpha/a.md", 10), file("Alpha/z.md", 90)]),
    dir("Beta", 1, []),
    file("loose.md", 50),
  ];

  it("keeps a hand-arranged root while sorting inside the folders", () => {
    // The user dragged Beta above Alpha at the root — reversing the alphabetical
    // order the sort would give — and never touched Alpha's contents.
    const order = { "": ["Beta", "Alpha"] };

    const recent = applyOrder(sortTree(build(), "recent"), "", order);
    expect(names(recent).slice(0, 2)).toEqual(["Beta", "Alpha"]);
    expect(names(recent.find((n) => n.name === "Alpha")!.children!)).toEqual([
      "z.md",
      "a.md",
    ]);

    // Flipping the sort rearranges the unpinned inside, and ONLY that: the root
    // still reads Beta, Alpha.
    const byName = applyOrder(sortTree(build(), "name"), "", order);
    expect(names(byName).slice(0, 2)).toEqual(["Beta", "Alpha"]);
    expect(names(byName.find((n) => n.name === "Alpha")!.children!)).toEqual([
      "a.md",
      "z.md",
    ]);
  });

  it("leaves unranked siblings to the sort, after the pinned ones", () => {
    // Only "loose.md" is pinned — to the top, above the folders it would
    // normally sit below.
    const out = applyOrder(sortTree(build(), "recent"), "", { "": ["loose.md"] });
    expect(names(out)).toEqual(["loose.md", "Alpha", "Beta"]);
  });
});

describe("pinModified", () => {
  it("keeps a row where it was when its mtime moves under the pointer", () => {
    const pins = new Map<string, number>();
    const before = [file("a.md", 10), file("b.md", 20), file("c.md", 30)];
    // First pass records what each row was placed with.
    expect(names(sortTree(pinModified(before, pins), "recent"))).toEqual([
      "c.md",
      "b.md",
      "a.md",
    ]);

    // A sync run rewrites a.md, so the disk now says it is the newest file. With
    // the order pinned, the rows do NOT move — which is the whole point: the row
    // under the cursor stays the row the user aimed at.
    const after = [file("a.md", 99), file("b.md", 20), file("c.md", 30)];
    expect(names(sortTree(pinModified(after, pins), "recent"))).toEqual([
      "c.md",
      "b.md",
      "a.md",
    ]);

    // Thawing (a fresh, empty memory) reveals the true order.
    expect(names(sortTree(pinModified(after, new Map()), "recent"))).toEqual([
      "a.md",
      "c.md",
      "b.md",
    ]);
  });

  it("still places a file created mid-wave at its real position", () => {
    const pins = new Map<string, number>();
    pinModified([file("a.md", 10), file("b.md", 20)], pins);
    const withNew = [file("a.md", 10), file("b.md", 20), file("new.md", 50)];
    expect(names(sortTree(pinModified(withNew, pins), "recent"))).toEqual([
      "new.md",
      "b.md",
      "a.md",
    ]);
  });

  it("pins inside folders too, and leaves folder order alone", () => {
    const pins = new Map<string, number>();
    const level = [dir("Work", 1, [file("Work/x.md", 1), file("Work/y.md", 2)])];
    pinModified(level, pins);
    const moved = [dir("Work", 9, [file("Work/x.md", 99), file("Work/y.md", 2)])];
    const sorted = sortTree(pinModified(moved, pins), "recent");
    expect(names(sorted)).toEqual(["Work"]);
    expect(names(sorted[0].children!)).toEqual(["Work/y.md", "Work/x.md"].map((p) =>
      p.split("/").pop()!,
    ));
  });

  it("returns the same arrays when nothing moved, so a memo downstream holds", () => {
    const pins = new Map<string, number>();
    const level = [dir("Work", 1, [file("Work/x.md", 1)]), file("a.md", 2)];
    pinModified(level, pins);
    expect(pinModified(level, pins)).toBe(level);
  });
});
