// The one command service this app holds, and the React hook over it.
//
// `createVaultCommandService` is per VAULT: the registry it builds is a scan of
// that vault's `.md` files, so switching vaults must build a new one rather
// than re-scan the old one's. Everything else — the slash menu, the action
// picker, shortcut bindings, the Workflows view — reads through here, which is
// what makes "one engine powers every entry point" true in the UI too.
//
// The hook is `useSyncExternalStore` over the service's own subscription. The
// registry publishes a NEW array on every scan and keeps it stable in between,
// so the snapshot getter can hand back `list()` directly.

import { useSyncExternalStore } from "react";
import {
  createVaultCommandService,
  PackageLedger,
  createPackageHost,
  localStorageLedgerStore,
  type CommandService,
  type PackageHost,
  type RegisteredWorkflow,
} from "../../lib/workflows";
import * as ipc from "../../lib/ipc";
import { RESERVED_SHORTCUTS } from "./shortcuts";

const EMPTY: readonly RegisteredWorkflow[] = [];

let service: CommandService | null = null;
let serviceVaultKey: string | null = null;
let unsubscribeService: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** The live service, or null before a vault is open. */
export function getWorkflowService(): CommandService | null {
  return service;
}

/** Which vault the live service belongs to (its path). */
export function getWorkflowVaultKey(): string | null {
  return serviceVaultKey;
}

/**
 * Build the service for `vaultKey` (the vault path), replacing any service
 * from a different vault. Idempotent for the same key, so the effect that
 * calls it can re-run freely. Does NOT scan — call `refreshWorkflows()`.
 */
export function openWorkflowService(vaultKey: string): CommandService {
  if (service && serviceVaultKey === vaultKey) return service;
  closeWorkflowService();
  serviceVaultKey = vaultKey;
  service = createVaultCommandService(RESERVED_SHORTCUTS);
  unsubscribeService = service.subscribe(notify);
  notify();
  return service;
}

/** Tear down on vault switch or unmount. */
export function closeWorkflowService(): void {
  unsubscribeService?.();
  unsubscribeService = null;
  service = null;
  serviceVaultKey = null;
  notify();
}

/** Re-scan the vault. Safe to call with no vault open. */
export function refreshWorkflows(): Promise<void> {
  return service?.refresh() ?? Promise.resolve();
}

export function subscribeWorkflows(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function workflowsSnapshot(): readonly RegisteredWorkflow[] {
  return service?.list() ?? EMPTY;
}

/** Every registered workflow, sorted by name, broken ones included. */
export function useWorkflows(): readonly RegisteredWorkflow[] {
  return useSyncExternalStore(subscribeWorkflows, workflowsSnapshot, workflowsSnapshot);
}

/**
 * Does this watcher batch mean the registry is out of date? A workflow lives
 * in an ordinary `.md` note, so any Markdown change can add, break or remove a
 * command — including a template a workflow's `requires` names.
 */
export function batchTouchesWorkflows(
  changes: ReadonlyArray<{ path: string; kind: string }>,
): boolean {
  return changes.some((change) => change.path.toLowerCase().endsWith(".md"));
}

// ---------------------------------------------------------------------------
// Package plumbing (shared by the import/export/examples dialogs)
// ---------------------------------------------------------------------------

/** Fallback for tests and a non-Tauri host; production reads the real one. */
export const FALLBACK_APP_VERSION = "0.1.59";

let cachedAppVersion: string | null = null;

/** The running build's version, for `minAppVersion` and compatibility checks. */
export async function appVersion(): Promise<string> {
  if (cachedAppVersion) return cachedAppVersion;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    cachedAppVersion = await getVersion();
  } catch {
    cachedAppVersion = FALLBACK_APP_VERSION;
  }
  return cachedAppVersion;
}

export interface PackageContext {
  host: PackageHost;
  ledger: PackageLedger;
  vaultKey: string;
  existingWorkflowIds: string[];
}

/**
 * Everything the package flows need, pinned to the vault that is open RIGHT
 * NOW (epoch included, like every other disk call in this app).
 */
export async function packageContext(
  vault: { path: string; epoch: ipc.VaultEpoch },
): Promise<PackageContext> {
  const version = await appVersion();
  return {
    host: createPackageHost({ appVersion: version, epoch: vault.epoch, vaultKey: vault.path }),
    ledger: new PackageLedger(localStorageLedgerStore(vault.path)),
    vaultKey: vault.path,
    existingWorkflowIds: workflowsSnapshot().flatMap((w) => (w.id ? [w.id] : [])),
  };
}
