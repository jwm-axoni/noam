import { api } from "../auth/authManager";
import { sha256Hex } from "../bridge/adapter";
import * as ipc from "../ipc";
import { syncManager, type BackgroundTextPlan } from "../sync/docSession";
import { useStore } from "../../store";
import { validDocumentId } from "./encoding";
import { KnowledgeError } from "./types";

const DOCUMENT_ID_KEY = "noam_document_id";

export interface EnsureWritableDocumentIdentityInput {
  path: string;
  expectedSourceRevision: string;
  expectedEpoch: number;
}

interface FrontmatterEnvelope {
  bomLength: number;
  yamlStart: number;
  closeStart: number;
  newline: "\n" | "\r\n";
}

interface PortableIdentityPlan {
  plan(source: string): BackgroundTextPlan;
  reconcile(source: string): BackgroundTextPlan;
  resolvedDocumentId(): string | null;
}

function frontmatterEnvelope(source: string): FrontmatterEnvelope | null {
  const bomLength = source.startsWith("\uFEFF") ? 1 : 0;
  const text = source.slice(bomLength);
  const newline = text.startsWith("---\r\n")
    ? "\r\n"
    : text.startsWith("---\n")
      ? "\n"
      : null;
  if (!newline) return null;

  const yamlStart = bomLength + 3 + newline.length;
  let cursor = yamlStart;
  while (cursor <= source.length) {
    const lineEnd = source.indexOf("\n", cursor);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const line = source.slice(cursor, end).replace(/\r$/, "");
    if (line === "---") {
      return { bomLength, yamlStart, closeStart: cursor, newline };
    }
    if (lineEnd === -1) return null;
    cursor = lineEnd + 1;
  }
  return null;
}

function generatedIdentityOnly(source: string): string | null {
  const envelope = frontmatterEnvelope(source);
  if (!envelope) return null;
  const yaml = source.slice(envelope.yamlStart, envelope.closeStart);
  const match = yaml.match(/^noam_document_id: ([A-Za-z0-9][A-Za-z0-9._-]{0,127})\r?\n$/);
  return match?.[1] ?? null;
}

interface IdentityLine {
  from: number;
  to: number;
  newline: string;
  value: string | null;
}

function identityLines(source: string, envelope: FrontmatterEnvelope): IdentityLine[] {
  const yaml = source.slice(envelope.yamlStart, envelope.closeStart);
  const lines: IdentityLine[] = [];
  const pattern = /^noam_document_id:[^\r\n]*(\r?\n|$)/gm;
  for (const match of yaml.matchAll(pattern)) {
    const offset = match.index ?? 0;
    const newline = match[1] || envelope.newline;
    const rawValue = match[0]
      .slice(DOCUMENT_ID_KEY.length + 1, match[0].length - (match[1]?.length ?? 0))
      .trim();
    lines.push({
      from: envelope.yamlStart + offset,
      to: envelope.yamlStart + offset + match[0].length,
      newline,
      value: validDocumentId(rawValue) ? rawValue : null,
    });
  }
  return lines;
}

function oneObservedIdentity(lines: IdentityLine[]): string | null {
  const [first, ...rest] = lines;
  if (!first?.value || rest.some((line) => line.value !== first.value)) return null;
  return first.value;
}

function reconcileIdentityLines(
  source: string,
  documentId: string,
): BackgroundTextPlan {
  const envelope = frontmatterEnvelope(source);
  if (!envelope) return { ok: true, changes: [] };
  const lines = identityLines(source, envelope);
  if (lines.length === 0) return { ok: true, changes: [] };
  if (oneObservedIdentity(lines) !== documentId) {
    return { ok: false, reason: "conflict" };
  }

  const [keeper, ...duplicates] = lines;
  const canonical = `${DOCUMENT_ID_KEY}: ${documentId}${keeper.newline}`;
  const changes = duplicates.map(({ from, to }) => ({ from, to, insert: "" }));
  if (source.slice(keeper.from, keeper.to) !== canonical) {
    changes.push({ from: keeper.from, to: keeper.to, insert: canonical });
  }
  return { ok: true, changes };
}

function generatedIdentityEnvelopes(source: string): { end: number; ids: string[] } {
  let cursor = source.startsWith("\uFEFF") ? 1 : 0;
  const ids: string[] = [];
  while (cursor < source.length) {
    const block = frontmatterEnvelope(source.slice(cursor));
    const id = generatedIdentityOnly(source.slice(cursor));
    if (!block || id === null) break;
    const closeEnd = block.closeStart + 3 + block.newline.length;
    cursor += closeEnd;
    ids.push(id);
  }
  return { end: cursor, ids };
}

