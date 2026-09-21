import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pickVault: vi.fn(),
  adoptOpenedVault: vi.fn(),
}));

vi.mock("../../ipc", () => ({ pickVault: mocks.pickVault }));
vi.mock("../../../store", () => ({
  useStore: { getState: () => ({ adoptOpenedVault: mocks.adoptOpenedVault }) },
}));

import { openExistingVault } from "../openExisting";

describe("openExistingVault", () => {
  beforeEach(() => vi.clearAllMocks());

  it("leaves state alone when the native picker is cancelled", async () => {
    mocks.pickVault.mockResolvedValue(null);

    await expect(openExistingVault()).resolves.toBe(false);
    expect(mocks.adoptOpenedVault).not.toHaveBeenCalled();
  });

  it("adopts the picked folder without asking the store to seed it", async () => {
    const vault = { path: "/vaults/existing", name: "existing", epoch: 7 };
    mocks.pickVault.mockResolvedValue(vault);

    await expect(openExistingVault()).resolves.toBe(true);
    expect(mocks.adoptOpenedVault).toHaveBeenCalledOnce();
    expect(mocks.adoptOpenedVault).toHaveBeenCalledWith(vault);
  });

  it("lets picker and open failures reach the calling surface", async () => {
    mocks.pickVault.mockRejectedValue(new Error("folder is unreadable"));

    await expect(openExistingVault()).rejects.toThrow("folder is unreadable");
    expect(mocks.adoptOpenedVault).not.toHaveBeenCalled();
  });
});
