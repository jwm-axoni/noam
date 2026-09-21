import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { findFrontmatter } from "../editor/frontmatter";
import { parseFrontmatter } from "../frontmatter/parse";
import {
  folderPathForCompanion,
  folderPresentationPath,
  parsePresentationIcon,
  presentationFromEntries,
  safeAttachmentPath,
} from "./types";

describe("presentation values", () => {
  it("recognizes a private retained cover source without displaying it", () => {
    const doc = EditorState.create({ doc: [
      "---",
      "noam_presentation_version: 1",
      "noam_cover: attachments/noam/covers/preview.png",
      "noam_cover_source: attachments/noam/covers/source.jpg",
      "---",
    ].join("\n") }).doc;
    const parsed = parseFrontmatter(doc, findFrontmatter(doc)!);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(presentationFromEntries(parsed.entries)).toMatchObject({
      cover: "attachments/noam/covers/preview.png",
      coverSource: "attachments/noam/covers/source.jpg",
    });
  });
  it("accepts stable icon discriminators", () => {
    expect(parsePresentationIcon("lucide:folder-heart")).toEqual({ kind: "lucide", id: "folder-heart" });
    expect(parsePresentationIcon("emoji:🌿")).toEqual({ kind: "emoji", value: "🌿" });
    expect(parsePresentationIcon("asset:attachments/noam/icons/a.png")).toEqual({
      kind: "asset",
      path: "attachments/noam/icons/a.png",
    });
  });

  it("rejects machine paths and traversal", () => {
    expect(safeAttachmentPath("/outside/icon.png")).toBe(false);
    expect(safeAttachmentPath("attachments/../secret.png")).toBe(false);
    expect(safeAttachmentPath("attachments\\..\\secret.png")).toBe(false);
    expect(parsePresentationIcon("asset:https://example.com/icon.png")).toBeNull();
  });

  it("keeps raw attachment filenames with spaces, Unicode and URL punctuation", () => {
    const path = "attachments/项目 50% #1?.png";
    expect(safeAttachmentPath(path)).toBe(true);
    expect(parsePresentationIcon(`asset:${path}`)).toEqual({ kind: "asset", path });
  });

  it("accepts only frozen bundled cover presets", () => {
    const read = (cover: string) => {
      const doc = EditorState.create({ doc: `---\nnoam_cover: ${cover}\n---\n` }).doc;
      const fm = findFrontmatter(doc)!;
      const parsed = parseFrontmatter(doc, fm);
      if (!parsed.ok) throw new Error(parsed.reason);
      return presentationFromEntries(parsed.entries).cover;
    };
    expect(read("preset:linen")).toBe("preset:linen");
    expect(read("preset:untrusted")).toBeNull();
  });

  it("keeps folder presentation inside the folder across moves", () => {
    expect(folderPresentationPath("Projects/Noam")).toBe("Projects/Noam/_noam-folder.md");
    expect(folderPathForCompanion("Archive/Noam/_noam-folder.md")).toBe("Archive/Noam");
    expect(folderPathForCompanion("Archive/Noam/_noam-folder-copy.md")).toBeNull();
  });
});
