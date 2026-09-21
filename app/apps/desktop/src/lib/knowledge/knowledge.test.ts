import { describe, expect, it } from "vitest";
import {
  DOCUMENT_ID_KEY,
  KNOWLEDGE_SCHEMA_PATH,
  RELATIONSHIPS_KEY,
  KnowledgeError,
  applyKnowledgeChangePlan,
  decodeDocumentId,
  decodeRelationship,
  editTokenForProperty,
  encodeDocumentId,
  encodeRelationship,
  migrateLegacyTypes,
  parseKnowledgeSchema,
  planKnowledgeChanges,
  validateKnowledgeCatalog,
  type KnowledgeCatalogV1,
} from ".";

const catalog: KnowledgeCatalogV1 = {
  version: 1,
  properties: [
    { id: "status", key: "status", name: "Status", type: { kind: "text", cardinality: "one" } },
  ],
  labels: [],
  relationships: [
    { id: "parent", name: "Parent", cardinality: "one" },
    { id: "related", name: "Related", cardinality: "many" },
  ],
};

const schemaNote = `---
noam_kind: knowledge-schema
noam_knowledge_version: 1
---

\`\`\`json
${JSON.stringify(catalog, null, 2)}
\`\`\``;

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof KnowledgeError ? error.code : undefined;
  }
  return undefined;
}

describe("knowledge catalog", () => {
  it("accepts the canonical path, frontmatter, and single JSON catalog", () => {
    expect(parseKnowledgeSchema(KNOWLEDGE_SCHEMA_PATH, schemaNote)).toEqual({
      ok: true,
      catalog,
    });
  });

  it("rejects lookalike paths and prose outside the JSON fence", () => {
    expect(parseKnowledgeSchema("Knowledge schema.md", schemaNote)).toMatchObject({ ok: false });
    expect(parseKnowledgeSchema(KNOWLEDGE_SCHEMA_PATH, `${schemaNote}\nextra`)).toMatchObject({
      ok: false,
    });
  });

  it.each([
    ["property id", { ...catalog, properties: [{ ...catalog.properties[0], id: " status " }] }],
    ["property key", { ...catalog, properties: [{ ...catalog.properties[0], key: " status " }] }],
    ["property name", { ...catalog, properties: [{ ...catalog.properties[0], name: " Status " }] }],
    ["property type", { ...catalog, properties: [{ ...catalog.properties[0], type: { ...catalog.properties[0]!.type, kind: " text " } }] }],
    ["label id", { ...catalog, labels: [{ id: " active ", name: "Active" }] }],
    ["label name", { ...catalog, labels: [{ id: "active", name: " Active " }] }],
    ["label color", { ...catalog, labels: [{ id: "active", name: "Active", color: " blue " }] }],
    ["relationship id", { ...catalog, relationships: [{ ...catalog.relationships[0], id: " parent " }] }],
    ["relationship name", { ...catalog, relationships: [{ ...catalog.relationships[0], name: " Parent " }] }],
    ["relationship inverse name", { ...catalog, relationships: [{ ...catalog.relationships[0], inverseName: " Child " }] }],
  ])("rejects surrounding whitespace in %s", (_field, value) => {
    expect(validateKnowledgeCatalog(value)).toMatchObject({ ok: false });
  });
});

describe("portable identity encoding", () => {
  it("round-trips document ids and flat relationship entries", () => {
    expect(decodeDocumentId(encodeDocumentId("01J-note_A"))).toBe("01J-note_A");
    const raw = encodeRelationship({ relationshipId: "related", targetDocId: "01J-target" });
    expect(raw).toBe("related:01J-target");
    expect(decodeRelationship(raw)).toEqual({
      relationshipId: "related",
      targetDocId: "01J-target",
    });
  });

  it("rejects delimiters inside either id", () => {
    expect(() => encodeDocumentId("bad:id")).toThrow("Invalid document id");
    expect(decodeRelationship("related:bad:id")).toBeNull();
  });

  it("uses collision-free field state tokens and distinguishes absence", () => {
    const absent = editTokenForProperty("Body only", "status");
    const empty = editTokenForProperty("---\nstatus:\n---\nBody", "status");
    const unicode = editTokenForProperty("---\nstatus: café ☕\n---\nBody", "status");
    expect(new Set([absent, empty, unicode])).toHaveLength(3);
  });
});

describe("legacy type migration", () => {
  it("imports only explicit choices without mutating the input catalog", () => {
    const existing: KnowledgeCatalogV1 = {
      ...catalog,
      properties: [...catalog.properties],
    };
    const before = structuredClone(existing);
    const result = migrateLegacyTypes(
      JSON.stringify({
        version: 1,
        types: { status: "text", topics: "tags", score: "number", inferred: null },
      }),
      existing,
    );

    expect(existing).toEqual(before);
    expect(result.importedKeys).toEqual(["topics", "score"]);
    expect(result.skippedKeys).toEqual([
      { key: "status", reason: "already-defined" },
      { key: "inferred", reason: "invalid-type" },
    ]);
    expect(result.catalog.properties[result.catalog.properties.length - 2]?.type).toEqual({
      kind: "tag",
      cardinality: "many",
    });
  });

  it("does not import reserved storage fields", () => {
    const result = migrateLegacyTypes(
      JSON.stringify({ version: 1, types: { [DOCUMENT_ID_KEY]: "text" } }),
    );
    expect(result.importedKeys).toEqual([]);
    expect(result.skippedKeys).toEqual([{ key: DOCUMENT_ID_KEY, reason: "invalid-key" }]);
  });
});

