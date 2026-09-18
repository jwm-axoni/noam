// Golden round-trip: a corpus of diverse markdown → Y.Text → serialize →
// byte-identical (spec 03 §6). Verified both directly and through the full
// bridge open() → egest path.

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { NoteBridge } from "../noteBridge";
import { CORPUS } from "./corpus";
import { makeHarness, sha256Hex } from "./helpers";

describe("golden round-trip", () => {
  it("seeds every corpus file into Y.Text and serializes byte-identically", () => {
    for (const [name, content] of Object.entries(CORPUS)) {
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, content);
      expect(text.toString(), `direct round-trip failed for ${name}`).toBe(content);
      doc.destroy();
    }
  });

  it("round-trips through bridge open (seed) → serialize", async () => {
    for (const [name, content] of Object.entries(CORPUS)) {
      const { io } = makeHarness({ [name]: content });
      const bridge = await NoteBridge.open(io, { docId: `doc-${name}`, path: name });
      expect(bridge.serialize(), `bridge seed round-trip failed for ${name}`).toBe(
        content,
      );
      bridge.destroy();
    }
  });

  it("egests the seeded content back to a byte-identical file", async () => {
    vi.useFakeTimers();
    try {
      for (const [name, content] of Object.entries(CORPUS)) {
        if (content.length === 0) continue; // empty seed makes no ops to egest
        const { io, fs } = makeHarness({ [name]: content });
        const bridge = await NoteBridge.open(io, {
          docId: `doc-${name}`,
          path: name,
        });
        // A no-op editor transaction won't change content; instead force a flush.
        bridge.edit((t) => {
          // Re-touch: delete+reinsert the last char to force an egest without
          // changing the serialized bytes.
          const s = t.toString();
          const last = s.slice(-1);
          t.delete(s.length - 1, 1);
          t.insert(s.length - 1, last);
        });
        await bridge.flushEgest();
        expect(fs.get(name), `egest round-trip failed for ${name}`).toBe(content);
        expect(sha256Hex(fs.get(name)!)).toBe(sha256Hex(content));
        bridge.destroy();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
