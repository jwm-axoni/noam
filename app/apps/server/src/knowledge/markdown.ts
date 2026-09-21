/**
 * Conservative extraction of the flat frontmatter Noam's Properties editor can
 * represent. This reader never rewrites Markdown. Unsupported nested values are
 * skipped while ordinary text, scalar lists, and block lists are indexed.
 */

export type IndexedValueType = "text" | "number" | "boolean" | "date" | "datetime";

export interface IndexedPropertyValue {
  propertyId: string;
  order: number;
  type: IndexedValueType;
  text: string | null;
  number: number | null;
  boolean: boolean | null;
}

export interface IndexedLabel {
  propertyId: string;
  label: string;
  kind: "label" | "tag";
}

export interface IndexedRelationship {
  relationshipId: string;
  targetDocumentId: string;
  order: number;
}

export interface KnowledgeProjection {
  documentId: string | null;
  properties: IndexedPropertyValue[];
  labels: IndexedLabel[];
  relationships: IndexedRelationship[];
}

export interface KnowledgeCatalogProperty {
  id: string;
  key: string;
  type: {
    kind: "text" | "number" | "checkbox" | "date" | "datetime" | "url" | "label" | "tag" | "alias";
    cardinality: "one" | "many";
  };
  allowedLabelIds?: string[];
}

export interface KnowledgeCatalog {
  properties: KnowledgeCatalogProperty[];
  labels: Array<{ id: string; name: string }>;
}

interface Scalar {
  type: IndexedValueType;
  value: string | number | boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
// Keep these byte-for-byte aligned with the portable desktop codecs.
const DEFINITION_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROPERTY_KINDS = new Set([
  "text", "number", "checkbox", "date", "datetime", "url", "label", "tag", "alias",
]);
const CATALOG_COLOR = /^(#[0-9a-fA-F]{6}|[a-z][a-z0-9_-]{0,31})$/;

function unquote(input: string): string {
  if (input.length < 2) return input;
  if (input.startsWith('"') && input.endsWith('"')) {
    try {
      return JSON.parse(input) as string;
    } catch {
      return input.slice(1, -1);
    }
  }
  if (input.startsWith("'") && input.endsWith("'")) {
    return input.slice(1, -1).replace(/''/g, "'");
  }
  return input;
}

function stripComment(input: string): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quote === '"' && char === "\\") {
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === "#" && quote === null && (i === 0 || /\s/.test(input[i - 1]!))) {
      return input.slice(0, i).trimEnd();
    }
  }
  return input.trimEnd();
}

function splitFlowList(input: string): string[] | null {
  if (!input.startsWith("[") || !input.endsWith("]")) return null;
  const body = input.slice(1, -1);
  if (body.trim() === "") return [];
  const values: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (quote === '"' && char === "\\") {
      current += char + (body[++i] ?? "");
      continue;
    }
    if (char === "'" || char === '"') {
      quote = quote === char ? null : quote ?? char;
      current += char;
      continue;
    }
    if (quote === null && (char === "[" || char === "]" || char === "{" || char === "}")) {
      return null;
    }
    if (char === "," && quote === null) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (quote !== null) return null;
  values.push(current.trim());
  return values;
}

