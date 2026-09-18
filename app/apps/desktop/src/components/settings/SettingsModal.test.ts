// @vitest-environment jsdom
import { act, createElement, Fragment, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfirmDialog } from "../ConfirmDialog";
import { SettingsModal } from "../SettingsModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function SettingsHarness() {
  const [open, setOpen] = useState(true);
  const [confirming, setConfirming] = useState(false);
  return createElement(
    Fragment,
    null,
    open &&
      createElement(
        SettingsModal,
        {
          label: "Settings test",
          onClose: () => setOpen(false),
          children: createElement(
            Fragment,
            null,
            createElement(
              "button",
              { type: "button", onClick: () => setConfirming(true) },
              "Open confirmation",
            ),
            confirming &&
              createElement(
                ConfirmDialog,
                {
                  title: "Confirm action",
                  confirmLabel: "Confirm",
                  onCancel: () => setConfirming(false),
                  onConfirm: () => undefined,
                  children: createElement("p", null, "Confirm this action."),
                },
              ),
          ),
        },
      ),
  );
}

describe("SettingsModal nesting", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.replaceChildren();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it("gives a nested dialog Escape precedence, then closes settings", async () => {
    const opener = document.createElement("button");
    opener.dataset.settingsReturnFocus = "";
    document.body.append(opener);
    opener.focus();

    await act(async () => root.render(createElement(SettingsHarness)));
    const launch = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Open confirmation",
    );
    expect(launch).toBeDefined();

    await act(async () => {
      launch?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector(".confirm-dialog")).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector(".confirm-dialog")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
