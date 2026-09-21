// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";

const mocks = vi.hoisted(() => ({
  localVaults: [] as Array<{ name: string; path: string }>,
  store: {
    session: null,
    organizations: [],
    members: [],
    billingConfig: null,
    syncEnabled: false,
    vault: { name: "Local vault", path: "/local-vault" },
    propertiesMode: "visible" as const,
    defaultViewMode: "live" as const,
    editorMeasure: 88,
    lineNumbers: false,
    setPropertiesMode: vi.fn(),
    setDefaultViewMode: vi.fn(),
    setEditorMeasure: vi.fn(),
    setLineNumbers: vi.fn(),
  },
}));

vi.mock("../../store", () => ({
  useStore: Object.assign(
    (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store),
    { getState: () => mocks.store },
  ),
}));

vi.mock("../useVaultLists", () => ({
  useLocalVaults: () => mocks.localVaults,
}));

vi.mock("../SettingsModal", async () => {
  const { createElement } = await import("react");
  return {
    SettingsModal: ({ children }: { children: ReactNode }) =>
      createElement("div", { className: "settings-test-modal" }, children),
  };
});

vi.mock("../AccountSettings", () => ({
  AccountSettingsSection: () => null,
}));

vi.mock("../VaultSettingsDialog", () => ({
  VaultSettingsSection: () => null,
}));

vi.mock("./InterfaceSettings", () => ({ InterfaceSettings: () => null }));
vi.mock("../ContentWidthPreview", () => ({ ContentWidthPreview: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SettingsDialog navigation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.localVaults = [];
    localStorage.clear();
    document.body.replaceChildren();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  const renderDialog = async () => {
    await act(async () => {
      root.render(
        createElement(SettingsDialog, {
          initialSection: "general",
          onClose: vi.fn(),
        }),
      );
    });
  };

  it("honors deep links immediately and after an unavailable section appears", async () => {
    await renderDialog();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("noam:open-settings", { detail: { section: "editor" } }),
      );
    });
    expect(document.querySelector(".settings-section-title")?.textContent).toBe("Editor");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("noam:open-settings", { detail: { section: "vaults" } }),
      );
    });
    expect(document.querySelector(".settings-section-title")?.textContent).toBe("General");

    mocks.localVaults = [{ name: "Local vault", path: "/local-vault" }];
    await renderDialog();
    expect(document.querySelector(".settings-section-title")?.textContent).toBe("Vaults");
  });

  it("moves focus from a search result to its interactive control", async () => {
    await renderDialog();
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search settings"]',
    );
    expect(search).not.toBeNull();

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(search, "content width");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const result = Array.from(document.querySelectorAll<HTMLButtonElement>(".settings-result"))
      .find((button) => button.textContent?.includes("Content width"));
    expect(result).toBeDefined();

    await act(async () => {
      result?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.querySelector(".settings-section-title")?.textContent).toBe("Editor");
    expect(document.activeElement).toBe(
      document.querySelector('input[aria-label="Content width"]'),
    );
  });

  it("lets a signed-out local-vault user change device editor preferences", async () => {
    await renderDialog();

    const appearance = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".settings-nav-item"),
    ).find((button) => button.textContent?.includes("Appearance"));
    expect(appearance).toBeDefined();

    localStorage.setItem("cbk-theme", "light");
    await act(async () => {
      appearance?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const theme = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="Theme:"]',
    );
    expect(theme).not.toBeNull();
    await act(async () => {
      theme?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(localStorage.getItem("cbk-theme")).toBe("dark");

    const editor = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".settings-nav-item"),
    ).find((button) => button.textContent?.includes("Editor"));
    await act(async () => {
      editor?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const width = document.querySelector<HTMLInputElement>(
      'input[aria-label="Content width"]',
    );
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(width, "92");
      width?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(mocks.store.setEditorMeasure).toHaveBeenCalledWith(92);

    const choose = async (control: string, option: string) => {
      const trigger = document.querySelector<HTMLButtonElement>(
        `button[aria-label="${control}"]`,
      );
      await act(async () => {
        trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const item = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
      ).find((candidate) => candidate.textContent?.includes(option));
      await act(async () => {
        item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };

    await choose("Default view mode", "Reading");
    expect(mocks.store.setDefaultViewMode).toHaveBeenCalledWith("reading");

    await choose("Properties in document", "Hidden");
    expect(mocks.store.setPropertiesMode).toHaveBeenCalledWith("hidden");
  });
});
