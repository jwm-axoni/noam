import { describe, expect, it } from "vitest";
import { NavigationHistory } from "./navigationHistory";

describe("navigation history", () => {
  it("commits successful destinations and truncates the forward branch", () => {
    const history = new NavigationHistory();
    history.commit("a.md");
    history.commit("b.md");
    history.commit("c.md");
    expect(history.back()).toBe("b.md");
    history.commit("d.md");
    expect(history.forward()).toBeNull();
    expect(history.snapshot()).toEqual({ entries: ["a.md", "b.md", "d.md"], index: 2 });
  });

  it("deduplicates adjacent opens and follows rename/delete", () => {
    const history = new NavigationHistory();
    history.commit("Folder/a.md");
    history.commit("Folder/a.md");
    history.commit("keep.md");
    history.remap("Folder", "Moved");
    expect(history.back()).toBe("Moved/a.md");
    history.prune(["Moved"]);
    expect(history.snapshot().entries).toEqual(["keep.md"]);
  });
});
