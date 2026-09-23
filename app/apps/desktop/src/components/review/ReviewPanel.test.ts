// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelBodyProps } from "../../layout/panelRegistry";
import { SUGGESTIONS_V0_FLAG } from "../../lib/review/flag";
import { PHASE_2_HINT, ReviewPanel } from "./ReviewPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const props: PanelBodyProps = {
  instanceId: "review-1", vaultKey: "v", vaultEpoch: 0, activeNotePath: null,
  visible: true, compact: false, onOpenNote: () => {}, onRequestClose: () => {},
};

let container: HTMLDivElement;
let root: Root;
// Node 26 ships its own (disabled) localStorage global that hides jsdom's, so stub it.
let storage: Map<string, string>;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("ReviewPanel", () => {
  it("flag off: empty state plus the Phase 2 line", async () => {
    await act(async () => root.render(createElement(ReviewPanel, props)));
    expect(container.textContent).toContain("Nothing to review. You are caught up.");
    expect(container.textContent).toContain(PHASE_2_HINT);
    expect(container.querySelectorAll(".review-card")).toHaveLength(0);
  });

  it("flag on: the three demo suggestions and the digest", async () => {
    storage.set(SUGGESTIONS_V0_FLAG, "1");
    await act(async () => root.render(createElement(ReviewPanel, props)));
    expect(container.querySelectorAll(".review-card")).toHaveLength(3);
    expect(container.textContent).toContain("While you were away");
    expect(container.textContent).not.toContain(PHASE_2_HINT);
    expect(container.textContent).toContain("Keep theirs");
    expect(container.textContent).not.toContain("Keep both"); // the demo conflict is a title
  });
});
