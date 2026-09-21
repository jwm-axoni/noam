import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { wikilinkCompletions } from "./wikilinks";

describe("wikilink completion", () => {
  it("omits folder presentation companions", () => {
    const state = EditorState.create({ doc: "[[" });
    const complete = wikilinkCompletions({
      getTitles: () => [
        { id: "note", path: "Notes/Visible.md", title: "Visible" },
        {
          id: "folder",
          path: "Notes/_noam-folder.md",
          title: "Folder",
          kind: "folder-presentation",
        },
      ],
      onNavigate: () => {},
    });
    const result = complete(new CompletionContext(state, 2, true));
    expect(result?.options.map((option) => option.label)).toEqual(["Visible"]);
  });
});