function reconcilePortableIdentity(
  source: string,
  documentId: string,
): BackgroundTextPlan {
  const generated = generatedIdentityEnvelopes(source);
  if (generated.ids.length > 1) {
    if (generated.ids.some((id) => id !== documentId)) {
      return { ok: false, reason: "conflict" };
    }
    const bomLength = source.startsWith("\uFEFF") ? 1 : 0;
    const newline = source.slice(bomLength).startsWith("---\r\n") ? "\r\n" : "\n";
    return {
      ok: true,
      changes: [{
        from: bomLength,
        to: generated.end,
        insert: `---${newline}${DOCUMENT_ID_KEY}: ${documentId}${newline}---${newline}`,
      }],
    };
  }
  return reconcileIdentityLines(source, documentId);
}

/**
 * Plan the one reserved-key insertion against the live shared text.
 *
 * Rust has already validated `baseline`, including its YAML bounds. Body edits
 * may land after that validation, but frontmatter edits make the plan stale.
 */
export function createPortableIdentityPlan(
  baseline: string,
  proposedDocumentId: string,
): PortableIdentityPlan {
  const baselineEnvelope = frontmatterEnvelope(baseline);
  let resolved: string | null = null;

  const plan = (source: string): BackgroundTextPlan => {
    const liveEnvelope = frontmatterEnvelope(source);
    if (baselineEnvelope) {
      if (!liveEnvelope) return { ok: false, reason: "conflict" };
      const baselineYaml = baseline.slice(
        baselineEnvelope.yamlStart,
        baselineEnvelope.closeStart,
      );
      const liveYaml = source.slice(liveEnvelope.yamlStart, liveEnvelope.closeStart);
      if (liveYaml === baselineYaml) {
        resolved = proposedDocumentId;
        return {
          ok: true,
          changes: [{
            from: liveEnvelope.closeStart,
            to: liveEnvelope.closeStart,
            insert: `${DOCUMENT_ID_KEY}: ${proposedDocumentId}${liveEnvelope.newline}`,
          }],
        };
      }

      const withoutIdentity = identityLines(source, liveEnvelope)
        .sort((a, b) => b.from - a.from)
        .reduce(
          (yaml, line) => {
            const from = line.from - liveEnvelope.yamlStart;
            const to = line.to - liveEnvelope.yamlStart;
            return yaml.slice(0, from) + yaml.slice(to);
          },
          liveYaml,
        );
      if (withoutIdentity === baselineYaml) {
        const lines = identityLines(source, liveEnvelope);
        const observed = oneObservedIdentity(lines);
        if (!observed) return { ok: false, reason: "conflict" };
        resolved = observed;
        return lines.length === 1
          ? { ok: true, changes: [] }
          : reconcilePortableIdentity(source, observed);
      }
      return { ok: false, reason: "conflict" };
    }

    const baselineBomLength = baseline.startsWith("\uFEFF") ? 1 : 0;
    const liveBomLength = source.startsWith("\uFEFF") ? 1 : 0;
    if (liveBomLength !== baselineBomLength) return { ok: false, reason: "conflict" };
    if (liveEnvelope) {
      const generated = generatedIdentityEnvelopes(source);
      const existing = generated.ids[0] ?? null;
      if (!existing || generated.ids.some((id) => id !== existing)) {
        return { ok: false, reason: "conflict" };
      }
      resolved = existing;
      return generated.ids.length > 1
        ? reconcilePortableIdentity(source, existing)
        : { ok: true, changes: [] };
    }

    resolved = proposedDocumentId;
    const body = source.slice(liveBomLength);
    const newline = body.includes("\r\n") ? "\r\n" : "\n";
    return {
      ok: true,
      changes: [{
        from: liveBomLength,
        to: liveBomLength,
        insert: `---${newline}${DOCUMENT_ID_KEY}: ${proposedDocumentId}${newline}---${newline}`,
      }],
    };
  };

  return {
    plan,
    reconcile: (source) => reconcilePortableIdentity(source, resolved ?? proposedDocumentId),
    resolvedDocumentId: () => resolved,
  };
}

