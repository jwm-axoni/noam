import {
  DOCUMENT_ID_KEY,
  RELATIONSHIPS_KEY,
  type EditToken,
} from "./types";

const DEFINITION_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const DOCUMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface RelationshipValue {
  relationshipId: string;
  targetDocId: string;
}

export function validDefinitionId(value: string): boolean {
  return DEFINITION_ID_RE.test(value);
}

export function validDocumentId(value: string): boolean {
  return DOCUMENT_ID_RE.test(value);
}

/** Portable scalar representation stored in `noam_document_id`. */
export function encodeDocumentId(documentId: string): string {
  if (!validDocumentId(documentId)) {
    throw new Error(`Invalid document id: ${documentId}`);
  }
  return documentId;
}

export function decodeDocumentId(raw: string): string | null {
  return validDocumentId(raw) ? raw : null;
}

/** Flat, portable relationship representation stored in `noam_relationships`. */
export function encodeRelationship(value: RelationshipValue): string {
  if (!validDefinitionId(value.relationshipId)) {
    throw new Error(`Invalid relationship id: ${value.relationshipId}`);
  }
  if (!validDocumentId(value.targetDocId)) {
    throw new Error(`Invalid target document id: ${value.targetDocId}`);
  }
  return `${value.relationshipId}:${value.targetDocId}`;
}

export function decodeRelationship(raw: string): RelationshipValue | null {
  const colon = raw.indexOf(":");
  if (colon <= 0 || colon === raw.length - 1) return null;
  const relationshipId = raw.slice(0, colon);
  const targetDocId = raw.slice(colon + 1);
  return validDefinitionId(relationshipId) && validDocumentId(targetDocId)
    ? { relationshipId, targetDocId }
    : null;
}

/** The stored relationship value is also its stable edge id. */
export function relationshipEdgeId(value: RelationshipValue): string {
  return encodeRelationship(value);
}

/**
 * Field-scoped optimistic token. This is an identity token, not a secret or a
 * content revision. The key is included so tokens cannot move between fields.
 */
export function editTokenFor(key: string, rawValue: string | null): EditToken {
  // The token is opaque, not secret. Preserve the complete field state so the
  // optimistic check cannot accept a hash collision and overwrite a concurrent
  // edit. Prefixing absent/present keeps a missing key distinct from an empty
  // scalar; encodeURIComponent makes the two segments unambiguous.
  const state = rawValue === null ? "a" : `p${encodeURIComponent(rawValue)}`;
  return `nk1:${encodeURIComponent(key)}:${state}` as EditToken;
}

export const documentIdEditToken = (rawValue: string | null): EditToken =>
  editTokenFor(DOCUMENT_ID_KEY, rawValue);

export const relationshipsEditToken = (rawValue: string | null): EditToken =>
  editTokenFor(RELATIONSHIPS_KEY, rawValue);
