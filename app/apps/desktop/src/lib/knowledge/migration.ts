import { validDefinitionId } from "./encoding";
import {
  DOCUMENT_ID_KEY,
  KNOWLEDGE_SCHEMA_VERSION,
  RELATIONSHIPS_KEY,
  type KnowledgeCatalogV1,
  type PropertyDefinition,
  type PropertyType,
} from "./types";

type LegacyType =
  | "text"
  | "list"
  | "number"
  | "checkbox"
  | "date"
  | "datetime"
  | "tags"
  | "aliases";

const LEGACY_TYPES = new Set<string>([
  "text",
  "list",
  "number",
  "checkbox",
  "date",
  "datetime",
  "tags",
  "aliases",
]);

export interface LegacyTypesMigration {
  /** A proposal only. The caller must obtain review before creating the schema note. */
  catalog: KnowledgeCatalogV1;
  importedKeys: string[];
  skippedKeys: Array<{
    key: string;
    reason: "already-defined" | "invalid-key" | "invalid-type";
  }>;
  warnings: string[];
}

function emptyCatalog(): KnowledgeCatalogV1 {
  return { version: KNOWLEDGE_SCHEMA_VERSION, properties: [], labels: [], relationships: [] };
}

function typeFromLegacy(type: LegacyType): PropertyType {
  switch (type) {
    case "list":
      return { kind: "text", cardinality: "many" };
    case "tags":
      return { kind: "tag", cardinality: "many" };
    case "aliases":
      return { kind: "alias", cardinality: "many" };
    default:
      return { kind: type, cardinality: "one" };
  }
}

function displayName(key: string): string {
  const words = key.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return words === "" ? key : words[0]!.toUpperCase() + words.slice(1);
}

function baseId(key: string): string {
  const id = key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return validDefinitionId(id) ? id : "property";
}

function uniqueId(key: string, taken: Set<string>): string {
  const base = baseId(key);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const candidate = `${base.slice(0, 64 - String(suffix).length - 1)}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a property id for ${key}`);
}

/**
 * Convert only explicit legacy choices into a portable catalog proposal.
 * This function performs no I/O and never infers definitions from note values.
 */
export function migrateLegacyTypes(
  raw: string | null,
  existing: KnowledgeCatalogV1 = emptyCatalog(),
): LegacyTypesMigration {
  const catalog: KnowledgeCatalogV1 = {
    version: KNOWLEDGE_SCHEMA_VERSION,
    properties: existing.properties.map((property) => ({
      ...property,
      type: { ...property.type },
      ...(property.allowedLabelIds
        ? { allowedLabelIds: [...property.allowedLabelIds] }
        : {}),
    })),
    labels: existing.labels.map((label) => ({ ...label })),
    relationships: existing.relationships.map((relationship) => ({ ...relationship })),
  };
  const importedKeys: string[] = [];
  const skippedKeys: LegacyTypesMigration["skippedKeys"] = [];
  const warnings: string[] = [];
  if (!raw) return { catalog, importedKeys, skippedKeys, warnings };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push("Legacy types.json is not valid JSON.");
    return { catalog, importedKeys, skippedKeys, warnings };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push("Legacy types.json must contain an object.");
    return { catalog, importedKeys, skippedKeys, warnings };
  }
  const file = parsed as { version?: unknown; types?: unknown };
  if (file.version !== 1 || file.types === null || typeof file.types !== "object" || Array.isArray(file.types)) {
    warnings.push("Legacy types.json has an unsupported shape or version.");
    return { catalog, importedKeys, skippedKeys, warnings };
  }

  const definedKeys = new Set(catalog.properties.map((property) => property.key));
  const takenIds = new Set(catalog.properties.map((property) => property.id));
  for (const [key, value] of Object.entries(file.types as Record<string, unknown>)) {
    if (definedKeys.has(key)) {
      skippedKeys.push({ key, reason: "already-defined" });
      continue;
    }
    if (typeof value !== "string" || !LEGACY_TYPES.has(value)) {
      skippedKeys.push({ key, reason: "invalid-type" });
      continue;
    }
    if (
      key.trim() === "" ||
      /[\r\n:]/.test(key) ||
      key === DOCUMENT_ID_KEY ||
      key === RELATIONSHIPS_KEY
    ) {
      skippedKeys.push({ key, reason: "invalid-key" });
      continue;
    }
    const id = uniqueId(key, takenIds);
    const property: PropertyDefinition = {
      id,
      key,
      name: displayName(key),
      type: typeFromLegacy(value as LegacyType),
    };
    catalog.properties.push(property);
    importedKeys.push(key);
    definedKeys.add(key);
    takenIds.add(id);
  }
  return { catalog, importedKeys, skippedKeys, warnings };
}
