// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readNote: vi.fn(),
  setVaultTypes: vi.fn(),
}));

vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return { ...actual, readNote: mocks.readNote, setVaultTypes: mocks.setVaultTypes };
});

import {
  loadKnowledgeCatalog,
  resetKnowledgeCatalog,
} from "../../lib/knowledge/catalogStore";
import { useStore } from "../../store";
import { addPropertyToNote, PropertiesPanel } from "./PropertiesPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CATALOG = `---
noam_kind: knowledge-schema
noam_knowledge_version: 1
---

\`\`\`json
${JSON.stringify({
  version: 1,
  properties: [
    {
      id: "workflow-status",
      key: "status",
      name: "Workflow status",
      type: { kind: "label", cardinality: "one" },
      allowedLabelIds: ["active-a", "active-b"],
    },
    {
      id: "topics",
      key: "topics",
      name: "Topics",
      type: { kind: "tag", cardinality: "many" },
      allowedLabelIds: ["active-a", "active-b"],
    },
    {
      id: "priority",
      key: "priority",
      name: "Priority",
      type: { kind: "text", cardinality: "one" },
    },
  ],
  labels: [
    { id: "active-a", name: "Active", color: "#16a34a" },
    { id: "active-b", name: "Active", color: "#2563eb" },
  ],
  relationships: [],
})}
\`\`\``;

describe("portable Properties rows", () => {
  let root: Root;
  let host: HTMLDivElement;
  let editorHost: HTMLDivElement;
  let view: EditorView;

  const render = async () => {
    await act(async () => root.render(createElement(PropertiesPanel, {
      view,
      readOnly: false,
      collapsed: false,
      onCollapsedChange: () => {},
      showHeader: false,
    })));
  };

  const setInput = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  beforeEach(async () => {
    resetKnowledgeCatalog();
    mocks.readNote.mockReset().mockResolvedValue(CATALOG);
    mocks.setVaultTypes.mockReset().mockResolvedValue(undefined);
    useStore.setState({ vault: { path: "/vault-a", name: "vault-a", epoch: 1 } });
    await loadKnowledgeCatalog(1);
    host = document.createElement("div");
    editorHost = document.createElement("div");
    document.body.append(host, editorHost);
    root = createRoot(host);
    view = new EditorView({
      state: EditorState.create({
        doc: "---\nstatus: active-a\ntopics: [active-a]\nlegacy: 42\n---\nBody",
      }),
      parent: editorHost,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    view.destroy();
    host.remove();
    editorHost.remove();
    resetKnowledgeCatalog();
  });

  it("shows portable names, locks storage keys, and keeps unknown YAML raw and read-only", async () => {
    await render();

    const names = [...host.querySelectorAll<HTMLInputElement>(".prop-name")];
    expect(names.map((input) => input.value)).toEqual(["Workflow status", "Topics", "legacy"]);
    expect(names.every((input) => input.disabled)).toBe(true);
    expect(host.querySelector('[aria-label="legacy raw value"]')?.textContent).toBe(" 42");
    expect([...host.querySelectorAll<HTMLButtonElement>(".prop-remove")].map(
      (button) => button.getAttribute("aria-label"),
    )).toEqual(["Remove status", "Remove topics"]);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Type of status"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Type of legacy"]')?.disabled).toBe(true);

    expect(mocks.setVaultTypes).not.toHaveBeenCalled();
  });

  it("keeps defined keys stable while allowing their values to be removed", async () => {
    await render();

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Remove status"]')!.click());
    expect(view.state.doc.toString()).not.toContain("status: active-a");
    expect(view.state.doc.toString()).toContain("topics: [active-a]");
    expect(view.state.doc.toString()).toContain("legacy: 42");
  });

  it("does not expose legacy edits before the catalog request resolves", async () => {
    resetKnowledgeCatalog();
    let resolveCatalog!: (value: string) => void;
    const pendingCatalog = new Promise<string>((resolve) => { resolveCatalog = resolve; });
    mocks.readNote.mockReturnValueOnce(pendingCatalog);
    const loading = loadKnowledgeCatalog(1);
    await render();

    expect([...host.querySelectorAll<HTMLInputElement>(".prop-name")].every(
      (input) => input.disabled,
    )).toBe(true);
    expect(host.querySelector(".prop-add")).toBeNull();
    expect(addPropertyToNote(view)).toBe(false);
    expect(view.state.doc.toString()).toContain("legacy: 42");

    await act(async () => {
      resolveCatalog(CATALOG);
      await loading;
    });
  });

  it("does not reuse a previous vault's catalog during an epoch transition", async () => {
    useStore.setState({ vault: { path: "/vault-b", name: "vault-b", epoch: 2 } });
    await render();

    expect([...host.querySelectorAll<HTMLInputElement>(".prop-name")].every(
      (input) => input.disabled,
    )).toBe(true);
    expect(host.querySelector(".prop-add")).toBeNull();
    expect(addPropertyToNote(view)).toBe(false);
  });

  it("uses portable IDs and colors for tags even when display names are ambiguous", async () => {
    await render();

    const chip = host.querySelector<HTMLElement>(".prop-chip")!;
    expect(chip.textContent).toContain("Active");
    expect(chip.style.getPropertyValue("--prop-chip-color")).toBe("#16a34a");
    const options = [...host.querySelectorAll<HTMLOptionElement>("datalist option")];
    expect(options.map((option) => [option.value, option.label])).toEqual(expect.arrayContaining([
      ["active-a", "Active"],
      ["active-b", "Active"],
    ]));

    const input = host.querySelector<HTMLInputElement>('[aria-label="Add to topics"]')!;
    await act(async () => {
      setInput(input, "Active");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(view.state.doc.toString()).toContain("topics: [active-a]");
    expect(host.textContent).toContain("Choose one of this property's allowed labels.");

    await act(async () => {
      setInput(input, "active-b");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(view.state.doc.toString()).toContain("topics: [active-a, active-b]");
  });

  it("keeps a scalar label input keyed by its portable id", async () => {
    await render();

    const input = host.querySelector<HTMLInputElement>('[aria-label="status"]')!;
    expect(input.value).toBe("active-a");
    expect(input.parentElement?.querySelector(".prop-label-name")?.textContent).toBe("Active");

    await act(async () => setInput(input, "active-"));
    await act(async () => setInput(input, "active-a"));
    await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(view.state.doc.toString()).toContain("status: active-a");
    expect(view.state.doc.toString()).not.toContain("status: Active");
  });

  it("adds the next catalog definition instead of inventing an unknown key", async () => {
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>(".prop-add")!.click());
    expect(view.state.doc.toString()).toContain("priority:");
    expect(view.state.doc.toString()).not.toContain("property:");
    expect(mocks.setVaultTypes).not.toHaveBeenCalled();
  });
});
