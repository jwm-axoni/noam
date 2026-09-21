// @vitest-environment jsdom
//
// Keyboard is the contract, not the fallback: every card move this view can
// make must be reachable without a pointer, and the card the user moved must
// still be the focused card after the document comes back re-parsed.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBoard } from "../../lib/board";
import { BoardView } from "./BoardView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const board = (todo: string[], doing: string[]) =>
  parseBoard(
    ["---", "noam_kind: board", "---", "", "## Todo", "", ...todo, "", "## Doing", "", ...doing, ""].join("\n"),
    { path: "Boards/B.md", docId: "d1" },
  );

const DOC = board(["- [ ] Alpha", "- [ ] Beta"], ["- [x] Delta"]);

let container: HTMLDivElement;
let root: Root;
const onMove = vi.fn();
const onToggle = vi.fn();
const onOpen = vi.fn();

function render(props: Partial<Parameters<typeof BoardView>[0]> = {}) {
  act(() => {
    root.render(
      createElement(BoardView, { doc: DOC, onMove, onToggle, onOpen, ...props }),
    );
  });
}

const cards = () => Array.from(container.querySelectorAll<HTMLElement>(".board-card"));
const card = (text: string) => cards().find((el) => el.textContent?.includes(text))!;

function press(el: HTMLElement, key: string, mods: Partial<KeyboardEventInit> = {}) {
  act(() => {
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onMove.mockClear();
  onToggle.mockClear();
  onOpen.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("BoardView keyboard", () => {
  it("renders one column per lane with its cards", () => {
    render();
    expect(
      Array.from(container.querySelectorAll(".board-lane")).map((el) => el.getAttribute("data-lane")),
    ).toEqual(["Todo", "Doing"]);
    expect(cards()).toHaveLength(3);
  });

  it("moves a card to the next lane with ]", () => {
    render();
    press(card("Alpha"), "]");
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][0]).toEqual({
      cardRef: { docId: "d1", taskId: null, lineHint: 6, sourceText: "- [ ] Alpha" },
      toLane: "Doing",
      toIndex: 0,
      // The ANCHOR: the card the user saw this one land above. `toIndex` counts
      // the board we painted; this names what it meant.
      beforeCardRef: { docId: "d1", taskId: null, lineHint: 11, sourceText: "- [x] Delta" },
    });
  });

  it("moves a card to the previous lane with Shift+ArrowLeft", () => {
    render();
    press(card("Delta"), "ArrowLeft", { shiftKey: true });
    expect(onMove.mock.calls[0][0]).toMatchObject({ toLane: "Todo", toIndex: 0 });
  });

  it("reorders inside a lane with Alt+Arrow", () => {
    render();
    press(card("Alpha"), "ArrowDown", { altKey: true });
    // Last in the lane once Alpha is taken out of it: no anchor, the end.
    expect(onMove.mock.calls[0][0]).toMatchObject({
      toLane: "Todo",
      toIndex: 1,
      beforeCardRef: null,
    });
    onMove.mockClear();
    press(card("Beta"), "ArrowUp", { altKey: true });
    expect(onMove.mock.calls[0][0]).toMatchObject({
      toLane: "Todo",
      toIndex: 0,
      beforeCardRef: { docId: "d1", taskId: null, lineHint: 6, sourceText: "- [ ] Alpha" },
    });
  });

  it("does nothing at the ends", () => {
    render();
    press(card("Alpha"), "[");
    press(card("Alpha"), "ArrowUp", { altKey: true });
    press(card("Delta"), "]");
    expect(onMove).not.toHaveBeenCalled();
  });

  it("navigates focus with plain arrows and never moves", () => {
    render();
    press(card("Alpha"), "ArrowDown");
    expect(document.activeElement).toBe(card("Beta"));
    press(card("Beta"), "ArrowRight");
    expect(document.activeElement).toBe(card("Delta"));
    expect(onMove).not.toHaveBeenCalled();
  });

  it("opens with Enter and toggles with Space", () => {
    render();
    press(card("Alpha"), "Enter");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].task.sourceText).toBe("- [ ] Alpha");
    press(card("Alpha"), " ");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("keeps one tab stop for the whole board", () => {
    render();
    expect(cards().map((el) => el.tabIndex)).toEqual([0, -1, -1]);
    press(card("Beta"), "ArrowUp");
    expect(cards().map((el) => el.tabIndex)).toEqual([0, -1, -1]);
    press(card("Alpha"), "ArrowDown");
    expect(cards().map((el) => el.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("keeps focus on the moved card after the document comes back", () => {
    render();
    press(card("Alpha"), "]");
    const moved = board(["- [ ] Beta"], ["- [ ] Alpha", "- [x] Delta"]);
    act(() => {
      root.render(createElement(BoardView, { doc: moved, onMove, onToggle, onOpen }));
    });
    expect(document.activeElement).toBe(card("Alpha"));
    expect(
      card("Alpha").closest(".board-lane")?.getAttribute("data-lane"),
    ).toBe("Doing");
  });
});

describe("BoardView read-only", () => {
  it("shows the reason, disables the controls and refuses every write", () => {
    render({ readOnly: { reason: "Shared with you as read-only" } });
    expect(container.textContent).toContain("Shared with you as read-only");
    expect(
      Array.from(container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")).every(
        (el) => el.disabled,
      ),
    ).toBe(true);
    press(card("Alpha"), "]");
    press(card("Alpha"), " ");
    expect(onMove).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
    press(card("Alpha"), "Enter");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
