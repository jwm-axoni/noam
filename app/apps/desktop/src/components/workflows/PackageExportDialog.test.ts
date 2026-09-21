// @vitest-environment jsdom
//
// The registry keeps broken workflow notes on purpose, so this picker is the
// place that has to say no: an unreadable definition has no id, and a package
// containing an id-less workflow entry is an artifact `validatePackage` refuses
// — built, saved, and then unimportable. Such rows are listed, disabled, with
// the reason, and never reach the entries.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWorkflow } from "../../lib/workflows";

const mocks = vi.hoisted(() => ({
  workflows: [] as RegisteredWorkflow[],
  listTree: vi.fn(),
}));

vi.mock("./service", () => ({
  useWorkflows: () => mocks.workflows,
  packageContext: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ({
  listTree: mocks.listTree,
  saveFile: vi.fn(),
  writeExternalFile: vi.fn(),
}));
vi.mock("../../lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("../../lib/toast", () => ({ toast: vi.fn() }));
// The real index pulls the store and the whole engine in; this dialog only
// needs these five values from it.
vi.mock("../../lib/workflows", () => ({
  DEFAULT_TEMPLATES_FOLDER: "Templates",
  PACKAGE_FILE_SUFFIX: ".noam-package.json",
  WORKFLOW_ID_PATTERN: /^[a-z0-9][a-z0-9-]{0,63}$/,
  exportPackage: vi.fn(),
  serializePackage: vi.fn(),
}));

import { PackageExportDialog, exportBlockReason, selectedEntries } from "./PackageExportDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const good: RegisteredWorkflow = {
  id: "capture",
  path: "Workflows/Capture.md",
  definition: { version: 1, id: "capture", name: "Capture", steps: [] } as never,
  issues: [],
  runnable: true,
};

/** A note the registry could not read at all: no definition, no id. */
const unreadable: RegisteredWorkflow = {
  id: "",
  path: "Workflows/Broken.md",
  definition: null,
  issues: [{ severity: "error", code: "bad-json", message: "The JSON block is not valid JSON." }],
  runnable: false,
};

/** A definition that parsed but does not validate. */
const invalid: RegisteredWorkflow = {
  id: "half",
  path: "Workflows/Half.md",
  definition: { version: 1, id: "half", name: "Half", steps: [] } as never,
  issues: [{ severity: "error", code: "missing-field", message: "`content` is required." }],
  runnable: false,
};

describe("exportBlockReason", () => {
  it("passes a runnable workflow and explains every refusal", () => {
    expect(exportBlockReason(good)).toBeNull();
    expect(exportBlockReason(unreadable)).toMatch(/readable/i);
    expect(exportBlockReason(invalid)).toBe("`content` is required.");
    expect(exportBlockReason({ ...good, id: "" })).toMatch(/no id/i);
  });
});

describe("selectedEntries", () => {
  it("never exports a blocked workflow, even if it is somehow selected", () => {
    const chosen = new Set([good.path, unreadable.path, invalid.path, "Templates/Daily.md"]);

    expect(selectedEntries([good, unreadable, invalid], ["Templates/Daily.md"], chosen)).toEqual([
      { path: "Templates/Daily.md", kind: "template" },
      { path: "Workflows/Capture.md", kind: "workflow", id: "capture" },
    ]);
  });
});

describe("PackageExportDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  const rowFor = (path: string) =>
    [...container.querySelectorAll<HTMLLabelElement>("label")].find((label) =>
      label.textContent?.includes(path),
    )!;

  beforeEach(async () => {
    mocks.workflows = [good, unreadable, invalid];
    mocks.listTree.mockResolvedValue({ path: "", isDir: true, children: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(PackageExportDialog, {
          vault: { path: "/v", epoch: 7 },
          onClose: () => {},
        }),
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("lists a broken workflow disabled, with the reason, and leaves the good one pickable", () => {
    const blocked = rowFor("Workflows/Broken.md");
    expect(blocked.querySelector("input")!.disabled).toBe(true);
    expect(blocked.textContent).toMatch(/can't export/i);
    expect(blocked.textContent).toMatch(/readable/i);

    const half = rowFor("Workflows/Half.md");
    expect(half.querySelector("input")!.disabled).toBe(true);
    expect(half.textContent).toContain("`content` is required.");

    expect(rowFor("Workflows/Capture.md").querySelector("input")!.disabled).toBe(false);
  });

  it("keeps Build package disabled until something exportable is picked", async () => {
    const build = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Build package",
      )!;
    expect(build().disabled).toBe(true);

    await act(async () => {
      rowFor("Workflows/Capture.md").querySelector("input")!.click();
    });
    expect(build().disabled).toBe(false);
  });
});
