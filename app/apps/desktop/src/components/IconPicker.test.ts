// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IconPicker } from "./IconPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("IconPicker", () => {
  let container: HTMLDivElement;
  let root: Root;
  const vaultScope = "/vaults/alpha";
  const captureAssetTarget = () => ({
    vaultEpoch: 7,
    vaultScope,
    isCurrent: () => true,
  });
  const assetExists = vi.fn<(path: string) => Promise<boolean>>(async () => true);

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it("offers a large lazy catalogue and chooses the active icon by keyboard", async () => {
    const onChoose = vi.fn();
    await act(async () => {
      root.render(createElement(IconPicker, {
        captureAssetTarget,
        vaultScope,
        assetExists,
        onChoose,
        onReset: vi.fn(),
        onClose: vi.fn(),
      }));
    });

    const search = container.querySelector<HTMLInputElement>('[aria-label="Search icons"]');
    const listbox = container.querySelector<HTMLElement>('[role="listbox"]');
    const options = listbox?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    expect(options?.length).toBeGreaterThanOrEqual(300);
    expect(options?.[0]?.getAttribute("aria-label")).toBeTruthy();
    expect(options?.[0]?.getAttribute("aria-selected")).toBe("true");
    expect(options?.[0]?.tabIndex).toBe(0);
    await act(async () => {
      search?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(document.activeElement).toBe(options?.[1]);
    expect(options?.[1]?.getAttribute("aria-selected")).toBe("true");
    expect(options?.[1]?.tabIndex).toBe(0);
    await act(async () => {
      options?.[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ kind: "lucide" }));
  });

  it("does not choose the active icon when Enter is pressed on picker controls", async () => {
    const onChoose = vi.fn();
    const onReset = vi.fn();
    await act(async () => {
      root.render(createElement(IconPicker, {
        captureAssetTarget,
        vaultScope,
        assetExists,
        onChoose,
        onReset,
        onClose: vi.fn(),
      }));
    });

    const emojiTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent === "Emoji");
    const filesCategory = Array.from(container.querySelectorAll<HTMLButtonElement>(".icon-picker-categories button"))
      .find((button) => button.textContent === "Files");
    const reset = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Reset to default");
    await act(async () => {
      emojiTab?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      filesCategory?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      reset?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onChoose).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });

  it("labels emoji options and restores opener focus on Escape", async () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    opener.textContent = "Open picker";
    document.body.prepend(opener);
    opener.focus();
    await act(async () => {
      root.render(createElement(IconPicker, {
        captureAssetTarget,
        vaultScope,
        assetExists,
        onChoose: vi.fn(),
        onReset: vi.fn(),
        onClose,
      }));
    });

    const emojiTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent === "Emoji");
    await act(async () => {
      emojiTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const emojiOption = container.querySelector<HTMLButtonElement>('[role="option"]');
    expect(emojiOption?.getAttribute("aria-label")).toMatch(/^Emoji /);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);
  });

  it("offers a visible close control and restores opener focus when it is used", async () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    opener.textContent = "Open picker";
    document.body.prepend(opener);
    opener.focus();
    await act(async () => {
      root.render(createElement(IconPicker, {
        captureAssetTarget,
        vaultScope,
        assetExists,
        onChoose: vi.fn(),
        onReset: vi.fn(),
        onClose,
      }));
    });

    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close icon picker"]');
    expect(close).not.toBeNull();
    await act(async () => {
      close?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);
  });

  it("restores opener focus after successful keyboard choices and resets", async () => {
    const onChoose = vi.fn(() => true);
    const onReset = vi.fn(() => true);
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.prepend(opener);
    opener.focus();
    const renderPicker = async () => {
      await act(async () => {
        root.render(createElement(IconPicker, {
          captureAssetTarget,
          vaultScope,
          assetExists,
          onChoose,
          onReset,
          onClose,
        }));
      });
    };

    await renderPicker();
    const option = container.querySelector<HTMLButtonElement>('[role="option"]');
    option?.focus();
    await act(async () => {
      option?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(onChoose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);

    onClose.mockClear();
    opener.focus();
    await renderPicker();
    const reset = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Reset to default");
    reset?.focus();
    await act(async () => {
      reset?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onReset).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps the picker open when an asynchronous choice fails", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(createElement(IconPicker, {
        captureAssetTarget,
        vaultScope,
        assetExists,
        onChoose: async () => false,
        onReset: vi.fn(),
        onClose,
      }));
    });

    const option = container.querySelector<HTMLButtonElement>('[role="option"]');
    option?.focus();
    await act(async () => {
      option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(option);
  });

  it("uses an explicit return-focus target for close and Escape", async () => {
    const opener = document.createElement("button");
    const returnTarget = document.createElement("button");
    document.body.prepend(opener, returnTarget);
    opener.focus();
    const renderPicker = async () => {
      await act(async () => {
        root.render(createElement(IconPicker, {
          captureAssetTarget,
          vaultScope,
          assetExists,
          onChoose: vi.fn(),
          onReset: vi.fn(),
          onClose: vi.fn(),
          returnFocus: () => returnTarget,
        }));
      });
    };

    await renderPicker();
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close icon picker"]');
    await act(async () => {
      close?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(returnTarget);

    opener.focus();
    await renderPicker();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(returnTarget);
  });

  it("dismisses on an outside press but stays open for picker and opener interactions", async () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.prepend(opener);
    opener.focus();
    await act(async () => {
      root.render(createElement(IconPicker, {
        captureAssetTarget,
        vaultScope,
        assetExists,
        onChoose: vi.fn(),
        onReset: vi.fn(),
        onClose,
      }));
    });

    const search = container.querySelector<HTMLInputElement>('[aria-label="Search icons"]');
    await act(async () => {
      search?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      opener.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("dismisses from capture when an outside control stops propagation", async () => {
    const onClose = vi.fn();
    const outside = document.createElement("button");
    outside.addEventListener("pointerdown", (event) => event.stopPropagation());
    document.body.prepend(outside);
    await act(async () => {
      root.render(createElement(IconPicker, {
        captureAssetTarget,
        vaultScope,
        assetExists,
        onChoose: vi.fn(),
        onReset: vi.fn(),
        onClose,
      }));
    });

    await act(async () => {
      outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reuses an uploaded recent without changing its attachment reference", async () => {
    const path = "attachments/项目 50% #1?.png";
    localStorage.setItem(
      `noam:recent-icon-assets:v1:${encodeURIComponent(vaultScope)}`,
      JSON.stringify([`asset:${path}`]),
    );
    const onChoose = vi.fn();
    const resolveAsset = vi.fn((assetPath: string) => `/vault/${assetPath}`);
    await act(async () => {
      root.render(createElement(IconPicker, {
        captureAssetTarget,
        vaultScope,
        assetExists,
        onChoose,
        onReset: vi.fn(),
        onClose: vi.fn(),
        resolveAsset,
      }));
    });
    const upload = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Upload",
    );
    await act(async () => {
      upload?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const recent = container.querySelector<HTMLButtonElement>(`button[title="${path}"]`);
    expect(resolveAsset).toHaveBeenCalledWith(path, "path");
    await act(async () => {
      recent?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChoose).toHaveBeenCalledWith({ kind: "asset", path });
  });

  it("keeps uploaded recents inside their vault and removes missing files", async () => {
    const alphaPath = "attachments/alpha.png";
    const missingPath = "attachments/missing.png";
    const betaScope = "/vaults/beta";
    localStorage.setItem(
      `noam:recent-icon-assets:v1:${encodeURIComponent(vaultScope)}`,
      JSON.stringify([`asset:${alphaPath}`, `asset:${missingPath}`]),
    );
    localStorage.setItem(
      `noam:recent-icon-assets:v1:${encodeURIComponent(betaScope)}`,
      JSON.stringify(["asset:attachments/beta.png"]),
    );
    assetExists.mockImplementation(async (path) => path !== missingPath);

    await act(async () => {
      root.render(createElement(IconPicker, {
        captureAssetTarget,
        vaultScope,
        assetExists,
        onChoose: vi.fn(),
        onReset: vi.fn(),
        onClose: vi.fn(),
        resolveAsset: (path: string) => `/vault/${path}`,
      }));
    });
    const upload = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Upload",
    );
    await act(async () => {
      upload?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector(`button[title="${alphaPath}"]`)).not.toBeNull();
    expect(container.querySelector(`button[title="${missingPath}"]`)).toBeNull();
    expect(container.querySelector('button[title="attachments/beta.png"]')).toBeNull();
    expect(JSON.parse(localStorage.getItem(
      `noam:recent-icon-assets:v1:${encodeURIComponent(vaultScope)}`,
    ) ?? "[]")).toEqual([`asset:${alphaPath}`]);
  });

  it("does not apply or remember an uploaded recent after the vault changes", async () => {
    const path = "attachments/alpha.png";
    localStorage.setItem(
      `noam:recent-icon-assets:v1:${encodeURIComponent(vaultScope)}`,
      JSON.stringify([`asset:${path}`]),
    );
    const onChoose = vi.fn();
    const target = { vaultEpoch: 7, vaultScope, isCurrent: vi.fn(() => false) };
    await act(async () => {
      root.render(createElement(IconPicker, {
        captureAssetTarget: () => target,
        vaultScope,
        assetExists,
        onChoose,
        onReset: vi.fn(),
        onClose: vi.fn(),
        resolveAsset: (assetPath: string) => `/vault/${assetPath}`,
      }));
    });
    const upload = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Upload",
    );
    await act(async () => {
      upload?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    const recent = container.querySelector<HTMLButtonElement>(`button[title="${path}"]`);
    await act(async () => recent?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onChoose).not.toHaveBeenCalled();
  });
});
