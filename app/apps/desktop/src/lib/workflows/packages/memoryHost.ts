// An in-memory `PackageHost` for tests (the fake the contract calls for).
//
// It lives beside the implementation rather than under `__tests__/` so the
// preview, apply, export and QuickAdd suites can share ONE fake; nothing in
// the app imports it, so it never reaches the bundle.
//
// Two things it does that a real host cannot: it records every operation in
// order (`log`), which is how the "recovery record was written BEFORE the
// first write" rule is pinned, and it can be told to fail a chosen write or
// remove, which is how rollback is exercised.

import type { ImportRecoveryRecord, PackageHost } from "../contracts";
import { base64ToBytes, utf8Bytes, utf8Text } from "./bytes";

export interface MemoryHostOptions {
  /** Seed files whose bodies are text. */
  files?: Record<string, string>;
  /** Seed files whose bodies are base64 (binary). */
  base64Files?: Record<string, string>;
  appVersion?: string;
  /** Throw on the Nth write (1-based), counting text and binary writes together. */
  failOnWrite?: number;
  /** Finer control than `failOnWrite`; both apply. */
  failWrite?: (path: string, nth: number) => boolean;
  failRemove?: (path: string) => boolean;
  failRecoveryWrite?: boolean;
}

export interface MemoryPackageHost extends PackageHost {
  files: Map<string, Uint8Array>;
  folders: Set<string>;
  /** Every operation, in order: `record:write`, `write:<path>`, `remove:<path>`, … */
  log: string[];
  records: Map<string, ImportRecoveryRecord>;
  writeCount: number;
  /** Text view of the vault, for whole-state assertions. */
  snapshot(): Record<string, string>;
}

export function createMemoryHost(options: MemoryHostOptions = {}): MemoryPackageHost {
  const files = new Map<string, Uint8Array>();
  for (const [path, text] of Object.entries(options.files ?? {})) {
    files.set(path, utf8Bytes(text));
  }
  for (const [path, b64] of Object.entries(options.base64Files ?? {})) {
    files.set(path, base64ToBytes(b64) ?? new Uint8Array());
  }

  const host: MemoryPackageHost = {
    files,
    folders: new Set<string>(),
    log: [],
    records: new Map<string, ImportRecoveryRecord>(),
    writeCount: 0,

    snapshot() {
      const out: Record<string, string> = {};
      for (const [path, bytes] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        out[path] = utf8Text(bytes);
      }
      return out;
    },

    async exists(path) {
      return files.has(path);
    },
    async readText(path) {
      const bytes = files.get(path);
      return bytes === undefined ? null : utf8Text(bytes);
    },
    async readBytes(path) {
      return files.get(path) ?? null;
    },
    async writeText(path, content) {
      host.writeCount += 1;
      if (shouldFail(path, host.writeCount)) throw new Error(`forced write failure at ${path}`);
      files.set(path, utf8Bytes(content));
      host.log.push(`write:${path}`);
    },
    async writeBytes(path, bytes) {
      host.writeCount += 1;
      if (shouldFail(path, host.writeCount)) throw new Error(`forced write failure at ${path}`);
      files.set(path, bytes.slice());
      host.log.push(`write:${path}`);
    },
    async remove(path) {
      if (options.failRemove?.(path)) throw new Error(`forced remove failure at ${path}`);
      files.delete(path);
      host.log.push(`remove:${path}`);
    },
    async ensureFolder(path) {
      host.folders.add(path);
      host.log.push(`folder:${path}`);
    },
    async writeRecoveryRecord(record) {
      if (options.failRecoveryWrite) throw new Error("forced recovery-record failure");
      const path = `memory:recovery/${record.packageId}-${record.startedAt}.json`;
      host.records.set(path, JSON.parse(JSON.stringify(record)) as ImportRecoveryRecord);
      host.log.push("record:write");
      return path;
    },
    async deleteRecoveryRecord(path) {
      host.records.delete(path);
      host.log.push("record:delete");
    },
    appVersion() {
      return options.appVersion ?? "0.1.59";
    },
  };

  function shouldFail(path: string, nth: number): boolean {
    if (options.failOnWrite !== undefined && options.failOnWrite === nth) return true;
    return options.failWrite?.(path, nth) ?? false;
  }

  return host;
}
