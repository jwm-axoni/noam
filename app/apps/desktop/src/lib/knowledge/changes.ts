import { Text } from "@codemirror/state";
import { findFrontmatter, type FrontmatterRange } from "../editor/frontmatter";
import {
  planDeleteProperty,
  planSetValue,
  quoteScalar,
  serializeValue,
  type SpanChange,
} from "../frontmatter/edit";
import {
  parseFrontmatter,
  type PropEntry,
  type PropValue,
} from "../frontmatter/parse";
import {
  decodeRelationship,
  editTokenFor,
  encodeRelationship,
  validDocumentId,
} from "./encoding";
import {
  DOCUMENT_ID_KEY,
  RELATIONSHIPS_KEY,
  KnowledgeError,
  type ChangeRequest,
  type EditToken,
  type KnowledgeCatalogV1,
  type PropertyDefinition,
  type PropertyValue,
} from "./types";

export interface KnowledgeChangePlan {
  changes: SpanChange[];
  changedKeys: string[];
}

const safeBareKey = /^[A-Za-z_][A-Za-z0-9 _-]*$/;

function yamlKey(key: string): string {
  return safeBareKey.test(key) ? key : quoteScalar(key);
}

function rawValue(entry: PropEntry | undefined): string | null {
  return entry?.raw ?? null;
}

export function editTokenForProperty(markdown: string, key: string): EditToken {
  const parsed = parseEditableFrontmatter(markdown);
  return editTokenFor(key, rawValue(parsed.entries.find((entry) => entry.key === key)));
}

function parseEditableFrontmatter(markdown: string): {
  doc: Text;
  frontmatter: FrontmatterRange | null;
  entries: PropEntry[];
} {
  const doc = Text.of(markdown.split("\n"));
  const frontmatter = findFrontmatter(doc);
  if (!frontmatter) return { doc, frontmatter: null, entries: [] };
  const parsed = parseFrontmatter(doc, frontmatter);
  if (!parsed.ok) {
    throw new KnowledgeError(
      "unsupported_frontmatter",
      `Noam cannot edit this frontmatter safely: ${parsed.reason}`,
    );
  }
  return { doc, frontmatter, entries: parsed.entries };
}

function toPropValue(value: PropertyValue): PropValue {
  if (value.kind === "list") return { kind: "list", value: [...value.value] };
  if (value.kind === "url") return { kind: "text", value: value.value };
  if (value.kind === "number") return { kind: "number", value: value.value };
  if (value.kind === "checkbox") return { kind: "checkbox", value: value.value };
  if (value.kind === "date") return { kind: "date", value: value.value };
  if (value.kind === "datetime") return { kind: "datetime", value: value.value };
  return { kind: "text", value: value.value };
}

function acceptsValue(definition: PropertyDefinition, value: PropertyValue): boolean {
  const { kind, cardinality } = definition.type;
  if (cardinality === "many") {
    if (value.kind !== "list") return false;
    return (
      !definition.allowedLabelIds ||
      value.value.every((item) => definition.allowedLabelIds!.includes(item))
    );
  }
  if (kind === "label" || kind === "tag" || kind === "alias" || kind === "text") {
    return (
      value.kind === "text" &&
      (!definition.allowedLabelIds || definition.allowedLabelIds.includes(value.value))
    );
  }
  return value.kind === kind;
}

function entryList(entry: PropEntry | undefined): string[] {
  if (!entry) return [];
  if (entry.value.kind !== "list") {
    throw new KnowledgeError(
      "unsupported_frontmatter",
      `${RELATIONSHIPS_KEY} must be a flat YAML list`,
    );
  }
  for (const raw of entry.value.value) {
    if (!decodeRelationship(raw)) {
      throw new KnowledgeError("schema_invalid", `Invalid relationship entry: ${raw}`);
    }
  }
  return [...entry.value.value];
}

function assertExpected(entry: PropEntry | undefined, key: string, expected: EditToken): void {
  if (editTokenFor(key, rawValue(entry)) !== expected) {
    throw new KnowledgeError("stale_edit", `${key} changed since it was inspected`);
  }
}

function additionChange(
  doc: Text,
  frontmatter: FrontmatterRange | null,
  additions: Array<{ key: string; value: PropValue }>,
): SpanChange | null {
  if (additions.length === 0) return null;
  const lines = additions.map(({ key, value }) => `${yamlKey(key)}:${serializeValue(value)}`);
  if (!frontmatter) {
    return { from: 0, to: 0, insert: `---\n${lines.join("\n")}\n---\n` };
  }
  const at = doc.line(frontmatter.closeLine).from;
  return { from: at, to: at, insert: `${lines.join("\n")}\n` };
}

