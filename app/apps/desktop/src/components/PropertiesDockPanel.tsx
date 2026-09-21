import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Clock3,
  Database,
  FileText,
  History,
  Info,
  Link2,
  Plus,
  Search,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import type { PanelBodyProps } from "../layout/panelRegistry";
import {
  getActiveNote,
  getActiveNoteRevision,
  notifyActiveNoteChanged,
  subscribeActiveNote,
} from "../lib/editor/activeView";
import { findFrontmatter } from "../lib/editor/frontmatter";
import { parseFrontmatter } from "../lib/frontmatter/parse";
import * as ipc from "../lib/ipc";
import {
  decodeDocumentId,
  DOCUMENT_ID_KEY,
  editTokenForProperty,
  encodeRelationship,
  planKnowledgeChanges,
  RELATIONSHIPS_KEY,
  type KnowledgeChangePlan,
} from "../lib/knowledge";
import {
  getKnowledgeCatalogSnapshot,
  loadKnowledgeCatalog,
  subscribeKnowledgeCatalog,
} from "../lib/knowledge/catalogStore";
import { ensureWritableDocumentIdentity } from "../lib/knowledge/identityMutation";
import type { KnowledgeCatalogV1, RelationshipDefinition } from "../lib/knowledge/types";
import { noteLabel } from "../lib/notePath";
import { useStore } from "../store";
import { useLayoutStore } from "../layout/store";
import { MenuSelect } from "./MenuSelect";
import { PropertiesPanel } from "./properties/PropertiesPanel";

type RelationshipItem = Extract<ipc.LocalKnowledgeItem, { kind: "relationship" }>;
type BacklinkItem = Extract<ipc.LocalKnowledgeItem, { kind: "backlink" }>;

