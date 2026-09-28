// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewAuthor, Suggestion } from "../../lib/review/model";
import { RAIL_MIN_WIDTH, ReviewSurface, type ReviewSurfaceProps } from "./ReviewSurface";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- a controllable ResizeObserver ----
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  targets: Element[] = [];
  constructor(private cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.targets = [];
  }
  static resize(width: number) {
    for (const ro of FakeResizeObserver.instances) {
      const entries = ro.targets.map((target) => ({ target, contentRect: { width } }) as unknown as ResizeObserverEntry);
      if (entries.length) ro.cb(entries, ro as unknown as ResizeObserver);
    }
  }
}

const me: ReviewAuthor = { participantId: "user-john", displayName: "John", color: "#7f73ff", kind: "human" };
const claude: ReviewAuthor = { participantId: "agent-claude", displayName: "Claude", color: "#009E73", kind: "agent" };
const codex: ReviewAuthor = { participantId: "agent-codex", displayName: "Codex", color: "#0072B2", kind: "agent" };

function sug(id: string, over: Partial<Suggestion> = {}): Suggestion {
  return {
    id, docId: "doc-1", author: claude, kind: "replace", from: 0, to: 3,
    before: "old text", after: "new text", createdAt: 1, title: `Title ${id}`, state: "pending", ...over,
  };
}

