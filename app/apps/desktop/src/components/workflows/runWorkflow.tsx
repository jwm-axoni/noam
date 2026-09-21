// The shared run flow. Every entry point ends up here.
//
// A run is REQUESTED, not called: the slash menu's `apply` runs inside a
// CodeMirror transaction, a keyboard shortcut runs inside a keydown handler,
// and the action picker runs from a list row — none of them can mount a React
// dialog. So they push a request onto this tiny bus and `WorkflowRunHost` (one
// instance, mounted in `App`) renders the prompt.
//
// That indirection is also what keeps `lib/editor/slash.ts` free of React.

import { lazy, Suspense, useSyncExternalStore } from "react";
import type { EditorContext, ExecutionEffect, WorkflowId } from "../../lib/workflows";

const PromptDialog = lazy(() =>
  import("./PromptDialog").then((m) => ({ default: m.PromptDialog })),
);

export interface WorkflowRunRequest {
  id: WorkflowId;
  ctx: EditorContext;
  /** Bumped per request so a repeat of the same workflow remounts the dialog. */
  token: number;
  /** Focus goes back here when the dialog closes. */
  returnFocus: HTMLElement | null;
}

interface RunSnapshot {
  request: WorkflowRunRequest | null;
}

let snapshot: RunSnapshot = { request: null };
let nextToken = 1;
const listeners = new Set<() => void>();

function publish(request: WorkflowRunRequest | null): void {
  snapshot = { request };
  for (const listener of [...listeners]) listener();
}

/**
 * Start a workflow. Returns the request token so a caller can tell two
 * requests apart; the dialog itself is rendered by `WorkflowRunHost`.
 */
export function requestWorkflowRun(
  id: WorkflowId,
  ctx: EditorContext = {},
  returnFocus?: HTMLElement | null,
): number {
  const token = nextToken++;
  // An entry point that unmounts itself (the action picker) passes the element
  // IT was opened from, because its own input is about to leave the document.
  const active = typeof document === "undefined" ? null : document.activeElement;
  publish({
    id,
    ctx,
    token,
    returnFocus:
      returnFocus !== undefined ? returnFocus : active instanceof HTMLElement ? active : null,
  });
  return token;
}

/**
 * Drop any pending request (vault switch, Escape).
 *
 * The dialog does NOT call this while a run is in flight — there is no channel
 * to stop the engine mid-write, so it stays up and disabled until the run
 * settles rather than letting the request go and the writes continue unseen.
 */
export function cancelWorkflowRun(): void {
  if (snapshot.request) publish(null);
}

export function subscribeWorkflowRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function workflowRunSnapshot(): RunSnapshot {
  return snapshot;
}

/**
 * One line summarising what a successful run did. Deliberately counts rather
 * than lists: a `run-workflow` chain can produce a dozen effects and a toast
 * is not a log.
 */
export function describeEffects(effects: readonly ExecutionEffect[]): string {
  if (effects.length === 0) return "Nothing to do";
  const created = effects.filter((e) => e.kind === "created");
  const appended = effects.filter((e) => e.kind === "appended");
  const inserted = effects.filter((e) => e.kind === "inserted");
  const opened = effects.filter((e) => e.kind === "opened");
  const parts: string[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (created.length === 1) parts.push(`Created ${created[0].path}`);
  else if (created.length > 1) parts.push(`Created ${plural(created.length, "note")}`);
  if (appended.length === 1) {
    const only = appended[0];
    parts.push(`Appended to ${only.heading ? `${only.heading} in ` : ""}${only.path}`);
  } else if (appended.length > 1) parts.push(`Appended to ${plural(appended.length, "note")}`);
  if (inserted.length > 0) parts.push(`Inserted into ${inserted[0].path}`);
  if (opened.length > 0 && created.length === 0) parts.push(`Opened ${opened[0].path}`);
  if (parts.length === 0) parts.push(`Ran ${plural(effects.length, "step")}`);
  return parts.join(" · ");
}

/**
 * Mounted once, near the top of the app. Renders nothing until a run is
 * requested, and loads the dialog chunk only then.
 */
export function WorkflowRunHost() {
  const { request } = useSyncExternalStore(
    subscribeWorkflowRun,
    workflowRunSnapshot,
    workflowRunSnapshot,
  );
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <PromptDialog key={request.token} request={request} onClose={cancelWorkflowRun} />
    </Suspense>
  );
}