/**
 * Plan one semantic request against the current Markdown. Returned spans are
 * non-overlapping and apply right-to-left like the existing frontmatter plans.
 */
export function planKnowledgeChanges(
  markdown: string,
  catalog: KnowledgeCatalogV1,
  request: ChangeRequest,
): KnowledgeChangePlan {
  if (!validDocumentId(request.docId)) {
    throw new KnowledgeError("duplicate_document_identity", "The note document id is invalid");
  }
  const { doc, frontmatter, entries } = parseEditableFrontmatter(markdown);
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const propertyById = new Map(catalog.properties.map((property) => [property.id, property]));
  const relationshipById = new Map(
    catalog.relationships.map((relationship) => [relationship.id, relationship]),
  );
  const desired = new Map<string, PropValue | null>();
  const expectedByKey = new Map<string, EditToken>();

  const expect = (key: string, expected: EditToken) => {
    const prior = expectedByKey.get(key);
    if (prior !== undefined && prior !== expected) {
      throw new KnowledgeError("stale_edit", `${key} has conflicting edit tokens`);
    }
    assertExpected(byKey.get(key), key, expected);
    expectedByKey.set(key, expected);
  };

  let relationshipValues: string[] | null = null;
  const relationships = () => {
    if (relationshipValues === null) relationshipValues = entryList(byKey.get(RELATIONSHIPS_KEY));
    return relationshipValues;
  };

  for (const change of request.changes) {
    if (change.kind === "setProperty" || change.kind === "removeProperty") {
      const definition = propertyById.get(change.propertyId);
      if (!definition) {
        throw new KnowledgeError("schema_invalid", `Unknown property definition: ${change.propertyId}`);
      }
      expect(definition.key, change.expected);
      if (change.kind === "removeProperty") {
        desired.set(definition.key, null);
      } else {
        if (!acceptsValue(definition, change.value)) {
          throw new KnowledgeError(
            "schema_invalid",
            `${definition.name} does not accept ${change.value.kind}`,
          );
        }
        desired.set(definition.key, toPropValue(change.value));
      }
      continue;
    }

    expect(RELATIONSHIPS_KEY, change.expected);
    if (change.kind === "addRelationship") {
      const definition = relationshipById.get(change.relationshipId);
      if (!definition) {
        throw new KnowledgeError(
          "schema_invalid",
          `Unknown relationship definition: ${change.relationshipId}`,
        );
      }
      const encoded = encodeRelationship({
        relationshipId: change.relationshipId,
        targetDocId: change.targetDocId,
      });
      const values = relationships();
      if (definition.cardinality === "one") {
        const existing = values.find((raw) => decodeRelationship(raw)?.relationshipId === definition.id);
        if (existing && existing !== encoded) {
          throw new KnowledgeError(
            "stale_edit",
            `${definition.name} already points to another note`,
          );
        }
      }
      if (!values.includes(encoded)) values.push(encoded);

      const identity = byKey.get(DOCUMENT_ID_KEY);
      if (identity) {
        if (identity.value.kind !== "text" || identity.value.value !== request.docId) {
          throw new KnowledgeError(
            "duplicate_document_identity",
            `${DOCUMENT_ID_KEY} does not match this note`,
          );
        }
      } else {
        desired.set(DOCUMENT_ID_KEY, { kind: "text", value: request.docId });
      }
    } else {
      const decoded = decodeRelationship(change.edgeId);
      if (!decoded) throw new KnowledgeError("missing_reference", "Relationship edge is invalid");
      const values = relationships();
      const index = values.indexOf(change.edgeId);
      if (index === -1) throw new KnowledgeError("missing_reference", "Relationship edge is missing");
      values.splice(index, 1);
    }
  }

  if (relationshipValues !== null) {
    desired.set(RELATIONSHIPS_KEY, { kind: "list", value: relationshipValues });
  }

  const changes: SpanChange[] = [];
  const additions: Array<{ key: string; value: PropValue }> = [];
  const changedKeys: string[] = [];
  for (const [key, next] of desired) {
    const current = byKey.get(key);
    if (next === null) {
      if (current) {
        changes.push(...planDeleteProperty(doc, current));
        changedKeys.push(key);
      }
      continue;
    }
    if (current) {
      const planned = planSetValue(current, next);
      if (planned.length > 0) {
        changes.push(...planned);
        changedKeys.push(key);
      }
    } else {
      additions.push({ key, value: next });
      changedKeys.push(key);
    }
  }
  const addition = additionChange(doc, frontmatter, additions);
  if (addition) changes.push(addition);
  return { changes, changedKeys };
}

export function applyKnowledgeChangePlan(markdown: string, plan: KnowledgeChangePlan): string {
  let result = markdown;
  for (const change of [...plan.changes].sort((a, b) => b.from - a.from)) {
    result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  }
  return result;
}