function scalar(input: string): Scalar | null {
  const raw = stripComment(input).trim();
  const quoted =
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"));
  const token = unquote(raw);
  if (token === "") return { type: "text", value: "" };
  if (quoted) return { type: "text", value: token };
  if (token === "true" || token === "false") {
    return { type: "boolean", value: token === "true" };
  }
  if (NUMBER.test(token)) {
    const value = Number(token);
    if (Number.isFinite(value)) return { type: "number", value };
  }
  if (DATE.test(token)) return { type: "date", value: token };
  if (DATETIME.test(token)) return { type: "datetime", value: token };
  if (/^[\[|>&*!{]/.test(token)) return null;
  return { type: "text", value: token };
}

function frontmatterLines(markdown: string): string[] {
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return [];
  const close = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  return close < 0 ? [] : lines.slice(1, close);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function catalogText(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.trim();
}

/** Parse the portable catalog note. Invalid or lookalike notes have no authority. */
export function parseKnowledgeCatalog(markdown: string): KnowledgeCatalog | null {
  const header = new Map(entries(markdown).map((entry) => [entry.key, scalar(entry.values[0] ?? "")]));
  if (header.get("noam_kind")?.value !== "knowledge-schema" ||
      header.get("noam_knowledge_version")?.value !== 1) return null;

  const normalized = markdown.replace(/^\uFEFF/, "");
  const frontmatter = /^(?:---\r?\n)[\s\S]*?\r?\n(?:---|\.\.\.)\s*\r?\n([\s\S]*)$/.exec(normalized);
  const fence = frontmatter && /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/.exec(frontmatter[1]!.trim());
  if (!fence) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]!);
  } catch {
    return null;
  }
  const root = record(parsed);
  if (!root || !exactKeys(root, ["version", "properties", "labels", "relationships"]) ||
      root.version !== 1 || !Array.isArray(root.properties) || !Array.isArray(root.labels) ||
      !Array.isArray(root.relationships)) return null;

  const labels: Array<{ id: string; name: string }> = [];
  const labelIds = new Set<string>();
  for (const value of root.labels) {
    const row = record(value);
    if (!row || !exactKeys(row, ["id", "name", "color"]) ||
        !catalogText(row.id) || !DEFINITION_ID.test(row.id) ||
        !catalogText(row.name) || labelIds.has(row.id)) return null;
    if (row.color !== undefined && (
      !catalogText(row.color) || !CATALOG_COLOR.test(row.color)
    )) return null;
    labelIds.add(row.id);
    labels.push({ id: row.id, name: row.name });
  }

  const properties: KnowledgeCatalogProperty[] = [];
  const propertyIds = new Set<string>();
  const propertyKeys = new Set<string>();
  for (const value of root.properties) {
    const row = record(value);
    const type = row && record(row.type);
    if (!row || !exactKeys(row, ["id", "key", "name", "type", "allowedLabelIds"]) || !type ||
        !exactKeys(type, ["kind", "cardinality"]) ||
        !catalogText(row.id) || !DEFINITION_ID.test(row.id) ||
        !catalogText(row.key) || /[\r\n:]/.test(row.key) ||
        row.key === "noam_document_id" || row.key === "noam_relationships" ||
        !catalogText(row.name) ||
        !catalogText(type.kind) || !PROPERTY_KINDS.has(type.kind) ||
        (type.cardinality !== "one" && type.cardinality !== "many") ||
        propertyIds.has(row.id) || propertyKeys.has(row.key)) return null;
    if (["number", "checkbox", "date", "datetime", "url"].includes(type.kind) && type.cardinality !== "one") return null;
    if (["tag", "alias"].includes(type.kind) && type.cardinality !== "many") return null;
    let allowedLabelIds: string[] | undefined;
    if (row.allowedLabelIds !== undefined) {
      if (!Array.isArray(row.allowedLabelIds) ||
          row.allowedLabelIds.some((id) => typeof id !== "string" || !DEFINITION_ID.test(id)) ||
          (type.kind !== "label" && type.kind !== "tag")) return null;
      allowedLabelIds = [...new Set(row.allowedLabelIds as string[])];
    }
    propertyIds.add(row.id);
    propertyKeys.add(row.key);
    properties.push({
      id: row.id,
      key: row.key,
      type: type as KnowledgeCatalogProperty["type"],
      ...(allowedLabelIds ? { allowedLabelIds } : {}),
    });
  }
  if (properties.some((property) => property.allowedLabelIds?.some((id) => !labelIds.has(id)))) return null;

  const relationshipIds = new Set<string>();
  for (const value of root.relationships) {
    const row = record(value);
    if (!row || !exactKeys(row, ["id", "name", "cardinality", "inverseName"]) ||
        !catalogText(row.id) || !DEFINITION_ID.test(row.id) || relationshipIds.has(row.id) ||
        !catalogText(row.name) ||
        (row.cardinality !== "one" && row.cardinality !== "many") ||
        (row.inverseName !== undefined && !catalogText(row.inverseName))) return null;
    relationshipIds.add(row.id);
  }
  return { properties, labels };
}