interface PagedItems<T> {
  items: T[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
}

interface InspectorData {
  meta: ipc.NoteMeta;
  outgoing: PagedItems<RelationshipItem>;
  incoming: PagedItems<RelationshipItem>;
  backlinks: PagedItems<BacklinkItem>;
  indexState: Extract<ipc.LocalKnowledgeItem, { kind: "indexState" }> | null;
}

type PagedSection = "outgoing" | "incoming" | "backlinks";

interface InspectorSnapshot {
  path: string | null;
  vaultEpoch: number | null;
  refreshRevision: number;
  load: InspectorLoad;
}

type InspectorLoad =
  | { status: "idle" | "loading"; data: null; error: null }
  | { status: "ready"; data: InspectorData; error: null }
  | { status: "error"; data: null; error: string };

const EMPTY_LOAD: InspectorLoad = { status: "idle", data: null, error: null };
const LOADING: InspectorLoad = { status: "loading", data: null, error: null };

function relationships(page: ipc.LocalKnowledgePage) {
  return page.items.filter(
    (item): item is Extract<ipc.LocalKnowledgeItem, { kind: "relationship" }> =>
      item.kind === "relationship",
  );
}

function backlinks(page: ipc.LocalKnowledgePage) {
  return page.items.filter(
    (item): item is BacklinkItem => item.kind === "backlink",
  );
}

function paged<T>(items: T[], nextCursor: string | null): PagedItems<T> {
  return { items, nextCursor, loading: false, error: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExpiredCursor(error: unknown): boolean {
  return errorMessage(error).startsWith("cursor_expired:");
}

function indexState(page: ipc.LocalKnowledgePage) {
  return page.items.find(
    (item): item is Extract<ipc.LocalKnowledgeItem, { kind: "indexState" }> =>
      item.kind === "indexState",
  ) ?? null;
}

function useInspectorData(
  path: string | null,
  vaultEpoch: number,
  refreshRevision: number,
): [InspectorLoad, (section: PagedSection) => Promise<void>] {
  const [snapshot, setSnapshot] = useState<InspectorSnapshot>({
    path: null,
    vaultEpoch: null,
    refreshRevision: 0,
    load: EMPTY_LOAD,
  });

  useEffect(() => {
    if (!path) {
      setSnapshot({ path: null, vaultEpoch: null, refreshRevision, load: EMPTY_LOAD });
      return;
    }

    let cancelled = false;
    setSnapshot({ path, vaultEpoch, refreshRevision, load: LOADING });
    void (async () => {
      try {
        const meta = await ipc.getNoteMeta(path, vaultEpoch);
        if (cancelled) return;
        if (!meta) throw new Error("The note is not in the local index.");

        const [outgoingPage, incomingPage, backlinksPage, indexPage] = await Promise.all([
          ipc.queryKnowledge(
            { kind: "relationships", noteId: meta.id, direction: "outgoing" },
            { limit: 50 },
          ),
          ipc.queryKnowledge(
            { kind: "relationships", noteId: meta.id, direction: "incoming" },
            { limit: 50 },
          ),
          ipc.queryKnowledge({ kind: "backlinks", noteId: meta.id }, { limit: 50 }),
          ipc.queryKnowledge({ kind: "indexState", noteId: meta.id }, { limit: 1 }),
        ]);
        if (cancelled) return;
        setSnapshot({
          path,
          vaultEpoch,
          refreshRevision,
          load: {
            status: "ready",
            data: {
              meta,
              outgoing: paged(relationships(outgoingPage), outgoingPage.nextCursor),
              incoming: paged(relationships(incomingPage), incomingPage.nextCursor),
              backlinks: paged(backlinks(backlinksPage), backlinksPage.nextCursor),
              indexState: indexState(indexPage),
            },
            error: null,
          },
        });
      } catch (error) {
        if (cancelled) return;
        setSnapshot({
          path,
          vaultEpoch,
          refreshRevision,
          load: {
            status: "error",
            data: null,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, vaultEpoch, refreshRevision]);

  const loadMore = useCallback(async (section: PagedSection) => {
    const current = snapshot.path === path
      && snapshot.vaultEpoch === vaultEpoch
      && snapshot.refreshRevision === refreshRevision
      && snapshot.load.data
      ? snapshot.load.data
      : null;
    const page = current?.[section];
    if (!path || !current || !page?.nextCursor || page.loading) return;
    const cursor = page.nextCursor;
    const noteId = current.meta.id;
    const query: ipc.LocalKnowledgeQuery = section === "backlinks"
      ? { kind: "backlinks", noteId }
      : { kind: "relationships", noteId, direction: section };
    setSnapshot((value) => {
      if (
        value.path !== path
        || value.vaultEpoch !== vaultEpoch
        || value.refreshRevision !== refreshRevision
        || value.load.status !== "ready"
        || value.load.data.meta.id !== noteId
        || value.load.data[section].nextCursor !== cursor
      ) return value;
      return {
        ...value,
        load: {
          ...value.load,
          data: {
            ...value.load.data,
            [section]: { ...value.load.data[section], loading: true, error: null },
          },
        },
      };
    });
    try {
      const next = await ipc.queryKnowledge(query, { limit: 50, cursor });
      const nextItems = section === "backlinks" ? backlinks(next) : relationships(next);
      setSnapshot((value) => {
        if (
          value.path !== path
          || value.vaultEpoch !== vaultEpoch
          || value.refreshRevision !== refreshRevision
          || value.load.status !== "ready"
          || value.load.data.meta.id !== noteId
        ) return value;
        const prior = value.load.data[section];
        if (prior.nextCursor !== cursor) return value;
        return {
          ...value,
          load: {
            ...value.load,
            data: {
              ...value.load.data,
              [section]: {
                items: [...prior.items, ...nextItems],
                nextCursor: next.nextCursor,
                loading: false,
                error: null,
              },
            },
          },
        };
      });
    } catch (error) {
      if (isExpiredCursor(error)) {
        try {
          const fresh = await ipc.queryKnowledge(query, { limit: 50 });
          const freshItems = section === "backlinks" ? backlinks(fresh) : relationships(fresh);
          setSnapshot((value) => {
            if (
              value.path !== path
              || value.vaultEpoch !== vaultEpoch
              || value.refreshRevision !== refreshRevision
              || value.load.status !== "ready"
              || value.load.data.meta.id !== noteId
            ) return value;
            const prior = value.load.data[section];
            if (prior.nextCursor !== cursor) return value;
            return {
              ...value,
              load: {
                ...value.load,
                data: {
                  ...value.load.data,
                  [section]: {
                    items: freshItems,
                    nextCursor: fresh.nextCursor,
                    loading: false,
                    error: null,
                  },
                },
              },
            };
          });
          return;
        } catch (recoveryError) {
          error = recoveryError;
        }
      }
      setSnapshot((value) => {
        if (
          value.path !== path
          || value.vaultEpoch !== vaultEpoch
          || value.refreshRevision !== refreshRevision
          || value.load.status !== "ready"
          || value.load.data.meta.id !== noteId
        ) return value;
        return {
          ...value,
          load: {
            ...value.load,
            data: {
              ...value.load.data,
              [section]: {
                ...value.load.data[section],
                loading: false,
                error: errorMessage(error),
              },
            },
          },
        };
      });
    }
  }, [path, refreshRevision, snapshot, vaultEpoch]);

  const current = snapshot.path === path
    && snapshot.vaultEpoch === vaultEpoch
    && snapshot.refreshRevision === refreshRevision;
  return [current ? snapshot.load : path ? LOADING : EMPTY_LOAD, loadMore];
}

function Section({
  icon,
  title,
  count,
  children,
}: {
  icon: ReactNode;
  title: string;
  count?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="properties-inspector-section">
      <header className="properties-inspector-heading">
        <span className="properties-inspector-heading-icon" aria-hidden="true">{icon}</span>
        <h2>{title}</h2>
        {count != null && <span className="properties-inspector-count">{count}</span>}
      </header>
      <div className="properties-inspector-section-body">{children}</div>
    </section>
  );
}

function relationshipName(
  catalog: KnowledgeCatalogV1 | null,
  relationshipId: string,
  direction: ipc.KnowledgeRelationshipDirection,
): string {
  const definition: RelationshipDefinition | undefined = catalog?.relationships.find(
    (candidate) => candidate.id === relationshipId,
  );
  if (!definition) return relationshipId;
  return direction === "incoming" && definition.inverseName
    ? definition.inverseName
    : definition.name;
}

function liveDocumentId(view: EditorView): string | null {
  const frontmatter = findFrontmatter(view.state.doc);
  if (!frontmatter) return null;
  const parsed = parseFrontmatter(view.state.doc, frontmatter);
  if (!parsed.ok) return null;
  const identity = parsed.entries.find((entry) => entry.key === DOCUMENT_ID_KEY);
  return identity?.value.kind === "text" ? decodeDocumentId(identity.value.value) : null;
}

function dispatchKnowledgePlan(view: EditorView, plan: KnowledgeChangePlan): void {
  if (view.state.readOnly || plan.changes.length === 0) return;
  view.dispatch({
    changes: plan.changes,
    annotations: Transaction.userEvent.of("input.properties.relationship"),
    scrollIntoView: false,
  });
  // The production editor publishes this from its update listener. Calling it
  // here too keeps an out-of-tree dock bound to the same transaction and makes
  // the contract explicit for lightweight editor/test hosts.
  notifyActiveNoteChanged();
}

function RelationshipComposer({
  view,
  sourcePath,
  catalog,
  vaultEpoch,
  onMutated,
}: {
  view: EditorView;
  sourcePath: string;
  catalog: KnowledgeCatalogV1;
  vaultEpoch: number;
  onMutated: () => void;
}) {
  const relationships = catalog.relationships;
  const [open, setOpen] = useState(false);
  const [relationshipId, setRelationshipId] = useState(relationships[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ipc.SearchResult[]>([]);
  const [pending, setPending] = useState(false);
  const [savingPath, setSavingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchGeneration = useRef(0);

  useEffect(() => {
    if (relationships.some((definition) => definition.id === relationshipId)) return;
    setRelationshipId(relationships[0]?.id ?? "");
  }, [relationshipId, relationships]);

  useEffect(() => {
    const trimmed = query.trim();
    const request = ++searchGeneration.current;
    if (!open || !trimmed) {
      setResults([]);
      setPending(false);
      return;
    }
    setPending(true);
    const timer = window.setTimeout(() => {
      void ipc.searchNotes(trimmed).then(
        (matches) => {
          if (request !== searchGeneration.current) return;
          const epoch = useStore.getState().vault?.epoch;
          if (epoch != null && epoch !== vaultEpoch) return;
          setResults(matches.filter((match) => match.path !== sourcePath).slice(0, 20));
          setPending(false);
        },
        (reason) => {
          if (request !== searchGeneration.current) return;
          setResults([]);
          setPending(false);
          setError(reason instanceof Error ? reason.message : String(reason));
        },
      );
    }, 160);
    return () => window.clearTimeout(timer);
  }, [open, query, sourcePath, vaultEpoch]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setResults([]);
    setError(null);
  };

  const add = async (target: ipc.SearchResult) => {
    if (!relationshipId || savingPath) return;
    setSavingPath(target.path);
    setError(null);
    try {
      const sourceId = liveDocumentId(view) ?? crypto.randomUUID();
      let targetId = sourceId;
      if (target.path !== sourcePath) {
        const targetMeta = await ipc.getNoteMeta(target.path, vaultEpoch);
        if (!targetMeta) throw new Error("The target note is no longer available.");
        const identity = await ensureWritableDocumentIdentity({
          path: target.path,
          expectedSourceRevision: targetMeta.sha256,
          expectedEpoch: vaultEpoch,
        });
        targetId = identity.documentId;
      }
      const currentActive = getActiveNote();
      const currentEpoch = useStore.getState().vault?.epoch;
      if (
        currentActive?.path !== sourcePath ||
        currentActive.editorView !== view ||
        (currentEpoch != null && currentEpoch !== vaultEpoch)
      ) {
        throw new Error("The active note or vault changed before the relationship was added.");
      }
      const latestCatalog = getKnowledgeCatalogSnapshot().catalog;
      if (!latestCatalog?.relationships.some((definition) => definition.id === relationshipId)) {
        throw new Error("That relationship type changed. Choose a current type and try again.");
      }
      const current = view.state.doc.toString();
      const plan = planKnowledgeChanges(current, latestCatalog, {
        docId: sourceId,
        changes: [{
          kind: "addRelationship",
          relationshipId,
          targetDocId: targetId,
          expected: editTokenForProperty(current, RELATIONSHIPS_KEY),
        }],
      });
      dispatchKnowledgePlan(view, plan);
      onMutated();
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingPath(null);
    }
  };

  if (relationships.length === 0) {
    return (
      <p className="properties-inspector-empty">
        Add a relationship type in _Noam/Knowledge schema.md to connect notes.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="properties-relationship-add"
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden="true" /> Add relationship
      </button>
    );
  }

  return (
    <div className="properties-relationship-composer">
      <div className="properties-relationship-composer-head">
        <MenuSelect
          value={relationshipId}
          options={relationships.map((definition) => ({
            value: definition.id,
            label: definition.name,
            hint: definition.inverseName,
          }))}
          onSelect={setRelationshipId}
          ariaLabel="Relationship type"
          triggerClassName="properties-relationship-type"
        />
        <button
          type="button"
          className="properties-relationship-close"
          aria-label="Cancel adding relationship"
          onClick={close}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <label className="properties-relationship-search">
        <Search aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setError(null);
          }}
          placeholder="Find a note…"
          aria-label="Find a note to relate"
          autoFocus
        />
      </label>
      {error && <p className="properties-relationship-error" role="alert">{error}</p>}
      {query.trim() && (
        <ul className="properties-relationship-results" aria-busy={pending || undefined}>
          {!pending && results.length === 0 && (
            <li className="properties-inspector-empty">No matching notes</li>
          )}
          {results.map((result) => (
            <li key={result.id}>
              <button
                type="button"
                disabled={savingPath != null}
                onClick={() => void add(result)}
                title={result.path}
              >
                <FileText aria-hidden="true" />
                <span>
                  <strong>{noteLabel(result.path)}</strong>
                  <small>{result.path}</small>
                </span>
                {savingPath === result.path && <span>Adding…</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RelationshipRow({
  item,
  direction,
  catalog,
  onOpenNote,
  onRemove,
}: {
  item: Extract<ipc.LocalKnowledgeItem, { kind: "relationship" }>;
  direction: ipc.KnowledgeRelationshipDirection;
  catalog: KnowledgeCatalogV1 | null;
  onOpenNote: (path: string) => void;
  onRemove?: (item: Extract<ipc.LocalKnowledgeItem, { kind: "relationship" }>) => void;
}) {
  const resolvedPath = direction === "outgoing" ? item.targetPath : item.sourcePath;
  const resolved = item.resolution === "resolved" && resolvedPath != null;
  const label = resolvedPath ? noteLabel(resolvedPath) : item.targetDocumentId;
  const name = relationshipName(catalog, item.relationshipId, direction);
  const identifiers = {
    "data-edge-id": item.edgeId,
    "data-relationship-id": item.relationshipId,
    "data-target-document-id": item.targetDocumentId,
    "data-resolution": item.resolution,
    ...(resolvedPath ? { "data-resolved-path": resolvedPath } : {}),
  };
  const content = (
    <>
      <span className="properties-inspector-row-icon" aria-hidden="true">
        {direction === "outgoing" ? <ArrowUpRight /> : <ArrowDownLeft />}
      </span>
      <span className="properties-inspector-row-copy">
        <span className="properties-inspector-row-title">{label}</span>
        <span className="properties-inspector-row-detail">{name}</span>
      </span>
      {!resolved && (
        <span className={`properties-inspector-resolution is-${item.resolution}`}>
          {item.resolution === "duplicate_document_identity" ? "Duplicate identity" : "Missing note"}
        </span>
      )}
    </>
  );

  return (
    <li>
      <div
        className={`properties-relationship-row${onRemove ? " has-remove" : ""}`}
        {...identifiers}
      >
        {resolved ? (
          <button
            type="button"
            className="properties-inspector-row is-action"
            title={resolvedPath}
            onClick={() => onOpenNote(resolvedPath)}
          >
            {content}
          </button>
        ) : (
          <div
            className="properties-inspector-row is-unresolved"
            title={item.targetDocumentId}
          >
            {content}
          </div>
        )}
        {onRemove && (
          <button
            type="button"
            className="properties-relationship-remove"
            aria-label={`Remove ${name} relationship to ${label}`}
            title="Remove relationship"
            onClick={() => onRemove(item)}
          >
            <Trash2 aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
}

function RelationshipGroup({
  label,
  direction,
  page,
  catalog,
  onOpenNote,
  onRemove,
  onLoadMore,
}: {
  label: string;
  direction: ipc.KnowledgeRelationshipDirection;
  page: PagedItems<RelationshipItem>;
  catalog: KnowledgeCatalogV1 | null;
  onOpenNote: (path: string) => void;
  onRemove?: (item: RelationshipItem) => void;
  onLoadMore: () => void;
}) {
  return (
    <div className="properties-inspector-group">
      <h3>
        <span>{label}</span>
        <span>{page.items.length}{page.nextCursor ? "+" : ""}</span>
      </h3>
      {page.items.length === 0 ? (
        <p className="properties-inspector-empty">None</p>
      ) : (
        <ul className="properties-inspector-list">
          {page.items.map((item) => (
            <RelationshipRow
              key={`${item.sourceNoteId}:${item.edgeId}:${item.ordinal}`}
              item={item}
              direction={direction}
              catalog={catalog}
              onOpenNote={onOpenNote}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
      {page.nextCursor && (
        <button
          type="button"
          className="properties-inspector-load-more"
          disabled={page.loading}
          onClick={onLoadMore}
        >
          {page.loading ? "Loading..." : `Load more ${label.toLocaleLowerCase()}`}
        </button>
      )}
      {page.error && <p className="properties-relationship-error" role="alert">{page.error}</p>}
    </div>
  );
}

function displayStatus(value: string): string {
  return value
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part[0]?.toLocaleUpperCase() + part.slice(1))
    .join(" ");
}

function syncStatusLabel(status: string): string {
  switch (status) {
    case "synced": return "Synced";
    case "read-only": return "Read-only";
    case "connecting": return "Syncing";
    case "no-access": return "No access";
    case "deleted": return "Deleted";
    case "too-large": return "Too large to sync";
    case "error": return "Retrying";
    default: return "Offline";
  }
}

/**
 * Docked projection of the live note's Properties editor plus read-only note
 * context from the local knowledge index.
 *
 * The editor still receives the same EditorView as the inline panel. The
 * relationship composer applies frontmatter changes through that live editor;
 * the other knowledge rows only inspect and navigate.
 */
export function formatModified(mtime: number): string {
  if (!mtime) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(mtime * 1_000));
}

export function PropertiesDockPanel({
  activeNotePath,
  vaultEpoch,
  onOpenNote,
}: PanelBodyProps) {
  const activeRevision = useSyncExternalStore(
    subscribeActiveNote,
    getActiveNoteRevision,
    getActiveNoteRevision,
  );
  const catalogSnapshot = useSyncExternalStore(
    subscribeKnowledgeCatalog,
    getKnowledgeCatalogSnapshot,
    getKnowledgeCatalogSnapshot,
  );
  const syncEnabled = useStore((state) => state.syncEnabled);
  const syncStatus = useStore((state) => state.syncStatus);
  const historyDocId = useStore((state) =>
    activeNotePath ? (state.docIdByPath[activeNotePath] ?? null) : null,
  );
  const noamHistory = syncEnabled && historyDocId != null;
  const [indexRefresh, setIndexRefresh] = useState(0);
  const [relationshipError, setRelationshipError] = useState<string | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const active = getActiveNote();
  const matchingPath = activeNotePath && active?.path === activeNotePath ? activeNotePath : null;
  const [load, loadMore] = useInspectorData(matchingPath, vaultEpoch, indexRefresh);

  useEffect(() => {
    setRelationshipError(null);
    if (matchingPath) void loadKnowledgeCatalog(vaultEpoch);
  }, [matchingPath, vaultEpoch]);

  useEffect(() => {
    if (!matchingPath) return;
    // The live editor changes immediately; its derived SQLite projection lands
    // after the normal persistence debounce. Re-read once that projection has
    // had time to catch up, so an add/remove appears without reopening the pane.
    if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      setIndexRefresh((revision) => revision + 1);
      refreshTimer.current = null;
    }, 450);
    return () => {
      if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    };
  }, [activeRevision, matchingPath]);

  if (!matchingPath || !active) {
    return (
      <div className="workspace-panel-empty">
        Open a Markdown note to inspect its properties.
      </div>
    );
  }

  const view = active.editorView as EditorView;
  const relationshipCount = load.data
    ? `${load.data.outgoing.items.length + load.data.incoming.items.length}${
        load.data.outgoing.nextCursor || load.data.incoming.nextCursor ? "+" : ""
      }`
    : undefined;
  const index = load.data?.indexState ?? null;
  const catalog = catalogSnapshot.loaded
    && !catalogSnapshot.loading
    && !catalogSnapshot.error
    && catalogSnapshot.epoch === vaultEpoch
    ? catalogSnapshot.catalog
    : null;
  const refreshSoon = () => {
    setIndexRefresh((revision) => revision + 1);
    if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      setIndexRefresh((revision) => revision + 1);
      refreshTimer.current = null;
    }, 450);
  };
  const removeRelationship = (
    item: RelationshipItem,
  ) => {
    if (!catalog) return;
    setRelationshipError(null);
    try {
      const current = view.state.doc.toString();
      const docId = liveDocumentId(view) ?? crypto.randomUUID();
      const edgeId = encodeRelationship({
        relationshipId: item.relationshipId,
        targetDocId: item.targetDocumentId,
      });
      const plan = planKnowledgeChanges(current, catalog, {
        docId,
        changes: [{
          kind: "removeRelationship",
          edgeId,
          expected: editTokenForProperty(current, RELATIONSHIPS_KEY),
        }],
      });
      dispatchKnowledgePlan(view, plan);
      refreshSoon();
    } catch (reason) {
      setRelationshipError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="properties-dock properties-inspector" data-note-path={activeNotePath}>
      <Section icon={<Tags />} title="Properties">
        <PropertiesPanel
          view={view}
          readOnly={!active.editable()}
          collapsed={false}
          onCollapsedChange={() => {}}
          showHeader={false}
        />
      </Section>

      <Section icon={<Link2 />} title="Relationships" count={relationshipCount}>
        {load.data ? (
          <>
            <RelationshipGroup
              label="Outgoing"
              direction="outgoing"
              page={load.data.outgoing}
              catalog={catalog}
              onOpenNote={onOpenNote}
              onRemove={active.editable() ? removeRelationship : undefined}
              onLoadMore={() => void loadMore("outgoing")}
            />
            <RelationshipGroup
              label="Incoming"
              direction="incoming"
              page={load.data.incoming}
              catalog={catalog}
              onOpenNote={onOpenNote}
              onLoadMore={() => void loadMore("incoming")}
            />
            {active.editable() && catalog && (
              <RelationshipComposer
                view={view}
                sourcePath={matchingPath}
                catalog={catalog}
                vaultEpoch={vaultEpoch}
                onMutated={refreshSoon}
              />
            )}
            {relationshipError && (
              <p className="properties-relationship-error" role="alert">
                {relationshipError}
              </p>
            )}
          </>
        ) : load.status === "error" ? (
          <p className="properties-inspector-empty is-error">{load.error}</p>
        ) : (
          <p className="properties-inspector-empty" role="status">Loading note details...</p>
        )}
      </Section>

      <Section
        icon={<Link2 />}
        title="Backlinks"
        count={load.data
          ? `${load.data.backlinks.items.length}${load.data.backlinks.nextCursor ? "+" : ""}`
          : undefined}
      >
        {load.status === "error" ? (
          <p className="properties-inspector-empty is-error">{load.error}</p>
        ) : !load.data ? (
          <p className="properties-inspector-empty" role="status">Loading backlinks...</p>
        ) : load.data.backlinks.items.length === 0 ? (
          <p className="properties-inspector-empty">None</p>
        ) : (
          <>
            <ul className="properties-inspector-list">
              {load.data.backlinks.items.map((backlink) => (
                <li key={backlink.backlinkId}>
                  <button
                    type="button"
                    className="properties-inspector-row is-action"
                    title={backlink.sourcePath}
                    onClick={() => onOpenNote(backlink.sourcePath)}
                  >
                    <span className="properties-inspector-row-icon" aria-hidden="true"><FileText /></span>
                    <span className="properties-inspector-row-copy">
                      <span className="properties-inspector-row-title">{noteLabel(backlink.sourcePath)}</span>
                      {backlink.linkText && (
                        <span className="properties-inspector-row-detail">{backlink.linkText}</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {load.data.backlinks.nextCursor && (
              <button
                type="button"
                className="properties-inspector-load-more"
                disabled={load.data.backlinks.loading}
                onClick={() => void loadMore("backlinks")}
              >
                {load.data.backlinks.loading ? "Loading..." : "Load more backlinks"}
              </button>
            )}
            {load.data.backlinks.error && (
              <p className="properties-relationship-error" role="alert">
                {load.data.backlinks.error}
              </p>
            )}
          </>
        )}
      </Section>

      <Section icon={<Info />} title="Note info">
        {load.data ? (
          <dl className="properties-inspector-facts">
            <div><dt>File</dt><dd>{load.data.meta.path}</dd></div>
            <div><dt>Modified</dt><dd>{formatModified(load.data.meta.mtime)}</dd></div>
            {(load.data.meta.kind || load.data.meta.type) && (
              <div><dt>Type</dt><dd>{load.data.meta.kind ?? load.data.meta.type}</dd></div>
            )}
            <div>
              <dt>Document ID</dt>
              <dd>{index?.portableDocumentId ?? "None"}</dd>
            </div>
            <div>
              <dt>Identity</dt>
              <dd>{index ? displayStatus(index.identityStatus) : "Not indexed"}</dd>
            </div>
            <div>
              <dt>Index</dt>
              <dd className="properties-inspector-status">
                <Database aria-hidden="true" />
                {index ? displayStatus(index.indexStatus) : "Not indexed"}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="properties-inspector-empty">Waiting for note details</p>
        )}
      </Section>

      <Section icon={<History />} title="History & status">
        <dl className="properties-inspector-facts">
          <div>
            <dt>Provider</dt>
            <dd className="properties-inspector-provider">
              <Clock3 aria-hidden="true" />
              {noamHistory ? "Noam version history" : "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{noamHistory
              ? syncStatusLabel(syncStatus)
              : "No version history is available for this note."}</dd>
          </div>
        </dl>
        {noamHistory && historyDocId && (
          <button
            type="button"
            className="properties-inspector-load-more"
            onClick={() => {
              useLayoutStore.getState().dispatch({
                type: "open-panel",
                panelType: "history",
                zone: "right",
              });
              void useStore.getState().openVersionPanel(historyDocId);
            }}
          >
            Open version history
          </button>
        )}
      </Section>
    </div>
  );
}
