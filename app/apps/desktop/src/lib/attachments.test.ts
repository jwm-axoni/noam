import { afterEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import { saveAttachment } from "./attachments";

vi.mock("./ipc", () => ({ writeBinaryFile: vi.fn() }));

describe("attachment persistence", () => {
  afterEach(() => vi.clearAllMocks());

  it("passes the caller's vault epoch to the binary write", async () => {
    const bytes = Uint8Array.of(1, 2, 3);

    await saveAttachment(bytes, "png", 19);

    expect(ipc.writeBinaryFile).toHaveBeenCalledWith(
      expect.stringMatching(/^attachments\/[0-9a-f]{16}\.png$/),
      bytes,
      19,
    );
  });
});
