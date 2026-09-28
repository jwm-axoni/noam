// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { focusContextOf, reviewKeyAction, type ReviewKeyEvent } from "./keys";

function ev(key: string, target: EventTarget | null, over: Partial<ReviewKeyEvent> = {}): ReviewKeyEvent {
  return { key, target, ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false, defaultPrevented: false, ...over };
}

let rail: HTMLElement;
let railButton: HTMLButtonElement;
let session: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = `
    <div data-review-zone="rail" id="rail"><button id="rb">Accept</button><select id="sel"><option>a</option></select>
      <input id="inp"><textarea id="ta"></textarea><div contenteditable="true" id="ce"><span id="ce-child">x</span></div>
      <div class="cm-editor"><div class="cm-content" id="cm"></div></div>
    </div>
    <div data-review-zone="session" id="session" tabindex="-1"></div>
    <div data-review-zone="bar" id="bar"><button id="barb">x</button></div>
    <div data-review-zone="chips" id="chips"><button id="chip">x</button></div>
    <div class="cm-editor"><div class="cm-content" contenteditable="true" id="editor"><p id="line">text</p></div></div>
    <button id="outside">x</button>`;
  rail = document.getElementById("rail")!;
  railButton = document.getElementById("rb") as HTMLButtonElement;
  session = document.getElementById("session")!;
});

const $ = (id: string) => document.getElementById(id)!;

describe("focusContextOf", () => {
  it("names the review zone that holds the element", () => {
    expect(focusContextOf(railButton)).toBe("rail");
    expect(focusContextOf(session)).toBe("session");
    expect(focusContextOf($("barb"))).toBe("bar");
    expect(focusContextOf($("chip"))).toBe("chips");
    expect(focusContextOf($("outside"))).toBeNull();
    expect(focusContextOf(null)).toBeNull();
  });
});

describe("reviewKeyAction", () => {
  it("maps the grammar when focus is on the rail", () => {
    expect(reviewKeyAction(ev("]", railButton), "rail")).toBe("next");
    expect(reviewKeyAction(ev("[", railButton), "rail")).toBe("prev");
    expect(reviewKeyAction(ev("a", railButton), "rail")).toBe("accept");
    expect(reviewKeyAction(ev("A", railButton), "rail")).toBe("accept");
    expect(reviewKeyAction(ev("r", railButton), "rail")).toBe("reject");
    expect(reviewKeyAction(ev("R", railButton), "rail")).toBe("reject");
  });

  it("works in the session, the bar and the chip bar", () => {
    expect(reviewKeyAction(ev("a", session), "session")).toBe("accept");
    expect(reviewKeyAction(ev("]", $("barb")), "bar")).toBe("next");
    expect(reviewKeyAction(ev("r", $("chip")), "chips")).toBe("reject");
  });

  it("does nothing when focus is outside every review zone", () => {
    expect(reviewKeyAction(ev("a", $("outside")), null)).toBeNull();
    expect(reviewKeyAction(ev("]", document.body), null)).toBeNull();
  });

  it("never fires inside the CodeMirror editor", () => {
    expect(reviewKeyAction(ev("a", $("editor")), null)).toBeNull();
    expect(reviewKeyAction(ev("a", $("line")), null)).toBeNull();
    // even if a zone is (wrongly) claimed, the editor still wins
    expect(reviewKeyAction(ev("a", $("line")), "rail")).toBeNull();
    expect(reviewKeyAction(ev("]", $("cm")), "rail")).toBeNull();
  });

  it("never fires in contenteditable, inputs, textareas or selects", () => {
    for (const id of ["ce", "ce-child", "inp", "ta", "sel"]) {
      expect(reviewKeyAction(ev("a", $(id)), "rail"), id).toBeNull();
      expect(reviewKeyAction(ev("]", $(id)), "rail"), id).toBeNull();
    }
  });

  it("ignores modified keys (Cmd+A, Ctrl+R, Alt+[) and IME composition", () => {
    expect(reviewKeyAction(ev("a", railButton, { metaKey: true }), "rail")).toBeNull();
    expect(reviewKeyAction(ev("r", railButton, { ctrlKey: true }), "rail")).toBeNull();
    expect(reviewKeyAction(ev("[", railButton, { altKey: true }), "rail")).toBeNull();
    expect(reviewKeyAction(ev("a", railButton, { isComposing: true }), "rail")).toBeNull();
    expect(reviewKeyAction(ev("a", railButton, { defaultPrevented: true }), "rail")).toBeNull();
  });

  it("a held-down A or R decides once, while ] and [ may repeat", () => {
    expect(reviewKeyAction(ev("a", railButton, { repeat: true }), "rail")).toBeNull();
    expect(reviewKeyAction(ev("r", railButton, { repeat: true }), "rail")).toBeNull();
    expect(reviewKeyAction(ev("]", railButton, { repeat: true }), "rail")).toBe("next");
  });

  it("Escape leaves only the session", () => {
    expect(reviewKeyAction(ev("Escape", session), "session")).toBe("leave");
    expect(reviewKeyAction(ev("Escape", railButton), "rail")).toBeNull();
    expect(reviewKeyAction(ev("Escape", rail), null)).toBeNull();
  });

  it("ignores unrelated keys", () => {
    expect(reviewKeyAction(ev("x", railButton), "rail")).toBeNull();
    expect(reviewKeyAction(ev("Enter", railButton), "rail")).toBeNull();
  });
});
