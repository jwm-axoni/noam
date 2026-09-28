// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({ openExternal: vi.fn(async () => {}) }));

import * as ipc from "../lib/ipc";
import { useLayoutStore } from "../layout/store";
import { applyLayoutOperation, findPanelTab } from "../layout/operations";
import { createDefaultLayout } from "../layout/types";
import type { PanelBodyProps } from "../layout/panelRegistry";
import type { VaultPeer } from "../lib/presence/roster";
import { useStore } from "../store";
import { PRESENCE_CHANGELOG_URL, PresencePanel } from "./PresencePanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const peer = (over: Partial<VaultPeer>): VaultPeer => ({
  userId: "u",
  docId: null,
  name: "X",
  color: "#2981fb",
  status: "online",
  lastSeenAt: 0,
  stale: false,
  ...over,
});

function fakeMatchMedia(narrow: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: narrow && query === "(max-width: 699px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

describe("PresencePanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let instanceId: string;
  const initial = useStore.getState();

  beforeEach(() => {
    fakeMatchMedia(false);
    const layout = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "presence",
      zone: "right",
    });
    useLayoutStore.getState().hydrate("/vault", layout);
    instanceId = (findPanelTab(layout, "presence")!.tab as { panelId: string }).panelId;
    useStore.setState({
      openNote: { path: "Plan.md", id: "local-1" } as ReturnType<typeof useStore.getState>["openNote"],
      docIdByPath: { "Plan.md": "doc-plan" },
      vaultPresence: [
        peer({ userId: "u-maya", name: "Maya", docId: "doc-plan" }),
        peer({ userId: "u-sam", name: "Sam", docId: "doc-other" }),
        peer({ userId: "u-lee", name: "Lee", docId: "doc-plan", stale: true }),
        peer({ userId: "u-ida", name: "Ida", docId: null }),
      ],
      presenceLastLeave: null,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useStore.setState({
      openNote: initial.openNote,
      docIdByPath: initial.docIdByPath,
      vaultPresence: initial.vaultPresence,
      presenceLastLeave: initial.presenceLastLeave,
    });
  });

  const render = () =>
    act(() => root.render(createElement(PresencePanel, { instanceId } as PanelBodyProps)));
  const names = (section: string) =>
    [...container.querySelectorAll(`[data-section="${section}"] .presence-name`)].map((n) => n.textContent);

  it("sorts peers into Online now and In this note, dimming the stale", () => {
    render();
    expect(names("online")).toEqual(["Ida", "Maya", "Sam", "Lee"]);
    expect(names("note")).toEqual(["Maya", "Lee"]);
    const lee = container.querySelector('[data-section="note"] [data-user-id="u-lee"]')!;
    expect(lee.classList.contains("stale")).toBe(true);
    expect(lee.textContent).toContain("no signal for 30 s");
    const maya = container.querySelector('[data-section="online"] [data-user-id="u-maya"]')!;
    expect(maya.classList.contains("stale")).toBe(false);
  });

  it("shows the agents empty state and opens the changelog externally", () => {
    render();
    const agents = container.querySelector('[data-section="agents"]')!;
    expect(agents.textContent).toContain("No agents yet. Agents arrive in Phase 3.");
    expect(agents.querySelector("a")).toBeNull();
    const link = [...agents.querySelectorAll("button")].find((b) => b.textContent === "What's coming")!;
    act(() => link.click());
    expect(ipc.openExternal).toHaveBeenCalledWith(PRESENCE_CHANGELOG_URL);
    expect(PRESENCE_CHANGELOG_URL).toBe("https://noamapp.io/changelog");
  });

  it("shows the last leave note", () => {
    useStore.setState({ presenceLastLeave: { text: "Maya lost connection", at: 1 } });
    render();
    expect(container.querySelector(".presence-leave-note")!.textContent).toBe("Maya lost connection");
  });

  it("collapses a section and stores the flag on the panel instance", () => {
    render();
    const header = container.querySelector<HTMLButtonElement>('[data-section="online"] .presence-section-header')!;
    act(() => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(names("online")).toEqual([]);
    expect(useLayoutStore.getState().layout.panels[instanceId].state.collapsed).toEqual({ online: true });
  });

  it("renders nothing below 700 px", () => {
    fakeMatchMedia(true);
    render();
    expect(container.innerHTML).toBe("");
  });
});