const fixture = (): Suggestion[] => [
  sug("a"),
  sug("b", { kind: "insert", before: "", after: "Publish the migration guide" }),
  sug("c", { kind: "delete", before: "Drop me", after: "" }),
  sug("d", { author: codex, state: "conflict", before: "Q3 Planning", after: "Q3 Launch Plan", mine: "Q3 Planning (draft)", target: "title" }),
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  document.body.replaceChildren();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(over: Partial<ReviewSurfaceProps> = {}) {
  const props: ReviewSurfaceProps = {
    suggestions: fixture(),
    me,
    docId: "doc-1",
    onDecision: vi.fn(),
    onReveal: vi.fn(),
    onResolveConflict: vi.fn(),
    ...over,
  };
  await act(async () => {
    root.render(createElement(ReviewSurface, props));
  });
  return props;
}

async function resize(width: number) {
  await act(async () => FakeResizeObserver.resize(width));
}

async function key(target: Element, k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
}

const surface = () => container.querySelector<HTMLElement>(".review-surface")!;
const barText = () => container.querySelector(".review-bar-pos")?.textContent;
const live = () => container.querySelector('[aria-live="polite"]')!.textContent;
const button = (label: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(label))!;

describe("ReviewSurface layout", () => {
  it("shows the Rail at >= RAIL_MIN_WIDTH and the chip bar below, measured on the host", async () => {
    await render();
    await resize(1200);
    expect(surface().dataset.reviewLayout).toBe("rail");
    expect(container.querySelector(".review-rail")).not.toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();

    await resize(RAIL_MIN_WIDTH - 40);
    expect(surface().dataset.reviewLayout).toBe("chips");
    expect(container.querySelector(".review-rail")).toBeNull();
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(4);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");

    await resize(RAIL_MIN_WIDTH);
    expect(surface().dataset.reviewLayout).toBe("rail");
  });

  it("renders the empty state and the extra hint when there is nothing to review", async () => {
    await render({ suggestions: [], emptyHint: "Suggestions arrive with Phase 2 (needs ADR-1)." });
    expect(container.textContent).toContain("Nothing to review. You are caught up.");
    expect(container.textContent).toContain("Suggestions arrive with Phase 2 (needs ADR-1).");
  });
});

describe("ReviewSurface keyboard", () => {
  it("] A R decides two items and the bar count updates", async () => {
    const props = await render();
    await resize(1200);
    expect(barText()).toBe("1 of 4 waiting");
    const focusTarget = container.querySelector<HTMLElement>(".review-rail .review-card-head")!;
    focusTarget.focus();

    await key(focusTarget, "]");
    expect(barText()).toBe("2 of 4 waiting");
    expect(props.onReveal).toHaveBeenLastCalledWith("b");

    await key(focusTarget, "a");
    expect(props.onDecision).toHaveBeenCalledWith("b", "accept");
    expect(barText()).toBe("2 of 3 waiting"); // advanced to c

    await key(focusTarget, "R");
    expect(props.onDecision).toHaveBeenCalledWith("c", "reject");
    expect(barText()).toBe("2 of 2 waiting"); // advanced to d, the conflict
    expect(container.querySelector(".review-count")?.textContent).toBe("2 waiting");
    expect(container.textContent).toContain("Accepted · reversible for 30 days");
    expect(container.textContent).toContain("Rejected");
    expect(props.onDecision).toHaveBeenCalledTimes(2);
  });

  it("ignores the grammar from a text field inside the surface and from outside it", async () => {
    const props = await render();
    await resize(1200);
    const select = container.querySelector("select")!;
    await key(select, "a");
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    editor.innerHTML = '<div class="cm-content" contenteditable="true"></div>';
    document.body.append(editor);
    await key(editor.firstElementChild!, "a");
    await key(document.body, "]");
    expect(props.onDecision).not.toHaveBeenCalled();
    expect(barText()).toBe("1 of 4 waiting");
  });

  it("Cmd+A inside the rail does not accept", async () => {
    const props = await render();
    await resize(1200);
    const head = container.querySelector<HTMLElement>(".review-card-head")!;
    await key(head, "a", { metaKey: true });
    expect(props.onDecision).not.toHaveBeenCalled();
  });
});

describe("ReviewSurface session", () => {
  it("enters on demand, A on a conflict only asks for a choice, Escape leaves", async () => {
    vi.useFakeTimers();
    const props = await render({ suggestions: [sug("d", { author: codex, state: "conflict", mine: "Mine", target: "title" })] });
    await resize(1200);
    await act(async () => button("Focus mode", container).click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.dataset.reviewZone).toBe("session");
    expect(document.activeElement).toBe(dialog);
    // title conflict: no Keep both
    expect(button("Keep mine", dialog)).toBeDefined();
    expect(button("Keep both", dialog)).toBeUndefined();

    await key(dialog, "a");
    expect(props.onDecision).not.toHaveBeenCalled();
    expect(props.onResolveConflict).not.toHaveBeenCalled();
    expect(live()).toBe("This one needs a choice");

    await key(dialog, "Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("the batch button accepts one agent's items and leaves the conflict", async () => {
    const props = await render();
    await resize(1200);
    await act(async () => button("Accept all from Claude in this note", container).click());
    expect((props.onDecision as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ["a", "accept"],
      ["b", "accept"],
      ["c", "accept"],
    ]);
    expect(barText()).toBe("1 of 1 waiting");
    expect(props.onResolveConflict).not.toHaveBeenCalled();
  });

  it("does not let me accept my own suggestion", async () => {
    const props = await render({ suggestions: [sug("mine", { author: me })] });
    await resize(1200);
    const head = container.querySelector<HTMLElement>(".review-card-head")!;
    await key(head, "a");
    expect(props.onDecision).not.toHaveBeenCalled();
    expect(button("Accept", container.querySelector(".review-card")!).disabled).toBe(true);
    expect(live()).toBe("You can't accept your own suggestion.");
  });
});

describe("ReviewSurface live region", () => {
  it("speaks at most once per 5 seconds, ending on the latest", async () => {
    vi.useFakeTimers();
    await render();
    await resize(1200);
    const regions = container.querySelectorAll("[aria-live]");
    expect(regions).toHaveLength(1);
    const head = container.querySelector<HTMLElement>(".review-card-head")!;
    await key(head, "]");
    const first = live();
    expect(first).toContain("2 of 4");
    await key(head, "]");
    await key(head, "]");
    expect(live()).toBe(first);
    await act(async () => vi.advanceTimersByTime(4999));
    expect(live()).toBe(first);
    await act(async () => vi.advanceTimersByTime(1));
    expect(live()).toContain("4 of 4");
  });
});

describe("ReviewSurface untrusted content (F12)", () => {
  const payload = `<img src=x onerror="window.__pwned=1"><a href="javascript:alert(1)">x</a>`;
  const evil: ReviewAuthor = { participantId: "agent-evil", displayName: "<b>Claude</b>", color: "url(https://evil.example/x)", kind: "agent" };
  const hostile = (): Suggestion[] => [
    sug("x", { author: evil, title: payload, after: payload }),
    sug("y", { author: evil, state: "conflict", mine: payload, after: payload }),
  ];

  function assertInert(scope: Element) {
    expect(scope.querySelector("img")).toBeNull();
    expect(scope.querySelector("a")).toBeNull();
    expect(scope.querySelector("b")).toBeNull();
    expect(scope.textContent).toContain(payload);
    expect(scope.textContent).toContain("<b>Claude</b>");
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  }

  it("renders payloads as literal text in the rail, the chip bar and the session", async () => {
    await render({ suggestions: hostile() });
    await resize(1200);
    assertInert(surface());
    for (const av of Array.from(container.querySelectorAll<HTMLElement>(".review-avatar"))) {
      expect(av.getAttribute("style") ?? "").not.toContain("url(");
    }

    await resize(600);
    assertInert(surface());

    await act(async () => button("Focus mode", container).click());
    assertInert(document.querySelector('[role="dialog"]')!);
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Next suggestion"]')!.click());
    assertInert(document.querySelector('[role="dialog"]')!);
  });
});
