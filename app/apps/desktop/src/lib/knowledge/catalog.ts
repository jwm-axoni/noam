import { Text } from "@codemirror/state";
import { findFrontmatter } from "../editor/frontmatter";
import { parseFrontmatter } from "../frontmatter/parse";
import { validDefinitionId } from "./encoding";
import {
  DOCUMENT_ID_KEY,
  KNOWLEDGE_SCHEMA_KIND,
  KNOWLEDGE_SCHEMA_PATH,
  KNOWLEDGE_SCHEMA_VERSION,
  RELATIONSHIPS_KEY,
  type Cardinality,
  type KnowledgeCatalogV1,
  type LabelDefinition,
  type PropertyDefinition,
  type PropertyType,
  type PropertyValueKind,
  type RelationshipDefinition,
} from "./types";

export type CatalogParseResult =
  | { ok: true; catalog: KnowledgeCatalogV1 }
  | { ok: false; message: string };

const VALUE_KINDS: ReadonlySet<string> = new Set([
  "text",
  "number",
  "checkbox",
  "date",
  "datetime",
  "url",
  "label",
  "tag",
  "alias",
]);
const RESERVED_KEYS = new Set([DOCUMENT_ID_KEY, RELATIONSHIPS_KEY]);
const COLOR_RE = /^(#[0-9a-fA-F]{6}|[a-z][a-z0-9_-]{0,31})$/;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value === value.trim()
    ? value
    : null;
}

function cardinality(value: unknown): Cardinality | null {
  return value === "one" || value === "many" ? value : null;
}

function propertyType(value: unknown): PropertyType | null {
  const row = object(value);
  if (!row || !exactKeys(row, ["kind", "cardinality"])) return null;
  const kind = text(row.kind);
  const count = cardinality(row.cardinality);
  if (!kind || !VALUE_KINDS.has(kind) || !count) return null;
  if (["number", "checkbox", "date", "datetime", "url"].includes(kind) && count !== "one") {
    return null;
  }
  if (["tag", "alias"].includes(kind) && count !== "many") return null;
  return { kind: kind as PropertyValueKind, cardinality: count };
}

function parseProperties(value: unknown): PropertyDefinition[] | string {
  if (!Array.isArray(value)) return "catalog.properties must be an array";
  const out: PropertyDefinition[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const [index, item] of value.entries()) {
    const row = object(item);
    if (!row || !exactKeys(row, ["id", "key", "name", "type", "allowedLabelIds"])) {
      return `catalog.properties[${index}] has unsupported fields`;
    }
    const id = text(row.id);
    const key = text(row.key);
    const name = text(row.name);
    const type = propertyType(row.type);
    if (!id || !validDefinitionId(id)) return `catalog.properties[${index}].id is invalid`;
    if (!key || /[\r\n:]/.test(key)) return `catalog.properties[${index}].key is invalid`;
    if (!name) return `catalog.properties[${index}].name is required`;
    if (!type) return `catalog.properties[${index}].type is invalid`;
    if (RESERVED_KEYS.has(key)) return `${key} is reserved for Noam`;
    if (ids.has(id)) return `duplicate property id: ${id}`;
    if (keys.has(key)) return `duplicate property key: ${key}`;
    ids.add(id);
    keys.add(key);
    let allowedLabelIds: string[] | undefined;
    if (row.allowedLabelIds !== undefined) {
      if (!Array.isArray(row.allowedLabelIds) ||
          row.allowedLabelIds.some((entry) => typeof entry !== "string" || !validDefinitionId(entry))) {
        return `catalog.properties[${index}].allowedLabelIds is invalid`;
      }
      allowedLabelIds = [...new Set(row.allowedLabelIds)];
      if (type.kind !== "label" && type.kind !== "tag") {
        return `catalog.properties[${index}] allows labels but is not label-valued`;
      }
    }
    out.push({ id, key, name, type, ...(allowedLabelIds ? { allowedLabelIds } : {}) });
  }
  return out;
}

function parseLabels(value: unknown): LabelDefinition[] | string {
  if (!Array.isArray(value)) return "catalog.labels must be an array";
  const out: LabelDefinition[] = [];
  const ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    const row = object(item);
    if (!row || !exactKeys(row, ["id", "name", "color"])) {
      return `catalog.labels[${index}] has unsupported fields`;
    }
    const id = text(row.id);
    const name = text(row.name);
    if (!id || !validDefinitionId(id)) return `catalog.labels[${index}].id is invalid`;
    if (!name) return `catalog.labels[${index}].name is required`;
    if (ids.has(id)) return `duplicate label id: ${id}`;
    ids.add(id);
    const color = row.color === undefined ? undefined : text(row.color);
    if (row.color !== undefined && (!color || !COLOR_RE.test(color))) {
      return `catalog.labels[${index}].color is invalid`;
    }
    out.push({ id, name, ...(color ? { color } : {}) });
  }
  return out;
}