function entries(markdown: string): Array<{ key: string; values: string[] }> {
  const lines = frontmatterLines(markdown);
  const out: Array<{ key: string; values: string[] }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trimStart().startsWith("#") || /^\s/.test(line)) continue;
    const match = /^("(?:\\.|[^"])*"|'(?:''|[^'])*'|[^:]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = unquote(match[1]!.trim());
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const tail = stripComment(match[2]!.trim());
    const flow = splitFlowList(tail);
    if (flow) {
      out.push({ key, values: flow });
      continue;
    }
    if (tail !== "") {
      out.push({ key, values: [tail] });
      continue;
    }
    const block: string[] = [];
    while (i + 1 < lines.length) {
      const item = /^\s+-\s*(.*)$/.exec(lines[i + 1]!);
      if (!item) break;
      block.push(stripComment(item[1]!).trim());
      i++;
    }
    out.push({ key, values: block.length > 0 ? block : [""] });
  }
  return out;
}

export function parseKnowledgeMarkdown(
  markdown: string,
  catalog: KnowledgeCatalog | null = null,
): KnowledgeProjection {
  const projection: KnowledgeProjection = {
    documentId: null,
    properties: [],
    labels: [],
    relationships: [],
  };
  for (const entry of entries(markdown)) {
    if (entry.key === "noam_document_id") {
      const value = unquote(entry.values[0] ?? "").trim();
      projection.documentId = DOCUMENT_ID.test(value) ? value : null;
      continue;
    }
    if (entry.key === "noam_relationships") {
      for (const [order, raw] of entry.values.entries()) {
        const value = unquote(raw).trim();
        const colon = value.indexOf(":");
        if (colon <= 0) continue;
        const relationshipId = value.slice(0, colon);
        const targetDocumentId = value.slice(colon + 1);
        if (!DEFINITION_ID.test(relationshipId) || !DOCUMENT_ID.test(targetDocumentId)) continue;
        projection.relationships.push({ relationshipId, targetDocumentId, order });
      }
      continue;
    }
    if (entry.key.startsWith("noam_")) continue;
    const definition = catalog?.properties.find((property) => property.key === entry.key);
    const propertyId = definition?.id ?? entry.key;
    for (const [order, raw] of entry.values.entries()) {
      const parsed = scalar(raw);
      if (!parsed) continue;
      const declared = definition?.type.kind;
      const type = declared === "number" && typeof parsed.value === "number" ? "number"
        : declared === "checkbox" && typeof parsed.value === "boolean" ? "boolean"
        : declared === "date" && typeof parsed.value === "string" ? "date"
        : declared === "datetime" && typeof parsed.value === "string" ? "datetime"
        : declared && ["text", "url", "label", "tag", "alias"].includes(declared) ? "text"
        : parsed.type;
      projection.properties.push({
        propertyId,
        order,
        type,
        text: typeof parsed.value === "string" ? parsed.value : String(parsed.value),
        number: type === "number" && typeof parsed.value === "number" ? parsed.value : null,
        boolean: type === "boolean" && typeof parsed.value === "boolean" ? parsed.value : null,
      });
      const labelKind = declared === "label" || declared === "tag"
        ? declared
        : entry.key === "tags" ? "tag"
        : entry.key === "labels" ? "label"
        : null;
      if (labelKind && typeof parsed.value === "string") {
        const rawLabel = parsed.value.replace(/^#/, "").trim();
        if (rawLabel) {
          projection.labels.push({
            propertyId,
            label: rawLabel,
            kind: labelKind,
          });
        }
      }
    }
  }
  return projection;
}
