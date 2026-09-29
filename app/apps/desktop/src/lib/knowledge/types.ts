/** Portable note-knowledge domain types. No UI, storage, or Yjs types cross this seam. */

export const KNOWLEDGE_SCHEMA_PATH = "_Noam/Knowledge schema.md";
export const KNOWLEDGE_SCHEMA_KIND = "knowledge-schema";
export const KNOWLEDGE_SCHEMA_VERSION = 1 as const;
export const DOCUMENT_ID_KEY = "noam_document_id";
export const RELATIONSHIPS_KEY = "noam_relationships";
/**
 * Reserved, derived, read-only property ids every note has (epoch ms, UTC):
 * `created` (frontmatter `created:` → server `notes.created_at` → file
 * birthtime) and `modified` (file mtime; the server's last content edit).
 * Queryable in `where` and `sort`; a `change` on them is `read_only`.
 */
export const SYSTEM_PROPERTY_IDS = ["created", "modified"] as const;
export type SystemPropertyId = (typeof SYSTEM_PROPERTY_IDS)[number];

export type Cardinality = "one" | "many";

export type PropertyValueKind =
  | "text"
  | "number"
  | "checkbox"
  | "date"
  | "datetime"
  | "url"
  | "label"
  | "tag"
  | "alias";

export interface PropertyType {
  kind: PropertyValueKind;
  cardinality: Cardinality;
}

export interface PropertyDefinition {
  id: string;
  /** The exact frontmatter key. It is never inferred from the display name. */
  key: string;
  name: string;
  type: PropertyType;
  allowedLabelIds?: string[];
}

export interface LabelDefinition {
  id: string;
  name: string;
  color?: string;
}

export interface RelationshipDefinition {
  id: string;
  name: string;
  cardinality: Cardinality;
  inverseName?: string;
}

export interface KnowledgeCatalogV1 {
  version: typeof KNOWLEDGE_SCHEMA_VERSION;
  properties: PropertyDefinition[];
  labels: LabelDefinition[];
  relationships: RelationshipDefinition[];
}

export type PropertyValue =
  | { kind: "text" | "date" | "datetime" | "url"; value: string }
  | { kind: "number"; value: number }
  | { kind: "checkbox"; value: boolean }
  | { kind: "list"; value: string[] };

/** Opaque to callers. It identifies one frontmatter field value, not the note body. */
export type EditToken = string & { readonly __editToken: unique symbol };

export interface PageRequest {
  limit?: number;
  cursor?: string;
}

export type InspectionRequest =
  | { docId: string; section: "summary" }
  | {
      docId: string;
      section: "relationships";
      direction: "outgoing" | "incoming";
      page?: PageRequest;
    }
  | { docId: string; section: "backlinks"; page?: PageRequest }
  | { docId: string; section: "info" }
  | { docId: string; section: "history"; page?: PageRequest };

export interface PropertyPredicate {
  propertyId: string;
  operator: "equals" | "contains" | "exists";
  value?: PropertyValue;
}

export interface KnowledgeQuery {
  text?: string;
  where?: PropertyPredicate[];
  traverse?: {
    fromDocId: string;
    relationshipIds: string[];
    direction: "outgoing" | "incoming";
    maxDepth: 1 | 2 | 3 | 4;
  };
  sort?: KnowledgeSort;
  page?: PageRequest;
  consistency?: "current-only" | "allow-stale";
}

/**
 * Result order. Ties break by doc id ascending; a note with no sortable value
 * sorts last in both directions. The sort is part of the query a cursor is
 * bound to, so a cursor from one sort is refused under another.
 */
export interface KnowledgeSort {
  key: "name" | "created" | "modified" | { propertyId: string };
  direction: "asc" | "desc";
}

export type NoteChange =
  | { kind: "setProperty"; propertyId: string; value: PropertyValue; expected: EditToken }
  | { kind: "removeProperty"; propertyId: string; expected: EditToken }
  | {
      kind: "addRelationship";
      relationshipId: string;
      targetDocId: string;
      expected: EditToken;
    }
  | { kind: "removeRelationship"; edgeId: string; expected: EditToken };

export interface ChangeRequest {
  docId: string;
  changes: NoteChange[];
}

export type KnowledgeErrorCode =
  | "not_found"
  | "read_only"
  | "stale_edit"
  | "unsupported_frontmatter"
  | "schema_invalid"
  | "ambiguous_reference"
  | "missing_reference"
  | "duplicate_document_identity"
  | "stale_index"
  | "cursor_expired"
  | "limit_exceeded"
  | "temporarily_unavailable";

export class KnowledgeError extends Error {
  constructor(
    readonly code: KnowledgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeError";
  }
}

/**
 * The product interface. Construction binds the authenticated vault and actor;
 * callers never supply an actor id.
 */
export interface NoteKnowledge {
  inspect<R extends InspectionRequest>(request: R): Promise<InspectionResult<R>>;
  change(request: ChangeRequest): Promise<ChangeReceipt>;
  query(request: KnowledgeQuery): Promise<KnowledgePage>;
}

/** The concrete result shapes arrive with the UI and query adapters. */
export type InspectionResult<R extends InspectionRequest> = {
  request: R;
  sourceRevision: string;
  value: unknown;
};

export interface ChangeReceipt {
  docId: string;
  sourceRevision: string;
  indexState: "ready" | "pending" | "stale";
}

export interface AnswerEvidence {
  docId: string;
  relPath: string;
  sourceRevision: string;
  indexRevision: string;
  passages: Array<{ startLine: number; endLine: number; text: string }>;
}

export interface KnowledgePage {
  items: unknown[];
  evidence: AnswerEvidence[];
  nextCursor?: string;
}
