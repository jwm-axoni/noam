// AI whole-file rewrite: a coarse external rewrite of the entire file while a
// concurrent local edit exists must converge without exception AND leave a
// recovery snapshot behind (spec 02 §6, spec 03 §6).

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { NoteBridge } from "../noteBridge";
import { makeHarness } from "./helpers";

const PATH = "note.md";
const SEED =
  "# Project Plan\n\n- research\n- prototype\n- ship\n\nNotes: keep it small.\n";

describe("AI whole-file rewrite", () => {
  it("converges and leaves a recoverable pre-diff snapshot", async () => {
    vi.useFakeTimers();
    try {
      const { io, fs, persistence } = makeHarness({ [PATH]: SEED });
      const bridge = await NoteBridge.open(io, { docId: "doc-1", path: PATH });

      // A concurrent local edit exists in the CRDT (and is flushed to disk).
      bridge.edit((t) => t.insert(t.toString().length, "\n- extra local task\n"));
      await vi.advanceTimersByTimeAsync(300);
      const preRewriteText = bridge.serialize();

      // An AI rewrites the ENTIRE file with completely different content.
      const rewrite =
        "# Completely New Document\n\nThis body shares almost nothing with the original.\n\n" +
        "It replaces every section wholesale, as a coarse AI edit would.\n";
      fs.externalWrite(PATH, rewrite);

      // Ingest must not throw and must take a recovery snapshot for the big diff.
      expect(() => {
        bridge.ingest();
      }).not.toThrow();
      await vi.advanceTimersByTimeAsync(150);

      // Converged onto the rewrite (merged as ops, no exception).
      expect(bridge.hasRecoverySnapshot).toBe(true);
      expect(bridge.serialize()).toBe(rewrite);

      // A recovery snapshot exists and decodes to the PRE-rewrite content.
      const history = persistence.snapshotHistory.get("doc-1");
      expect(history && history.length).toBeGreaterThan(0);
      const recovered = new Y.Doc();
      Y.applyUpdate(recovered, history![history!.length - 1]);
      expect(recovered.getText("content").toString()).toBe(preRewriteText);
      recovered.destroy();

      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not snapshot for a small localized edit", async () => {
    vi.useFakeTimers();
    try {
      const { io, fs } = makeHarness({ [PATH]: SEED });
      const bridge = await NoteBridge.open(io, { docId: "doc-2", path: PATH });

      // Tiny external change (one word) — well under the large-diff threshold.
      fs.externalWrite(PATH, SEED.replace("ship", "launch"));
      bridge.ingest();
      await vi.advanceTimersByTimeAsync(150);

      expect(bridge.hasRecoverySnapshot).toBe(false);
      expect(bridge.serialize()).toContain("launch");
      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
