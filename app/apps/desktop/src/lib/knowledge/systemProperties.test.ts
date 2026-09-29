import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listNoteTimes: vi.fn(),
  queryKnowledge: vi.fn(),
  recordServerCreatedTimes: vi.fn(),
}));

vi.mock("../ipc", () => mocks);

import {
  DEFAULT_CATALOG_PROPERTIES,
  KnowledgeError,
  SYSTEM_PROPERTY_IDS,
  editTokenForProperty,
  planKnowledgeChanges,
  withDefaultCatalogEntries,
  type EditToken,
  type KnowledgeCatalogV1,
} from ".";
import {
  createServerCreatedRecorder,
  getNoteTimes,
  isSystemPropertyId,
  queryNotes,
} from "./noteTimes";

const times = (noteId: string, path: string, created: number | null) => ({
  noteId,
  path,
  name: path.replace(/^.*\//, "").replace(/\.md$/, ""),
  created,
  createdSource: created === null ? null : "server",
  modified: 1_000,
});

beforeEach(() => {
  mocks.listNoteTimes.mockReset();
  mocks.queryKnowledge.mockReset();
  mocks.recordServerCreatedTimes.mockReset();
});

describe("system properties", () => {
  it("are reserved and read-only, even when a catalog reuses the id", () => {
    expect([...SYSTEM_PROPERTY_IDS]).toEqual(["created", "modified"]);
    expect(isSystemPropertyId("created")).toBe(true);
    expect(isSystemPropertyId("type")).toBe(false);
    const catalog: KnowledgeCatalogV1 = {
      version: 1,
      properties: [
        { id: "created", key: "created", name: "Created", type: { kind: "date", cardinality: "one" } },
      ],
      labels: [],
      relationships: [],
    };
    const markdown = "---\ncreated: 2026-01-05\n---\n";
    for (const change of [
      {
        kind: "setProperty" as const,
        propertyId: "created",
        value: { kind: "date" as const, value: "2026-02-01" },
        expected: editTokenForProperty(markdown, "created"),
      },
      { kind: "removeProperty" as const, propertyId: "modified", expected: "x" as EditToken },
    ]) {
      let code: string | undefined;
      try {
        planKnowledgeChanges(markdown, catalog, { docId: "doc-a", changes: [change] });
      } catch (error) {
        code = error instanceof KnowledgeError ? error.code : undefined;
      }
      expect(code).toBe("read_only");
    }
  });
});

describe("seeded catalog defaults", () => {
  it("supply type and people when the vault has no catalog note", () => {
    const effective = withDefaultCatalogEntries(null);
    expect(effective.properties).toEqual([
      { id: "type", key: "type", name: "Type", type: { kind: "label", cardinality: "one" } },
    ]);
    expect(effective.relationships).toEqual([
      { id: "people", name: "People", cardinality: "many", inverseName: "Appears in" },
    ]);
    expect(withDefaultCatalogEntries(null)).toBe(effective);
  });

  it("step aside wherever the catalog note defines the same id or key", () => {
    const catalog: KnowledgeCatalogV1 = {
      version: 1,
      properties: [
        { id: "kind", key: "type", name: "Kind", type: { kind: "text", cardinality: "one" } },
      ],
      labels: [],
      relationships: [{ id: "people", name: "Attendees", cardinality: "many" }],
    };
    const effective = withDefaultCatalogEntries(catalog);
    expect(effective.properties).toEqual(catalog.properties);
    expect(effective.relationships).toEqual(catalog.relationships);
    // Memoized per catalog object (a stable prop for React), and the input
    // catalog itself is never mutated.
    expect(withDefaultCatalogEntries(catalog)).toBe(effective);
    expect(catalog.properties).toHaveLength(1);
    expect(DEFAULT_CATALOG_PROPERTIES).toHaveLength(1);
  });

  it("add to a catalog that defines neither", () => {
    const catalog: KnowledgeCatalogV1 = {
      version: 1,
      properties: [
        { id: "status", key: "status", name: "Status", type: { kind: "text", cardinality: "one" } },
      ],
      labels: [],
      relationships: [{ id: "parent", name: "Parent", cardinality: "one" }],
    };
    const effective = withDefaultCatalogEntries(catalog);
    expect(effective.properties.map((property) => property.id)).toEqual(["status", "type"]);
    expect(effective.relationships.map((relationship) => relationship.id)).toEqual([
      "parent",
      "people",
    ]);
  });

  it("let a relationship change use the seeded people relationship", () => {
    const markdown = "# Meeting\n";
    const plan = planKnowledgeChanges(markdown, withDefaultCatalogEntries(null), {
      docId: "doc-meeting",
      changes: [{
        kind: "addRelationship",
        relationshipId: "people",
        targetDocId: "doc-paul",
        expected: editTokenForProperty(markdown, "noam_relationships"),
      }],
    });
    expect(plan.changedKeys.sort()).toEqual(["noam_document_id", "noam_relationships"]);
  });
});

describe("note times helpers", () => {
  it("index many notes' times by path and doc id from one read", async () => {
    mocks.listNoteTimes.mockResolvedValue([
      times("a", "A.md", 5),
      times("b", "Sub/B.md", null),
    ]);
    const index = await getNoteTimes({}, 3);
    expect(mocks.listNoteTimes).toHaveBeenCalledWith({}, 3);
    expect(index.byPath.get("Sub/B.md")?.noteId).toBe("b");
    expect(index.byDocId.get("a")?.created).toBe(5);
  });

  it("query sorted notes through the local knowledge index", async () => {
    mocks.queryKnowledge.mockResolvedValue({
      items: [{ kind: "noteEntry", ...times("a", "A.md", 5) }],
      nextCursor: "next",
      generation: 1,
    });
    const page = await queryNotes(
      { sort: { key: "created", direction: "desc" } },
      { limit: 10 },
    );
    expect(mocks.queryKnowledge).toHaveBeenCalledWith(
      { kind: "notes", where: [], sort: { key: "created", direction: "desc" } },
      { limit: 10 },
    );
    expect(page).toEqual({ items: [{ kind: "noteEntry", ...times("a", "A.md", 5) }], nextCursor: "next" });
  });

  it("records only changed server created times and swallows failures", async () => {
    const record = vi.fn().mockResolvedValue(1);
    const recorder = createServerCreatedRecorder(record);
    const notes = [
      { docId: "a", createdAt: "2026-01-01T00:00:00.000Z" },
      { docId: "b", createdAt: null },
    ];
    await recorder(notes, 7);
    expect(record).toHaveBeenCalledWith([{ docId: "a", createdAt: "2026-01-01T00:00:00.000Z" }], 7);
    await recorder(notes, 7);
    expect(record).toHaveBeenCalledTimes(1);

    const failing = vi.fn().mockRejectedValue(new Error("index busy"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const flaky = createServerCreatedRecorder(failing);
    await expect(flaky(notes, 7)).resolves.toBeUndefined();
    // Not remembered as sent, so the next pull retries it.
    await flaky(notes, 7);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
