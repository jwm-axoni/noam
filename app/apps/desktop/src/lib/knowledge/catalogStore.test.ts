import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readNote: vi.fn() }));

vi.mock("../ipc", () => ({ readNote: mocks.readNote }));

import {
  getKnowledgeCatalogSnapshot,
  labelPresentation,
  loadKnowledgeCatalog,
  reloadKnowledgeCatalog,
  propertyDefinitionForKey,
  resetKnowledgeCatalog,
} from "./catalogStore";

const schema = (name: string, color: string) => `---
noam_kind: knowledge-schema
noam_knowledge_version: 1
---

\`\`\`json
${JSON.stringify({
  version: 1,
  properties: [
    { id: "status", key: "status", name: "Status", type: { kind: "label", cardinality: "one" } },
  ],
  labels: [{ id: "active", name, color }],
  relationships: [],
})}
\`\`\``;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("portable knowledge catalog store", () => {
  beforeEach(() => {
    resetKnowledgeCatalog();
    mocks.readNote.mockReset();
  });

  it("loads shared property types and label presentation from the schema note", async () => {
    mocks.readNote.mockResolvedValue(schema("Active", "#16a34a"));
    await loadKnowledgeCatalog(7);

    expect(propertyDefinitionForKey("status")?.type.kind).toBe("label");
    expect(labelPresentation("active")).toEqual({ label: "Active", color: "#16a34a" });
    expect(labelPresentation("ACTIVE")).toEqual({ label: "ACTIVE" });
    expect(getKnowledgeCatalogSnapshot()).toMatchObject({ loaded: true, epoch: 7, error: null });
  });

  it("does not let a slower previous vault replace the current catalog", async () => {
    const oldVault = deferred<string>();
    const currentVault = deferred<string>();
    mocks.readNote
      .mockReturnValueOnce(oldVault.promise)
      .mockReturnValueOnce(currentVault.promise);

    const oldLoad = loadKnowledgeCatalog(1);
    const currentLoad = loadKnowledgeCatalog(2);
    currentVault.resolve(schema("Current", "blue"));
    await currentLoad;
    oldVault.resolve(schema("Old", "red"));
    await oldLoad;

    expect(getKnowledgeCatalogSnapshot().epoch).toBe(2);
    expect(labelPresentation("active")).toEqual({ label: "Current", color: "blue" });
  });

  it("reloads a changed schema within the same vault", async () => {
    mocks.readNote
      .mockResolvedValueOnce(schema("Active", "green"))
      .mockResolvedValueOnce(schema("Current", "blue"));

    await loadKnowledgeCatalog(7);
    await reloadKnowledgeCatalog(7);

    expect(mocks.readNote).toHaveBeenCalledTimes(2);
    expect(labelPresentation("active")).toEqual({ label: "Current", color: "blue" });
  });

  it("queues a forced reload behind an in-flight load", async () => {
    const initial = deferred<string>();
    mocks.readNote
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce(schema("Current", "blue"));

    const first = loadKnowledgeCatalog(7);
    const reload = reloadKnowledgeCatalog(7);
    initial.resolve(schema("Stale", "red"));
    await Promise.all([first, reload]);

    expect(mocks.readNote).toHaveBeenCalledTimes(2);
    expect(labelPresentation("active")).toEqual({ label: "Current", color: "blue" });
  });

  it("drops a queued reload after another vault starts loading", async () => {
    const oldVault = deferred<string>();
    const newVault = deferred<string>();
    mocks.readNote
      .mockReturnValueOnce(oldVault.promise)
      .mockReturnValueOnce(newVault.promise);

    const oldLoad = loadKnowledgeCatalog(7);
    const queuedReload = reloadKnowledgeCatalog(7);
    const newLoad = loadKnowledgeCatalog(8);
    oldVault.resolve(schema("Old", "red"));
    newVault.resolve(schema("Current", "blue"));
    await Promise.all([oldLoad, queuedReload, newLoad]);

    expect(mocks.readNote).toHaveBeenCalledTimes(2);
    expect(getKnowledgeCatalogSnapshot().epoch).toBe(8);
    expect(labelPresentation("active")).toEqual({ label: "Current", color: "blue" });
  });
});