function currentWriteStillAllowed(
  path: string,
  expectedEpoch: number,
  expectedDocId: string | null,
): boolean {
  const current = useStore.getState();
  if (current.vault?.epoch !== expectedEpoch) return false;
  if (expectedDocId === null) return !current.syncEnabled;
  return current.syncEnabled && current.docIdByPath[path] === expectedDocId;
}

async function syncedWriteStillAllowed(
  path: string,
  expectedEpoch: number,
  docId: string,
): Promise<boolean> {
  if (!currentWriteStillAllowed(path, expectedEpoch, docId)) return false;
  const permission = await api.syncToken(docId);
  return !permission.readOnly
    && permission.permission === "edit"
    && currentWriteStillAllowed(path, expectedEpoch, docId);
}

function mutationFailure(reason: string): KnowledgeError {
  switch (reason) {
    case "forbidden":
      return new KnowledgeError("read_only", "The target note is read-only.");
    case "unsupported-yaml":
      return new KnowledgeError(
        "unsupported_frontmatter",
        "The target note's frontmatter cannot be changed safely.",
      );
    case "stale":
    case "conflict":
      return new KnowledgeError("stale_edit", "The target note changed.");
    default:
      return new KnowledgeError(
        "temporarily_unavailable",
        "The target note identity could not be saved.",
      );
  }
}

export async function ensureWritableDocumentIdentity(
  input: EnsureWritableDocumentIdentityInput,
): Promise<ipc.InspectDocumentIdentityResult> {
  const initial = useStore.getState();
  if (initial.vault?.epoch !== input.expectedEpoch) {
    throw new KnowledgeError("stale_edit", "The active vault changed.");
  }

  const targetMeta = await ipc.getNoteMeta(input.path, input.expectedEpoch);
  if (!targetMeta || targetMeta.sha256 !== input.expectedSourceRevision) {
    throw new KnowledgeError("stale_edit", "The target note changed.");
  }
  const mappedDocId = initial.syncEnabled ? initial.docIdByPath[input.path] ?? null : null;
  const canonicalDocId = mappedDocId ?? targetMeta.id;
  if (!validDocumentId(canonicalDocId)) {
    throw new KnowledgeError("schema_invalid", "The target note identity is invalid.");
  }
  const preflight = await ipc.inspectDocumentIdentity(
    input.path,
    targetMeta.id,
    mappedDocId,
    input.expectedSourceRevision,
    input.expectedEpoch,
  );
  if (!preflight.insertionRequired) return preflight;

  if (initial.syncEnabled) {
    if (!mappedDocId) {
      throw new KnowledgeError("read_only", "Target note edit permission is unavailable.");
    }
    if (!(await syncedWriteStillAllowed(input.path, input.expectedEpoch, mappedDocId))) {
      throw new KnowledgeError("read_only", "The target note is read-only.");
    }
  }

  const baseline = await ipc.readNote(input.path, input.expectedEpoch);
  if ((await sha256Hex(baseline)) !== preflight.sourceRevision) {
    throw new KnowledgeError("stale_edit", "The target note changed.");
  }

  const identityPlan = createPortableIdentityPlan(baseline, preflight.documentId);
  const mutation = await syncManager.mutateBackgroundText(
    input.path,
    canonicalDocId,
    input.expectedEpoch,
    identityPlan.plan,
    () => currentWriteStillAllowed(input.path, input.expectedEpoch, mappedDocId),
    mappedDocId
      ? () => syncedWriteStillAllowed(input.path, input.expectedEpoch, mappedDocId)
      : undefined,
    preflight.sourceFileIdentity,
    identityPlan.reconcile,
  );
  if (!mutation.ok) throw mutationFailure(mutation.reason);

  const resolvedDocumentId = identityPlan.resolvedDocumentId();
  if (!resolvedDocumentId) {
    throw new KnowledgeError("temporarily_unavailable", "No document identity was saved.");
  }
  const meta = await ipc.getNoteMeta(input.path, input.expectedEpoch);
  if (!meta) throw new KnowledgeError("stale_edit", "The target note is unavailable.");
  const confirmed = await ipc.inspectDocumentIdentity(
    input.path,
    targetMeta.id,
    mappedDocId,
    meta.sha256,
    input.expectedEpoch,
  );
  if (confirmed.insertionRequired) {
    throw new KnowledgeError("stale_edit", "The target note identity was not retained.");
  }
  return confirmed;
}
