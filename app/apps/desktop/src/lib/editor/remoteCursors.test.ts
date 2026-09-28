// @vitest-environment jsdom
// The animated caret layer against a real EditorView + y-protocols awareness.
// jsdom has no layout, so `coordsAtPos` is stubbed to a fixed rect; everything
// else (the layer, the markers, the awareness plumbing) is the real thing.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import { remoteCursors } from "./remoteCursors";

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function setup(resolve?: Parameters<typeof remoteCursors>[2]) {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, "hello world, a note two people share");
  const local = new Awareness(doc);

  // Two remote clients, each with its own awareness, relayed into ours.
  const remotes = [
    { user: { id: "u2", participantId: "p-maya", name: "asserted-maya", color: "#000000" }, at: 3 },
    { user: { id: "u3", name: "Sam", color: "#696713" }, at: 10 },
  ].map(({ user, at }) => {
    const a = new Awareness(new Y.Doc());
    a.setLocalStateField("user", user);
    a.setLocalStateField("cursor", {
      anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, at)),
      head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, at)),
    });
    return a;
  });

  vi.spyOn(EditorView.prototype, "coordsAtPos").mockImplementation(() => ({
    left: 40,
    right: 40,
    top: 60,
    bottom: 76,
  }));
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: ytext.toString(), extensions: [remoteCursors(ytext, local, resolve)] }),
    parent,
  });
  for (const r of remotes) {
    applyAwarenessUpdate(local, encodeAwarenessUpdate(r, [r.clientID]), "remote");
  }
  return { view, parent };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("remoteCursors", () => {
  it("draws one caret per remote client with the resolver's name and color", async () => {
    const registry: Record<string, { name: string; color: string }> = {
      "p-maya": { name: "Maya", color: "#2981fb" },
    };
    const { view, parent } = setup((user) =>
      (user.participantId && registry[user.participantId]) || {
        name: user.name ?? "Someone",
        color: user.color ?? "#30bced",
      },
    );
    await frame();
    await frame();

    const layer = parent.querySelector(".cm-remoteCaretLayer")!;
    expect(layer).not.toBeNull();
    expect(layer.getAttribute("aria-hidden")).toBe("true");

    const carets = [...parent.querySelectorAll<HTMLElement>(".cm-remoteCaret")];
    expect(carets).toHaveLength(2);
    const byName = Object.fromEntries(
      carets.map((c) => [c.querySelector(".cm-remoteCaret-label")!.textContent, c]),
    );
    // Registry-signed: the known participant renders its registry identity…
    expect(Object.keys(byName).sort()).toEqual(["Maya", "Sam"]);
    expect(byName.Maya.style.getPropertyValue("--rc")).toBe("#2981fb");
    expect(byName.Maya.style.getPropertyValue("--rc-text")).toBe("#111111"); // 3.7:1 on white
    // …an unknown one keeps what it asserted.
    expect(byName.Sam.style.getPropertyValue("--rc")).toBe("#696713");
    expect(byName.Sam.style.getPropertyValue("--rc-text")).toBe("#ffffff");
    view.destroy();
  });

  it("falls back to the asserted awareness values without a resolver", async () => {
    const { view, parent } = setup();
    await frame();
    await frame();
    const labels = [...parent.querySelectorAll(".cm-remoteCaret-label")].map((l) => l.textContent).sort();
    expect(labels).toEqual(["Sam", "asserted-maya"]);
    view.destroy();
  });
});