function parseRelationships(value: unknown): RelationshipDefinition[] | string {
  if (!Array.isArray(value)) return "catalog.relationships must be an array";
  const out: RelationshipDefinition[] = [];
  const ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    const row = object(item);
    if (!row || !exactKeys(row, ["id", "name", "cardinality", "inverseName"])) {
      return `catalog.relationships[${index}] has unsupported fields`;
    }
    const id = text(row.id);
    const name = text(row.name);
    const count = cardinality(row.cardinality);
    if (!id || !validDefinitionId(id)) return `catalog.relationships[${index}].id is invalid`;
    if (!name) return `catalog.relationships[${index}].name is required`;
    if (!count) return `catalog.relationships[${index}].cardinality is invalid`;
    if (ids.has(id)) return `duplicate relationship id: ${id}`;
    ids.add(id);
    const inverseName = row.inverseName === undefined ? undefined : text(row.inverseName);
    if (row.inverseName !== undefined && !inverseName) {
      return `catalog.relationships[${index}].inverseName is invalid`;
    }
    out.push({ id, name, cardinality: count, ...(inverseName ? { inverseName } : {}) });
  }
  return out;
}

export function validateKnowledgeCatalog(value: unknown): CatalogParseResult {
  const row = object(value);
  if (!row || !exactKeys(row, ["version", "properties", "labels", "relationships"])) {
    return { ok: false, message: "catalog must contain only version, properties, labels, and relationships" };
  }
  if (row.version !== KNOWLEDGE_SCHEMA_VERSION) {
    return { ok: false, message: `catalog.version must be ${KNOWLEDGE_SCHEMA_VERSION}` };
  }
  const properties = parseProperties(row.properties);
  if (typeof properties === "string") return { ok: false, message: properties };
  const labels = parseLabels(row.labels);
  if (typeof labels === "string") return { ok: false, message: labels };
  const relationships = parseRelationships(row.relationships);
  if (typeof relationships === "string") return { ok: false, message: relationships };
  const labelIds = new Set(labels.map((label) => label.id));
  for (const property of properties) {
    const missing = property.allowedLabelIds?.find((id) => !labelIds.has(id));
    if (missing) return { ok: false, message: `property ${property.id} refers to missing label ${missing}` };
  }
  return {
    ok: true,
    catalog: { version: KNOWLEDGE_SCHEMA_VERSION, properties, labels, relationships },
  };
}

/** Parse the complete `_Noam/Knowledge schema.md` note. */
export function parseKnowledgeCatalog(markdown: string): CatalogParseResult {
  const doc = Text.of(markdown.split("\n"));
  const fm = findFrontmatter(doc);
  if (!fm) return { ok: false, message: "knowledge schema frontmatter is missing" };
  const parsed = parseFrontmatter(doc, fm);
  if (!parsed.ok) {
    return { ok: false, message: `knowledge schema frontmatter is unsupported: ${parsed.reason}` };
  }
  const values = new Map(parsed.entries.map((entry) => [entry.key, entry.value]));
  const kind = values.get("noam_kind");
  const version = values.get("noam_knowledge_version");
  if (kind?.kind !== "text" || kind.value !== KNOWLEDGE_SCHEMA_KIND) {
    return { ok: false, message: `noam_kind must be ${KNOWLEDGE_SCHEMA_KIND}` };
  }
  if (version?.kind !== "number" || version.value !== KNOWLEDGE_SCHEMA_VERSION) {
    return { ok: false, message: `noam_knowledge_version must be ${KNOWLEDGE_SCHEMA_VERSION}` };
  }
  const body = markdown.slice(fm.to).trim();
  const fence = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/.exec(body);
  if (!fence) return { ok: false, message: "knowledge schema body must be one fenced JSON catalog" };
  let value: unknown;
  try {
    value = JSON.parse(fence[1]!);
  } catch (error) {
    return {
      ok: false,
      message: `knowledge schema JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return validateKnowledgeCatalog(value);
}

/** Parse the canonical schema note and reject lookalikes at other paths. */
export function parseKnowledgeSchema(path: string, markdown: string): CatalogParseResult {
  if (path !== KNOWLEDGE_SCHEMA_PATH) {
    return { ok: false, message: `knowledge schema path must be ${KNOWLEDGE_SCHEMA_PATH}` };
  }
  return parseKnowledgeCatalog(markdown);
}
