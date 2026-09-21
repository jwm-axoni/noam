// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRecentVaults: vi.fn(),
  getVaultsRoot: vi.fn(),
  peekVaultStamp: vi.fn(),
  requestJoinWithCode: vi.fn(),
  knownVaults: [] as { id: string; name: string }[],
  orgVaults: {} as Record<string, string>,
  lastVault: null as string | null,
  state: {
    authStatus: "signed-out",
    session: null,
    authPrompt: null,
    organizations: [],
    serverUrl: "http://localhost:3010",
    landingVault: null,
  } as Record<string, unknown>,
}));

vi.mock("../lib/ipc", () => ({
  getRecentVaults: mocks.getRecentVaults,
  getVaultsRoot: mocks.getVaultsRoot,
  peekVaultStamp: mocks.peekVaultStamp,
}));

vi.mock("../store", () => {
  const useStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  );
  return {
    useStore,
    readKnownVaults: () => mocks.knownVaults,
    readLastVault: () => mocks.lastVault,
    readOrgVaults: () => mocks.orgVaults,
    requestJoinWithCode: mocks.requestJoinWithCode,
    requestOpenVault: vi.fn(),
  };
});

vi.mock("motion/react", async () => {
  const React = await import("react");
  const components = new Map<PropertyKey, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!components.has(tag)) {
          components.set(
            tag,
            React.forwardRef<HTMLElement, Record<string, unknown>>(function MotionElement(
              {
                children,
                initial: _initial,
                animate: _animate,
                exit: _exit,
                transition: _transition,
                variants: _variants,
                whileHover: _whileHover,
                whileTap: _whileTap,
                ...props
              },
              ref,
            ) {
              return React.createElement(tag, { ...props, ref }, children as React.ReactNode);
            }),
          );
        }
        return components.get(tag);
      },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useReducedMotion: () => true,
  };
});

import { VaultPicker, welcomeGreeting } from "./VaultPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("VaultPicker", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.state.authStatus = "signed-out";
    mocks.state.session = null;
    mocks.state.authPrompt = null;
    mocks.state.organizations = [];
    mocks.state.landingVault = null;
    mocks.knownVaults = [];
    mocks.orgVaults = {};
    mocks.lastVault = null;
    mocks.getRecentVaults.mockResolvedValue([]);
    mocks.getVaultsRoot.mockResolvedValue("/vaults/Documents/Noam Vaults");
    mocks.peekVaultStamp.mockResolvedValue(null);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    localStorage.clear();
    vi.clearAllMocks();
  });

  async function renderPicker() {
    await act(async () => {
      root.render(createElement(VaultPicker));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("renders Direction D's first-run shell without the old splash", async () => {
    await renderPicker();

    expect(container.querySelector(".welcome-sidebar")).not.toBeNull();
    expect(container.querySelector(".welcome-document h1")?.textContent).toBe("Welcome to Noam.");
    expect(container.querySelector(".welcome-vault-empty")?.textContent).toContain("No vaults yet");
    expect(container.querySelectorAll(".welcome-action-card")).toHaveLength(3);
    expect(container.textContent).toContain("Choose folder");
    expect(container.querySelector(".welcome-document")?.classList.contains("is-centered")).toBe(
      true,
    );
    expect(container.textContent).not.toContain("Sync and collaborate");
    expect(container.textContent).not.toContain("~/Noam");
  });

  it("shows the configured vault root only after resolving it", async () => {
    mocks.getVaultsRoot.mockResolvedValue("/Volumes/Team Notes/Managed Vaults");
    await renderPicker();

    expect(container.textContent).not.toContain("/Volumes/Team Notes/Managed Vaults");

    const createButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Create",
    );
    expect(createButton).toBeDefined();

    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.getVaultsRoot).toHaveBeenCalledOnce();
    expect(container.querySelector(".new-vault-loc")?.textContent).toBe(
      "in /Volumes/Team Notes/Managed Vaults",
    );
    expect(container.querySelector(".new-vault-loc")?.getAttribute("title")).toBe(
      "/Volumes/Team Notes/Managed Vaults",
    );
  });

  it("keeps sign-in disabled while the keychain session is unknown", async () => {
    mocks.state.authStatus = "unknown";
    await renderPicker();

    expect(container.querySelector(".welcome-identity-name")?.textContent).toBe(
      "Checking account…",
    );
    expect((container.querySelector(".welcome-signin") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows every recent vault in the scrolling column and a continue card", async () => {
    mocks.getRecentVaults.mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => ({
        name: `Vault ${index + 1}`,
        path: `/vaults/Vault ${index + 1}`,
        openedAt: Date.now() - index * 60_000,
      })),
    );
    await renderPicker();

    expect(container.querySelectorAll(".welcome-vault-row")).toHaveLength(5);
    expect(container.querySelector(".welcome-continue-name")?.textContent).toContain("Vault 1");
    expect(container.querySelector(".welcome-vault-name")?.getAttribute("title")).toBe(
      "Vault 1",
    );
    expect(container.textContent).not.toContain("Show all");
  });

  it("centers the post-sign-in landing state", async () => {
    mocks.state.landingVault = true;

    await renderPicker();

    expect(container.querySelector(".welcome-document")?.classList.contains("is-centered")).toBe(
      true,
    );
    expect(container.textContent).toContain("Opening your vault…");
  });

  it("continues the newest local vault instead of the first synced vault", async () => {
    mocks.state.authStatus = "signed-in";
    mocks.state.session = {
      user: { name: "Ada", email: "ada@example.com", image: null },
      activeOrganizationId: "org-synced",
    };
    mocks.state.organizations = [{ id: "org-synced", name: "Synced vault" }];
    mocks.orgVaults = { "org-synced": "/vaults/Synced vault" };
    mocks.lastVault = "org-synced";
    mocks.getRecentVaults.mockResolvedValue([
      { name: "Local latest", path: "/vaults/Local latest", openedAt: 200 },
      { name: "Synced vault", path: "/vaults/Synced vault", openedAt: 100 },
    ]);

    await renderPicker();

    expect(container.querySelector(".welcome-continue-name")?.textContent).toContain(
      "Local latest",
    );
  });
});

describe("welcomeGreeting", () => {
  it("uses the local time of day", () => {
    expect(welcomeGreeting(8)).toBe("Good morning.");
    expect(welcomeGreeting(14)).toBe("Good afternoon.");
    expect(welcomeGreeting(20)).toBe("Good evening.");
  });
});
