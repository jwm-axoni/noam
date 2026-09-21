// @vitest-environment jsdom
//
// Routing: which surface a note gets, and what a refused move says.
//
//   A BOARD NOTE OPENS AS A BOARD, and the toggle hands it back to the text
//   editor (remembered per path, so the next open honours the choice).
//   EVERY OTHER NOTE IS UNTOUCHED — children only, no toggle.
//   A REFUSED MOVE IS REPORTED, never retried.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BOARD_NOTE = [
  "---",
  "noam_kind: board",
  "---",
  "",
  "## Doing",
  "",
  "- [ ] Ship the board",
  "",
  "## Done",
  "",
].join("\n");

const PLAIN_NOTE = "# Just a note\n\n- [ ] Not a card\n";

const mocks = vi.hoisted(() => ({
  text: "",
  revealLine: vi.fn(),
  planMoveLive: vi.fn(),
  applyTaskEdit: vi.fn(),
  editTask: vi.fn(),
  onFilesChanged: vi.fn(),
}));

vi.mock("../../lib/tasks", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The adapter reaches the store, Tauri and the live CodeMirror view; the
  // three entry points this surface uses are mocked, the planners are real.
  taskNoteText: async () => mocks.text,
  resolveTask: vi.fn(),
  applyTaskEdit: mocks.applyTaskEdit,
  editTask: mocks.editTask,
}));
vi.mock("../../lib/board", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  planMoveLive: mocks.planMoveLive,
}));
vi.mock("../../lib/workflows/adapter", () => ({ permissionForPath: () => "edit" }));
// The editor is a lazy chunk this test never mounts; what matters is that the
// line the card names reaches the reveal call.
vi.mock("../../lib/editor/activeView", () => ({
  getActiveNoteRevision: () => 0,
  subscribeActiveNote: () => () => {},
  revealLineInActiveNote: mocks.revealLine,
}));
vi.mock("../../lib/ipc", () => ({ onFilesChanged: mocks.onFilesChanged }));

import { BoardSurface } from "./BoardSurface";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The board host is lazy AND parses asynchronously: wait for the chunk, the
 *  text read and the paint, rather than guessing a tick count. */
async function settle(done: () => boolean = () => host.querySelector(".board-card") !== null) {
  for (let i = 0; i < 50 && !done(); i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let host: HTMLDivElement;
let root: Root;

async function render(path: string): Promise<void> {
  await act(async () => {
    root.render(
      createElement(BoardSurface, {
        path,
        children: createElement("div", { className: "editor-stand-in" }, "editor"),
      }),
    );
  });
  await settle();
}

beforeEach(() => {
  localStorage.clear();
  mocks.text = BOARD_NOTE;
  mocks.planMoveLive.mockReset();
  mocks.applyTaskEdit.mockReset();
  mocks.applyTaskEdit.mockResolvedValue({ ok: true, revision: "rev-2" });
  mocks.editTask.mockReset();
  mocks.onFilesChanged.mockReset();
  mocks.onFilesChanged.mockResolvedValue(() => {});
  mocks.revealLine.mockReset();
  mocks.revealLine.mockReturnValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("BoardSurface routing", () => {
  it("renders the board for a noam_kind: board note, and the toggle goes back to the text", async () => {
    await render("Boards/Sprint.md");
    expect(host.querySelector(".board-card")).not.toBeNull();
    expect(host.querySelector(".editor-stand-in")).toBeNull();

    const text = [...host.querySelectorAll<HTMLButtonElement>(".surface-tab")].find(
      (button) => button.textContent === "Text",
    )!;
    await act(async () => text.click());

    expect(host.querySelector(".editor-stand-in")).not.toBeNull();
    expect(host.querySelector(".board-host")).toBeNull();
    // Remembered per path, so reopening this board honours the choice.
    expect(localStorage.getItem("noam:board-view:Boards/Sprint.md")).toBe("text");
  });

  // Card-to-source navigation: switching surfaces is half of it; the caret has
  // to land on the card's own line, or Enter drops the user wherever the
  // editor happened to be.
  it("opens the text at the card's line", async () => {
    await render("Boards/Sprint.md");
    const card = host.querySelector<HTMLElement>(".board-card")!;
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(host.querySelector(".editor-stand-in")).not.toBeNull();
    // "- [ ] Ship the board" is the 7th line (0-based 6) of BOARD_NOTE.
    expect(mocks.revealLine).toHaveBeenCalledWith("Boards/Sprint.md", 6);
  });

  it("leaves a note that is not a board alone", async () => {
    mocks.text = PLAIN_NOTE;
    await render("Inbox.md");
    await settle(() => host.querySelector(".editor-stand-in") !== null);
    expect(host.querySelector(".editor-stand-in")).not.toBeNull();
    expect(host.querySelector(".surface-tab")).toBeNull();
    expect(host.querySelector(".board-host")).toBeNull();
  });

  it("says so, and writes nothing, when a move is refused as stale", async () => {
    mocks.planMoveLive.mockResolvedValue({
      ok: false,
      kind: "stale-target",
      message: "That card moved.",
    });
    await render("Boards/Sprint.md");

    const card = host.querySelector<HTMLElement>("[data-card-key], .board-card")!;
    expect(card).not.toBeNull();
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true }));
    });

    expect(mocks.planMoveLive).toHaveBeenCalledTimes(1);
    expect(mocks.applyTaskEdit).not.toHaveBeenCalled();
    expect(host.querySelector(".board-notice")?.textContent).toBe(
      "The board changed, refresh and try again",
    );
  });
});
