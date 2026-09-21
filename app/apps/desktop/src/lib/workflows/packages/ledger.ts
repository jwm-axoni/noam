// What THIS device imported, so a re-import can tell "my copy of the package"
// from "a note of mine that happens to sit there".
//
// Device-local on purpose: it is not vault content, it must not sync, and it
// must never live under `.context/` (which the watcher and index refuse to
// look at, and which no IPC can write for us). Losing it is harmless — every
// decision it informs degrades to the safe one (`duplicate` instead of
// `replace`), never to an overwrite.
//
// Storage is injected: production passes a `localStorage` store keyed per
// vault, tests pass a memory one.

/** One entry as it was actually written, keyed by the path the MANIFEST declared. */
export interface LedgerEntry {
  /** The destination the package asked for. */
  path: string;
  /** Where it really landed (differs after a `duplicate` rename). */
  destination: string;
  /** Hash of the bytes this device wrote there. */
  sha256: string;
}

export interface LedgerRecord {
  packageId: string;
  version: string;
  importedAt: string;
  entries: LedgerEntry[];
}

/** The JSON blob store the ledger persists through. */
export interface LedgerStore {
  read(): string | null;
  write(value: string): void;
}

export function memoryLedgerStore(initial: string | null = null): LedgerStore {
  let value = initial;
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
  };
}

const KEY_PREFIX = "context.workflowPackages.ledger";

/** Storage key for one vault's ledger. */
export function ledgerKey(vaultKey: string): string {
  return `${KEY_PREFIX}:${vaultKey}`;
}

type WebStorage = Pick<Storage, "getItem" | "setItem">;

function ambientStorage(): WebStorage | null {
  try {
    return (globalThis as { localStorage?: WebStorage }).localStorage ?? null;
  } catch {
    // Some embedders throw on the property access itself.
    return null;
  }
}

/** Production store: `localStorage`, per vault. Best effort — never throws. */
export function localStorageLedgerStore(
  vaultKey: string,
  storage: WebStorage | null = ambientStorage(),
): LedgerStore {
  const key = ledgerKey(vaultKey);
  return {
    read: () => {
      try {
        return storage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    write: (value) => {
      try {
        storage?.setItem(key, value);
      } catch {
        /* quota or a disabled store: the ledger is an optimisation, not state */
      }
    },
  };
}

function isEntry(value: unknown): value is LedgerEntry {
  const e = value as LedgerEntry | null;
  return (
    !!e && typeof e.path === "string" && typeof e.destination === "string" && typeof e.sha256 === "string"
  );
}

export class PackageLedger {
  constructor(private readonly store: LedgerStore) {}

  private load(): LedgerRecord[] {
    const raw = this.store.read();
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (r): r is LedgerRecord =>
          !!r && typeof r.packageId === "string" && Array.isArray(r.entries) && r.entries.every(isEntry),
      );
    } catch {
      return [];
    }
  }

  private save(records: LedgerRecord[]): void {
    this.store.write(JSON.stringify(records));
  }

  all(): LedgerRecord[] {
    return this.load();
  }

  get(packageId: string): LedgerRecord | null {
    return this.load().find((r) => r.packageId === packageId) ?? null;
  }

  /** What this device wrote for one manifest entry of one package, if anything. */
  entry(packageId: string, entryPath: string): LedgerEntry | null {
    const record = this.get(packageId);
    if (!record) return null;
    const wanted = entryPath.toLowerCase();
    return record.entries.find((e) => e.path.toLowerCase() === wanted) ?? null;
  }

  /** Remember an import. One record per package id — the newest wins. */
  record(record: LedgerRecord): void {
    const records = this.load().filter((r) => r.packageId !== record.packageId);
    records.push(record);
    this.save(records);
  }

  forget(packageId: string): void {
    this.save(this.load().filter((r) => r.packageId !== packageId));
  }
}
