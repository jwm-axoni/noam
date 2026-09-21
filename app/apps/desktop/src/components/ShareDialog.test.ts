// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authManager } from "../lib/auth/authManager";
import { useStore } from "../store";
import { ShareDialog } from "./ShareDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const target = {
  resourceType: "file" as const,
  resourceId: "note-1",
  title: "Roadmap",
};

function ShareHarness() {
  const [open, setOpen] = useState(true);
  return open
    ? createElement(ShareDialog, { target, onClose: () => setOpen(false) })
    : null;
}

describe("ShareDialog focus containment", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalSession: ReturnType<typeof useStore.getState>["session"];
  let originalMembers: ReturnType<typeof useStore.getState>["members"];

  beforeEach(() => {
    document.body.replaceChildren();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    originalSession = useStore.getState().session;
    originalMembers = useStore.getState().members;
    useStore.setState({
      session: {
        user: { id: "owner", email: "owner@example.com", name: "Owner" },
        activeOrganizationId: "org-1",
      },
      members: [
        {
          id: "member-1",
          userId: "teammate",
          organizationId: "org-1",
          role: "member",
          user: {
            id: "teammate",
            email: "teammate@example.com",
            name: "Teammate",
          },
        },
      ],
    });
    vi.spyOn(authManager.api, "listShares").mockResolvedValue([]);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useStore.setState({ session: originalSession, members: originalMembers });
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  async function renderDialog(opener: HTMLButtonElement) {
    document.body.insertBefore(opener, container);
    opener.focus();
    await act(async () => {
      root.render(createElement(ShareHarness));
      await Promise.resolve();
    });
    return document.querySelector<HTMLElement>('[role="dialog"]');
  }

  it("labels the modal, contains Tab in both directions, and returns focus", async () => {
    const opener = document.createElement("button");
    const dialog = await renderDialog(opener);
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();

    const close = dialog?.querySelector<HTMLButtonElement>(
      'button[aria-label="Close share dialog"]',
    );
    const share = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent?.trim() === "Share");
    expect(document.activeElement).toBe(close);

    share?.focus();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(close);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(share);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      );
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("lets an inner menu consume Escape before closing the dialog", async () => {
    const opener = document.createElement("button");
    await renderDialog(opener);

    const menu = document.createElement("ul");
    menu.className = "context-menu";
    document.body.append(menu);
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") menu.remove();
    };
    window.addEventListener("keydown", closeMenu);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      );
    });
    window.removeEventListener("keydown", closeMenu);
    expect(menu.isConnected).toBe(false);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      );
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
