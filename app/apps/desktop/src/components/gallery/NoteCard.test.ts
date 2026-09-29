// @vitest-environment jsdom
//
// The note card face is ONE component shared by the folder gallery and the
// dashboard card view: the same thumbnail rules (image, else excerpt, else a
// placeholder; a 0-byte note says it is not downloaded yet), the same date
// line, and every value as text.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderCard } from "../../lib/ipc";

const mocks = vi.hoisted(() => ({ cards: [] as FolderCard[] }));

vi.mock("../../lib/ipc", () => ({
  listFolderCards: async () => mocks.cards,
  onFilesChanged: async () => () => {},
}));

import { NoteCardFace, type NoteCardData } from "./NoteCard";
import { GalleryPanel } from "./GalleryPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const base: NoteCardData = { name: "Plan", excerpt: null, firstImage: null, modified: 0, empty: false };

async function face(card: NoteCardData) {
  await act(async () => {
    root.render(createElement("div", null, createElement(NoteCardFace, { card, vaultPath: "/vault" })));
  });
  return host;
}

describe("NoteCardFace", () => {
  it("shows the excerpt as text, the name and a dated line", async () => {
    const el = await face({ ...base, excerpt: "<b>not bold</b>", modified: Date.now() - 3 * 86_400_000 });
    expect(el.querySelector(".gallery-card-title")?.textContent).toBe("Plan");
    expect(el.querySelector(".gallery-excerpt")?.textContent).toBe("<b>not bold</b>");
    expect(el.querySelector("b")).toBeNull();
    const date = el.querySelector(".gallery-card-sub")!;
    expect(date.textContent).toBe("3 days ago");
    expect(date.getAttribute("title")).toBeTruthy();
  });

  it("has placeholders for an empty and a not-yet-downloaded note, and no date when unknown", async () => {
    let el = await face(base);
    expect(el.querySelector(".gallery-placeholder")?.textContent).toBe("Empty note");
    expect(el.querySelector(".gallery-card-sub")).toBeNull();
    el = await face({ ...base, empty: true, excerpt: "stale" });
    expect(el.querySelector(".gallery-placeholder")?.textContent).toBe("Not downloaded yet");
    el = await face({ ...base, modified: null });
    expect(el.querySelector(".gallery-card-sub")).toBeNull();
  });
});

describe("the folder gallery uses the shared face", () => {
  it("renders note cards through NoteCardFace", async () => {
    mocks.cards = [
      { kind: "folder", path: "Sub", name: "Sub", noteCount: 2 },
      {
        kind: "note",
        path: "A.md",
        name: "A",
        docId: "a",
        excerpt: "Alpha excerpt",
        firstImage: null,
        modified: 0,
        empty: false,
      },
    ];
    const onOpenNote = vi.fn();
    await act(async () => {
      root.render(
        createElement(GalleryPanel, {
          instanceId: "gallery-test",
          vaultEpoch: null,
          visible: true,
          onOpenNote,
          onRequestClose: () => {},
        } as never),
      );
    });
    for (let i = 0; i < 20 && !host.querySelector(".gallery-card.is-note"); i += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
    const note = host.querySelector<HTMLButtonElement>(".gallery-card.is-note")!;
    expect(note.querySelector(".gallery-excerpt")?.textContent).toBe("Alpha excerpt");
    expect(note.querySelector(".gallery-card-title")?.textContent).toBe("A");
    expect(host.querySelector(".gallery-card.is-folder .gallery-card-sub")?.textContent).toBe("2 notes");
    await act(async () => note.click());
    expect(onOpenNote).toHaveBeenCalledWith("A.md");
  });
});