describe("minimal-span change planning", () => {
  it("updates only the property value and ignores unrelated body edits", () => {
    const first = "---\n# keep\nstatus: draft # keep too\n---\nBody one.";
    const expected = editTokenForProperty(first, "status");
    const current = first.replace("Body one.", "Body two.");
    const plan = planKnowledgeChanges(current, catalog, {
      docId: "doc-1",
      changes: [{ kind: "setProperty", propertyId: "status", value: { kind: "text", value: "done" }, expected }],
    });
    expect(applyKnowledgeChangePlan(current, plan)).toBe(
      current.replace("status: draft", "status: done"),
    );
    expect(plan.changes).toHaveLength(1);
  });

  it("rejects stale same-field edits and unsupported YAML without changing text", () => {
    const inspected = "---\nstatus: draft\n---\nBody.";
    const expected = editTokenForProperty(inspected, "status");
    expect(
      errorCode(() =>
        planKnowledgeChanges(inspected.replace("draft", "done"), catalog, {
          docId: "doc-1",
          changes: [{ kind: "removeProperty", propertyId: "status", expected }],
        }),
      ),
    ).toBe("stale_edit");

    const unsupported = "---\nnested:\n  key: value\n---\nBody.";
    expect(errorCode(() => editTokenForProperty(unsupported, "status"))).toBe(
      "unsupported_frontmatter",
    );
  });

  it("adds identity and one outgoing relationship in one non-overlapping plan", () => {
    const source = "---\nstatus: draft\n---\nBody.";
    const expected = editTokenForProperty(source, RELATIONSHIPS_KEY);
    const plan = planKnowledgeChanges(source, catalog, {
      docId: "doc-1",
      changes: [
        { kind: "addRelationship", relationshipId: "related", targetDocId: "doc-2", expected },
      ],
    });
    const result = applyKnowledgeChangePlan(source, plan);
    expect(result).toBe(
      '---\nstatus: draft\nnoam_document_id: doc-1\nnoam_relationships: ["related:doc-2"]\n---\nBody.',
    );
    expect(plan.changes).toHaveLength(1);
  });

  it("keeps deletion and insertion spans disjoint when the last field is removed", () => {
    const source = "---\nstatus: draft\n---\nBody.";
    const plan = planKnowledgeChanges(source, catalog, {
      docId: "doc-1",
      changes: [
        { kind: "removeProperty", propertyId: "status", expected: editTokenForProperty(source, "status") },
        {
          kind: "addRelationship",
          relationshipId: "related",
          targetDocId: "doc-2",
          expected: editTokenForProperty(source, RELATIONSHIPS_KEY),
        },
      ],
    });
    const [left, right] = [...plan.changes].sort((a, b) => a.from - b.from);
    expect(left!.to).toBeLessThanOrEqual(right!.from);
    expect(applyKnowledgeChangePlan(source, plan)).toContain(
      'noam_relationships: ["related:doc-2"]',
    );
  });

  it("rejects label and tag IDs outside each property's allowed set", () => {
    const restricted: KnowledgeCatalogV1 = {
      version: 1,
      properties: [
        {
          id: "status",
          key: "status",
          name: "Status",
          type: { kind: "label", cardinality: "one" },
          allowedLabelIds: ["active"],
        },
        {
          id: "topics",
          key: "topics",
          name: "Topics",
          type: { kind: "tag", cardinality: "many" },
          allowedLabelIds: ["active"],
        },
      ],
      labels: [
        { id: "active", name: "Active" },
        { id: "paused", name: "Paused" },
      ],
      relationships: [],
    };
    const source = "---\nstatus: active\ntopics: [active]\n---\nBody.";

    expect(errorCode(() => planKnowledgeChanges(source, restricted, {
      docId: "doc-1",
      changes: [{
        kind: "setProperty",
        propertyId: "status",
        value: { kind: "text", value: "paused" },
        expected: editTokenForProperty(source, "status"),
      }],
    }))).toBe("schema_invalid");
    expect(errorCode(() => planKnowledgeChanges(source, restricted, {
      docId: "doc-1",
      changes: [{
        kind: "setProperty",
        propertyId: "topics",
        value: { kind: "list", value: ["active", "paused"] },
        expected: editTokenForProperty(source, "topics"),
      }],
    }))).toBe("schema_invalid");

    const accepted = planKnowledgeChanges(source, restricted, {
      docId: "doc-1",
      changes: [{
        kind: "setProperty",
        propertyId: "topics",
        value: { kind: "list", value: ["active"] },
        expected: editTokenForProperty(source, "topics"),
      }],
    });
    expect(accepted.changedKeys).toEqual([]);
    expect(applyKnowledgeChangePlan(source, accepted)).toBe(source);
  });
});
