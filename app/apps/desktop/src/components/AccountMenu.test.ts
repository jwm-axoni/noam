// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openExistingVault: vi.fn(),
  peekVaultStamp: vi.fn(),
  state: {} as Record<string, unknown>,
}));

vi.mock("../lib/vault/openExisting", () => ({
  openExistingVault: mocks.openExistingVault,
}));

vi.mock("../lib/ipc", () => ({
  peekVaultStamp: mocks.peekVaultStamp,
}));

vi.mock("../store", () => {
  const useStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  );
  return { useStore, readOrgVaults: () => ({}) };
});

vi.mock("../lib/auth/authManager", () => ({ authManager: { api: {} } }));
vi.mock("./useVaultLists", () => ({
  useLocalVaults: () => [],
  useRecentVaults: () => [],
}));
vi.mock("./ViewportMenu", () => ({
  ViewportMenu: ({ children, className }: { children: ReactNode; className: string }) =>
    createElement("div", { className }, children),
}));
vi.mock("./Face", () => ({
  LazyAvatar: ({ label }: { label: string }) => createElement("span", null, label),
}));

import { AccountMenu } from "./AccountMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const signedOutState = () => ({
  authStatus: "signed-out",
  session: null,
  authPrompt: null,
  organizations: [],
  userInvitations: [],
  syncStatus: "offline",
  syncEnabled: false,
  activityStatus: "online",
  vault: { path: "/vaults/current", name: "Current", epoch: 1 },
});

const signedInState = () => ({
  ...signedOutState(),
  authStatus: "signed-in",
  session: {
    activeOrganizationId: null,
    user: { id: "user-1", name: "Ada", email: "ada@example.com", image: null },
  },
  members: [],
  pendingInvitations: [],
});

describe("AccountMenu vault actions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.state = signedOutState();
    mocks.openExistingVault.mockResolvedValue(false);
    mocks.peekVaultStamp.mockResolvedValue(null);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  async function renderMenu(state: Record<string, unknown>) {
    mocks.state = state;
    await act(async () => {
      root.render(createElement(AccountMenu));
      await Promise.resolve();
    });
    await act(async () => {
      (container.querySelector(".identity-bar") as HTMLButtonElement).click();
    });
  }

  function action(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.querySelector(".menu-item-label")?.textContent === label,
    );
    if (!button) throw new Error(`Missing action: ${label}`);
    return button;
  }

  it.each([
    ["signed out", signedOutState],
    ["signed in", signedInState],
  ])("renders New vault and Open folder when %s", async (_label, state) => {
    await renderMenu(state());

    expect(action("New vault")).toBeTruthy();
    expect(action("Open folder…")).toBeTruthy();
  });

  it("closes the menu when the native picker is cancelled", async () => {
    await renderMenu(signedOutState());

    await act(async () => {
      action("Open folder…").click();
      await Promise.resolve();
    });

    expect(mocks.openExistingVault).toHaveBeenCalledOnce();
    expect(container.querySelector(".account-popover")).toBeNull();
  });

  it("reopens the menu with its inline error when opening fails", async () => {
    mocks.openExistingVault.mockRejectedValueOnce(new Error("folder is unreadable"));
    await renderMenu(signedOutState());

    await act(async () => {
      action("Open folder…").click();
      await Promise.resolve();
    });

    expect(container.querySelector(".auth-error")?.textContent).toBe("folder is unreadable");
  });
});
