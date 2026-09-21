import { Transaction, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { findFrontmatter } from "../editor/frontmatter";
import { serializeValue, type SpanChange } from "../frontmatter/edit";
import { parseFrontmatter, type PropEntry, type PropValue } from "../frontmatter/parse";
import { PRESENTATION_KEYS, PRESENTATION_VERSION } from "./types";

export type PresentationPatch = Record<string, PropValue | null | undefined>;

export type PresentationEditResult =
  | { ok: true; changes: SpanChange[] }
  | { ok: false; reason: "read-only" | "unsupported-yaml" };

export type SafePresentationUndo =
  | { ok: true; source: string }
  | { ok: false; reason: "conflict" };

export type PresentationSnapshot = Record<string, PropValue | null>;

export type ConditionalPresentationUndo =
  | { ok: true; changes: SpanChange[] }
  | { ok: false; reason: "conflict" | "unsupported-yaml" };

/** Restore a folder companion only when it still contains our exact write. */
export function planSafePresentationUndo(
  current: string,
  expected: string,
  previous: string,
): SafePresentationUndo {
  return current === expected
    ? { ok: true, source: previous }
    : { ok: false, reason: "conflict" };
}

export async function applySafePresentationUndo(
  expected: string,
  previous: string,
  read: () => Promise<string>,
  write: (source: string) => Promise<void>,
): Promise<{ ok: true } | { ok: false; reason: "conflict" }> {
  const plan = planSafePresentationUndo(await read(), expected, previous);
  if (!plan.ok) return plan;
  await write(plan.source);
  return { ok: true };
}

function sameValue(a: PropValue | null, b: PropValue | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Read only the named flat scalar fields for a field-scoped undo snapshot. */
export function presentationSnapshot(
  doc: Text,
  keys: readonly string[],
): PresentationSnapshot | null {
  const fm = findFrontmatter(doc);
  const parsed = fm ? parseFrontmatter(doc, fm) : null;
  if (parsed && !parsed.ok) return null;
  const byKey = new Map((parsed?.ok ? parsed.entries : []).map((entry) => [entry.key, entry]));
  return Object.fromEntries(keys.map((key) => [key, byKey.get(key)?.value ?? null]));
}

/** Undo only our fields; unrelated concurrent frontmatter survives untouched. */
export function planConditionalPresentationUndo(
  doc: Text,
  expected: PresentationSnapshot,
  previous: PresentationSnapshot,
): ConditionalPresentationUndo {
  const current = presentationSnapshot(doc, Object.keys(expected));
  if (!current) return { ok: false, reason: "unsupported-yaml" };
  if (Object.keys(expected).some((key) => !sameValue(current[key] ?? null, expected[key] ?? null))) {
    return { ok: false, reason: "conflict" };
  }
  const plan = planPresentationPatch(doc, previous);
  return plan.ok ? plan : { ok: false, reason: "unsupported-yaml" };
}

/** Apply CodeMirror-style spans to the live Y.Text inside one caller transaction. */
export function applyPresentationChangesToText(
  text: {
    delete(index: number, length: number): void;
    insert(index: number, content: string): void;
  },
  changes: readonly SpanChange[],
): void {
  for (const change of [...changes].sort((a, b) => b.from - a.from)) {
    if (change.to > change.from) text.delete(change.from, change.to - change.from);
    if (change.insert) text.insert(change.from, change.insert);
  }
}

function lineFor(key: string, value: PropValue): string {
  return `${key}:${serializeValue(value)}`;
}

/**
 * Plan one atomic presentation edit. Existing values are replaced at their
 * exact spans. Missing values are inserted together, so adding a cover never
 * rewrites or reorders unrelated YAML.
 */
export function planPresentationPatch(
  doc: Text,
  patch: PresentationPatch,
): PresentationEditResult {
  const fm = findFrontmatter(doc);
  const parsed = fm ? parseFrontmatter(doc, fm) : null;
  if (parsed && !parsed.ok) return { ok: false, reason: "unsupported-yaml" };
  const entries = parsed?.ok ? parsed.entries : [];
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const next: PresentationPatch = {
    [PRESENTATION_KEYS.version]: { kind: "number", value: PRESENTATION_VERSION },
    ...patch,
  };
  const changes: SpanChange[] = [];
  const additions: Array<[string, PropValue]> = [];

  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    const entry = byKey.get(key);
    if (value === null) {
      if (entry) changes.push(deleteLine(doc, entry));
      continue;
    }
    if (!entry) {
      additions.push([key, value]);
      continue;
    }
    const insert = serializeValue(value);
    if (insert !== entry.raw) {
      changes.push({ from: entry.valueSpan.from, to: entry.valueSpan.to, insert });
    }
  }

  if (additions.length > 0) {
    const lines = additions.map(([key, value]) => lineFor(key, value)).join("\n");
    if (!fm) {
      changes.push({ from: 0, to: 0, insert: `---\n${lines}\n---\n` });
    } else {
      // Insert at the closing fence rather than after the last entry. The same
      // transaction may delete that last entry, and overlapping a replacement
      // with an insertion inside it is invalid in CodeMirror.
      const at = doc.line(fm.closeLine).from;
      changes.push({ from: at, to: at, insert: `${lines}\n` });
    }
  }

  return { ok: true, changes: changes.sort((a, b) => a.from - b.from) };
}

function deleteLine(doc: Text, entry: PropEntry): SpanChange {
  return {
    from: entry.lineSpan.from,
    to: Math.min(doc.length, entry.lineSpan.to + 1),
    insert: "",
  };
}

export function applyPresentationPatch(
  view: EditorView,
  patch: PresentationPatch,
): PresentationEditResult {
  if (view.state.readOnly) return { ok: false, reason: "read-only" };
  const plan = planPresentationPatch(view.state.doc, patch);
  if (!plan.ok || plan.changes.length === 0) return plan;
  view.dispatch({
    changes: plan.changes,
    annotations: Transaction.userEvent.of("input.presentation"),
    scrollIntoView: false,
  });
  return plan;
}
