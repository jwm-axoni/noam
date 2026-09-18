// Concurrent edit: a local editor edit and an external file edit to a DIFFERENT
// part of the note both survive in the converged text; file and CRDT end equal
// (spec 03 §6).

import { describe, expect, it, vi } from "vitest";
import { NoteBridge } from "../noteBridge";
import { makeHarness } from "./helpers";

const PATH = "note.md";
const SEED = "# Heading\n\nfirst paragraph\n\nsecond paragraph\n\nthird paragraph\n";

describe("concurrent edit", () => {
  it("merges a local edit (top) and an external edit (bottom)", async () => {
    vi.useFakeTimers();
    try {
      const { io, fs } = makeHarness({ [PATH]: SEED });
      const bridge = await NoteBridge.open(io, { docId: "doc-1", path: PATH });

      // Local editor edit near the TOP (change the heading).
      bridge.edit((t) => {
        const i = t.toString().indexOf("Heading");
        t.delete(i, "Heading".length);
        t.insert(i, "Edited Heading");
      });

      // Flush egest so the file on disk carries the local edit (an external
      // tool then reads THAT file and edits a different region — spec's
      // "different part" model).
      await vi.advanceTimersByTimeAsync(300);
      expect(fs.get(PATH)).toBe(bridge.serialize());

      // External edit near the BOTTOM of the on-disk file.
      const onDisk = fs.get(PATH)!;
      const external = onDisk.replace(
        "third paragraph",
        "third paragraph (external addition)",
      );
      fs.externalWrite(PATH, external);

      // Ingest merges the external change as ops.
      bridge.ingest();
      await vi.advanceTimersByTimeAsync(150);

      const converged = bridge.serialize();
      // Both edits survived.
      expect(converged).toContain("Edited Heading");
      expect(converged).toContain("third paragraph (external addition)");
      // CRDT equals the file (the external write is now reflected in the CRDT).
      expect(converged).toBe(external);

      // No spurious write-back: the ingest applied a 'disk'-origin change, which
      // must not trigger an egest. Let timers settle and confirm equality holds.
      await vi.advanceTimersByTimeAsync(500);
      expect(bridge.serialize()).toBe(fs.get(PATH));

      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("converges when both sides edit truly different lines", async () => {
    vi.useFakeTimers();
    try {
      const seed = "alpha\nbravo\ncharlie\ndelta\n";
      const { io, fs } = makeHarness({ [PATH]: seed });
      const bridge = await NoteBridge.open(io, { docId: "doc-2", path: PATH });

      // Local: change "alpha" → "ALPHA".
      bridge.edit((t) => {
        t.delete(0, 5);
        t.insert(0, "ALPHA");
      });
      await vi.advanceTimersByTimeAsync(300);

      // External: change "delta" → "DELTA" on the flushed file.
      fs.externalWrite(PATH, fs.get(PATH)!.replace("delta", "DELTA"));
      bridge.ingest();
      await vi.advanceTimersByTimeAsync(150);

      expect(bridge.serialize()).toBe("ALPHA\nbravo\ncharlie\nDELTA\n");
      expect(bridge.serialize()).toBe(fs.get(PATH));
      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
