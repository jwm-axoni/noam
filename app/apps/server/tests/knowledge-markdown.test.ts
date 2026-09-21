import { describe, expect, it } from "vitest";
import { parseKnowledgeCatalog, parseKnowledgeMarkdown } from "../src/knowledge/markdown.js";

const catalogNote = `---
noam_kind: knowledge-schema
noam_knowledge_version: 1
---

\`\`\`json
${JSON.stringify({
  version: 1,
  properties: [
    { id: "workflow", key: "project_status", name: "Status", type: { kind: "label", cardinality: "one" } },
    { id: "topics", key: "topic_names", name: "Topics", type: { kind: "tag", cardinality: "many" } },
    { id: "score", key: "rating", name: "Rating", type: { kind: "number", cardinality: "one" } },
  ],
  labels: [
    { id: "in_progress", name: "In progress", color: "blue" },
    { id: "planning", name: "Planning" },
  ],
  relationships: [{ id: "depends-on", name: "Depends on", cardinality: "many" }],
})}
\`\`\``;

describe("knowledge Markdown projection", () => {
  it.each([
    ["property id", (value: any) => { value.properties[0].id = " workflow "; }],
    ["property key", (value: any) => { value.properties[0].key = " project_status "; }],
    ["property name", (value: any) => { value.properties[0].name = " Status "; }],
    ["property type", (value: any) => { value.properties[0].type.kind = " label "; }],
    ["label id", (value: any) => { value.labels[0].id = " in_progress "; }],
    ["label name", (value: any) => { value.labels[0].name = " In progress "; }],
    ["label color", (value: any) => { value.labels[0].color = " blue "; }],
    ["relationship id", (value: any) => { value.relationships[0].id = " depends-on "; }],
    ["relationship name", (value: any) => { value.relationships[0].name = " Depends on "; }],
    ["relationship inverse name", (value: any) => { value.relationships[0].inverseName = " Required by "; }],
  ])("rejects surrounding whitespace in catalog %s", (_field, mutate) => {
    const match = /```json\n([\s\S]*?)\n```/.exec(catalogNote);
    const value = JSON.parse(match![1]!);
    mutate(value);
    expect(parseKnowledgeCatalog(catalogNote.replace(match![1]!, JSON.stringify(value)))).toBeNull();
  });

  it("keeps quoted typed-looking values as text", () => {
    const projection = parseKnowledgeMarkdown(`---
literal_boolean: "false"
literal_number: '12'
literal_date: "2026-09-19"
actual_boolean: false
actual_number: 12
actual_date: 2026-09-19
---`);

    expect(
      projection.properties.map(({ propertyId, type, text }) => ({ propertyId, type, text })),
    ).toEqual([
      { propertyId: "literal_boolean", type: "text", text: "false" },
      { propertyId: "literal_number", type: "text", text: "12" },
      { propertyId: "literal_date", type: "text", text: "2026-09-19" },
      { propertyId: "actual_boolean", type: "boolean", text: "false" },
      { propertyId: "actual_number", type: "number", text: "12" },
      { propertyId: "actual_date", type: "date", text: "2026-09-19" },
    ]);
  });

  it("parses portable identities and named outgoing relationships", () => {
    const projection = parseKnowledgeMarkdown(`---
noam_document_id: source-id
noam_relationships:
  - depends-on:target-id
  - "owner:person-id"
---`);

    expect(projection.documentId).toBe("source-id");
    expect(projection.relationships).toEqual([
      { relationshipId: "depends-on", targetDocumentId: "target-id", order: 0 },
      { relationshipId: "owner", targetDocumentId: "person-id", order: 1 },
    ]);
  });

  it("leaves nested YAML out of the derived projection", () => {
    const projection = parseKnowledgeMarkdown(`---
nested: [one, [two, three]]
mapping: { key: value }
plain: kept
---`);

    expect(projection.properties).toEqual([
      {
        propertyId: "plain",
        order: 0,
        type: "text",
        text: "kept",
        number: null,
        boolean: null,
      },
    ]);
  });

  it("maps storage keys while preserving exact portable label ids", () => {
    const catalog = parseKnowledgeCatalog(catalogNote);
    expect(catalog).not.toBeNull();
    const projection = parseKnowledgeMarkdown(`---
project_status: in_progress
topic_names: [planning, unknown]
rating: 4
legacy_key: kept
---`, catalog);

    expect(projection.properties.map(({ propertyId, type, text }) => ({ propertyId, type, text }))).toEqual([
      { propertyId: "workflow", type: "text", text: "in_progress" },
      { propertyId: "topics", type: "text", text: "planning" },
      { propertyId: "topics", type: "text", text: "unknown" },
      { propertyId: "score", type: "number", text: "4" },
      { propertyId: "legacy_key", type: "text", text: "kept" },
    ]);
    expect(projection.labels).toEqual([
      { propertyId: "workflow", label: "in_progress", kind: "label" },
      { propertyId: "topics", label: "planning", kind: "tag" },
      { propertyId: "topics", label: "unknown", kind: "tag" },
    ]);
  });

  it("does not treat ambiguous label names as portable ids", () => {
    const catalog = parseKnowledgeCatalog(catalogNote.replace(
      '{ "id": "planning", "name": "Planning", "color": "blue" }',
      '{ "id": "active-a", "name": "Active", "color": "blue" },\n    { "id": "active-b", "name": "active", "color": "green" }',
    ));
    expect(catalog).not.toBeNull();

    const projection = parseKnowledgeMarkdown(`---
project_status: Active
topic_names: [active-b]
---`, catalog);

    expect(projection.labels).toEqual([
      { propertyId: "workflow", label: "Active", kind: "label" },
      { propertyId: "topics", label: "active-b", kind: "tag" },
    ]);
  });

  it("rejects ids outside the desktop portable codec", () => {
    const tooLong = `d${"x".repeat(128)}`;
    const projection = parseKnowledgeMarkdown(`---
noam_document_id: ${tooLong}
noam_relationships:
  - Owner:target
  - owner:target:extra
  - owner:${tooLong}
  - owner:target-ok
---`);

    expect(projection.documentId).toBeNull();
    expect(projection.relationships).toEqual([
      { relationshipId: "owner", targetDocumentId: "target-ok", order: 3 },
    ]);
  });
});
