import * as ipc from "../ipc";
import { parseKnowledgeSchema } from "./catalog";
import { KNOWLEDGE_SCHEMA_PATH, type KnowledgeCatalogV1 } from "./types";

export interface KnowledgeCatalogSnapshot {
  catalog: KnowledgeCatalogV1 | null;
  error: string | null;
  loaded: boolean;
  loading: boolean;
  epoch: number | null;
}

let snapshot: KnowledgeCatalogSnapshot = {
  catalog: null,
  error: null,
  loaded: false,
  loading: false,
  epoch: null,
};
let loading: Promise<void> | null = null;
let loadingEpoch: number | null = null;
let loadGeneration = 0;
const listeners = new Set<() => void>();

function publish(next: KnowledgeCatalogSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

export function getKnowledgeCatalogSnapshot(): KnowledgeCatalogSnapshot {
  return snapshot;
}

export function subscribeKnowledgeCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Load the portable catalog. A missing note means the vault is not configured yet. */
function requestKnowledgeCatalog(epoch?: number, force = false): Promise<void> {
  const at = epoch ?? null;
  if (!force && snapshot.loaded && snapshot.epoch === at && !loading) return Promise.resolve();
  if (loading && loadingEpoch === at) {
    const current = loading;
    const generation = loadGeneration;
    return force
      ? current.then(() => {
          if (generation !== loadGeneration) return;
          return requestKnowledgeCatalog(epoch, true);
        })
      : current;
  }
  const generation = ++loadGeneration;
  loadingEpoch = at;
  publish({
    catalog: snapshot.epoch === at ? snapshot.catalog : null,
    error: null,
    loaded: false,
    loading: true,
    epoch: at,
  });
  const request = ipc
    .readNote(KNOWLEDGE_SCHEMA_PATH, epoch)
    .then((markdown) => {
      if (generation !== loadGeneration) return;
      const parsed = parseKnowledgeSchema(KNOWLEDGE_SCHEMA_PATH, markdown);
      publish({
        catalog: parsed.ok ? parsed.catalog : null,
        error: parsed.ok ? null : parsed.message,
        loaded: true,
        loading: false,
        epoch: at,
      });
    })
    .catch(() => {
      if (generation !== loadGeneration) return;
      publish({ catalog: null, error: null, loaded: true, loading: false, epoch: at });
    })
    .finally(() => {
      if (generation === loadGeneration) {
        loading = null;
        loadingEpoch = null;
      }
    });
  loading = request;
  return loading;
}

export function loadKnowledgeCatalog(epoch?: number): Promise<void> {
  return requestKnowledgeCatalog(epoch);
}

export function reloadKnowledgeCatalog(epoch?: number): Promise<void> {
  return requestKnowledgeCatalog(epoch, true);
}

export function resetKnowledgeCatalog(): void {
  loadGeneration += 1;
  loading = null;
  loadingEpoch = null;
  publish({ catalog: null, error: null, loaded: false, loading: false, epoch: null });
}

export function propertyDefinitionForKey(key: string) {
  return snapshot.catalog?.properties.find((definition) => definition.key === key) ?? null;
}

export function labelPresentation(value: string): { label: string; color?: string } {
  const definition = snapshot.catalog?.labels.find((label) => label.id === value);
  return definition
    ? { label: definition.name, ...(definition.color ? { color: definition.color } : {}) }
    : { label: value };
}
