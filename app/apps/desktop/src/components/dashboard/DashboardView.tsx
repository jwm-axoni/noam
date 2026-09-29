// One dashboard view: its own query, its own loading and error state.
//
// Rendering rules (security posture, plan Part 2): every value is a React
// TEXT node — no markup from a note is ever interpreted, nothing is
// evaluated, and there is no iframe. Links open notes through the app.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  buildView,
  cellValue,
  isBlocked,
  resolveColumns,
  runView,
  sortRows,
  type Column,
  type DashboardViewSpec,
  type ViewDeps,
  type ViewIssue,
  type ViewRow,
} from "../../lib/dashboard";
import type { KnowledgeCatalogV1 } from "../../lib/knowledge/types";
import { fullDate, nextCardIndex, relativeDate } from "../../lib/gallery/cards";
import { NoteCardFace } from "../gallery/NoteCard";

export interface DashboardViewProps {
  spec: DashboardViewSpec;
  catalog: KnowledgeCatalogV1;
  /** Bumped by the host on every (debounced) watcher batch: re-run. */
  refresh: number;
  deps: ViewDeps;
  vaultPath: string | null;
  onOpen: (path: string) => void;
}

interface RunState {
  status: "loading" | "ready" | "error";
  rows: ViewRow[];
  nextCursor: string | null;
  error: string | null;
  runIssues: ViewIssue[];
}

const INITIAL: RunState = { status: "loading", rows: [], nextCursor: null, error: null, runIssues: [] };

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^[a-z_]+:\s*/, "");
}

export function DashboardView({ spec, catalog, refresh, deps, vaultPath, onOpen }: DashboardViewProps) {
  // For display (issues). Each RUN builds again, so relative dates resolve
  // against the clock of that run.
  const built = useMemo(() => buildView(spec, { catalog, now: new Date() }), [spec, catalog]);
  const columns = useMemo(() => resolveColumns(spec, catalog), [spec, catalog]);
  const labelName = useMemo(() => {
    const names = new Map(catalog.labels.map((label) => [label.id, label.name] as const));
    return (id: string) => names.get(id) ?? id;
  }, [catalog]);

  const [state, setState] = useState<RunState>(INITIAL);
  /** How many rows the user has asked to see ("Show more" grows it). */
  const want = useRef(spec.limit);
  /** The build the current cursor belongs to. */
  const lastBuilt = useRef(built);
  const ticket = useRef(0);

  // (Re)run from scratch: first paint, a spec/catalog change, a watcher batch.
  useEffect(() => {
    const fresh = buildView(spec, { catalog, now: new Date() });
    lastBuilt.current = fresh;
    const mine = ++ticket.current;
    if (fresh.blocked) {
      setState({ ...INITIAL, status: "ready" });
      return;
    }
    // Keep the rows on screen while a refresh runs; only a first run shows "Loading".
    runView(fresh, want.current, deps).then(
      (run) => {
        if (mine !== ticket.current) return;
        setState({ status: "ready", rows: run.rows, nextCursor: run.nextCursor, error: null, runIssues: run.issues });
      },
      (error: unknown) => {
        if (mine !== ticket.current) return;
        setState({ ...INITIAL, status: "error", error: errorText(error) });
      },
    );
  }, [spec, catalog, refresh, deps]);

  const showMore = () => {
    const cursor = state.nextCursor;
    if (!cursor) return;
    const nextWant = state.rows.length + spec.limit;
    want.current = nextWant;
    const current = lastBuilt.current;
    const mine = ++ticket.current;
    const fail = (error: unknown) => {
      if (mine !== ticket.current) return;
      setState({ ...INITIAL, status: "error", error: errorText(error) });
    };
    runView(current, spec.limit, deps, cursor).then(
      (run) => {
        if (mine !== ticket.current) return;
        setState((prev) => ({ ...prev, rows: [...prev.rows, ...run.rows], nextCursor: run.nextCursor }));
      },
      // The index moved on under the cursor (a new generation): start over.
      () =>
        runView(current, nextWant, deps).then((run) => {
          if (mine !== ticket.current) return;
          setState({ status: "ready", rows: run.rows, nextCursor: run.nextCursor, error: null, runIssues: run.issues });
        }, fail),
    );
  };

  const issues = [...built.issues, ...state.runIssues];
  const blocked = isBlocked({ issues: built.issues });
  const title = spec.title ?? (spec.view === "table" ? "Table" : "Notes");

  let body;
  if (blocked) {
    body = <div className="dashboard-blocked">This view shows nothing until the problem above is fixed, rather than guess.</div>;
  } else if (state.status === "error") {
    body = <div className="dashboard-error" role="alert">Couldn't run this view. {state.error}</div>;
  } else if (state.status === "loading") {
    body = <div className="dashboard-loading">Loading…</div>;
  } else if (state.rows.length === 0) {
    body = <div className="dashboard-no-match">No notes match</div>;
  } else if (spec.view === "table") {
    body = <TableBody rows={state.rows} columns={columns} labelName={labelName} onOpen={onOpen} />;
  } else {
    body = <CardsBody rows={state.rows} vaultPath={vaultPath} onOpen={onOpen} />;
  }

  return (
    <section
      className={`dashboard-view is-${spec.width} is-${spec.view}`}
      aria-label={title}
      data-view-index={spec.index}
    >
      <header className="dashboard-view-head">
        <h3 className="dashboard-view-title">{title}</h3>
      </header>
      {issues.length > 0 && (
        <ul className="dashboard-issues">
          {issues.map((issue, i) => (
            <li key={i} className={`dashboard-issue is-${issue.severity}`}>
              {issue.line !== null ? `Line ${issue.line + 1}: ` : ""}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      {body}
      {!blocked && state.status === "ready" && state.nextCursor && (
        <footer className="dashboard-view-foot">
          <span className="dashboard-count">
            Showing {state.rows.length} of {state.rows.length + 1}+
          </span>
          <button type="button" className="dashboard-more" onClick={showMore}>
            Show more
          </button>
        </footer>
      )}
    </section>
  );
}

function CardsBody({
  rows,
  vaultPath,
  onOpen,
}: {
  rows: ViewRow[];
  vaultPath: string | null;
  onOpen: (path: string) => void;
}) {
  const grid = useRef<HTMLDivElement | null>(null);
  const [activeRaw, setActive] = useState(0);
  const active = Math.max(0, Math.min(activeRaw, rows.length - 1));
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const el = grid.current;
    if (!el) return;
    const columns = getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length;
    const next = nextCardIndex(event.key, active, rows.length, columns);
    if (next == null) return;
    event.preventDefault();
    setActive(next);
    el.querySelector<HTMLElement>(`[data-card-index="${next}"]`)?.focus();
  };
  return (
    <div className="gallery-grid dashboard-grid" role="list" ref={grid} onKeyDown={onKey}>
      {rows.map(({ entry, card }, index) => (
        <div role="listitem" key={entry.noteId} className="gallery-cell">
          <button
            type="button"
            data-card-index={index}
            tabIndex={index === active ? 0 : -1}
            className={`gallery-card is-note${card?.empty ? " is-empty" : ""}`}
            title={entry.path}
            onFocus={() => setActive(index)}
            onClick={() => onOpen(entry.path)}
          >
            <NoteCardFace
              vaultPath={vaultPath}
              card={{
                name: entry.name,
                excerpt: card?.excerpt ?? null,
                firstImage: card?.firstImage ?? null,
                modified: entry.modified,
                empty: card?.empty ?? false,
              }}
            />
          </button>
        </div>
      ))}
    </div>
  );
}

function TableBody({
  rows,
  columns,
  labelName,
  onOpen,
}: {
  rows: ViewRow[];
  columns: Column[];
  labelName: (id: string) => string;
  onOpen: (path: string) => void;
}) {
  // Session-only: a header click re-sorts what is on screen; it never writes the note.
  const [order, setOrder] = useState<{ key: string; direction: "asc" | "desc" } | null>(null);
  const sorted = useMemo(() => {
    const column = order ? columns.find((c) => c.key === order.key) : undefined;
    return column && order ? sortRows(rows, column, order.direction, labelName) : rows;
  }, [rows, columns, order, labelName]);
  const now = Date.now();

  const clickHeader = (column: Column) =>
    setOrder((prev) =>
      prev?.key === column.key
        ? { key: column.key, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { key: column.key, direction: "asc" },
    );

  return (
    <div className="dashboard-table-wrap">
      <table className="dashboard-table">
        <thead>
          <tr>
            {columns.map((column) => {
              const sortedBy = order?.key === column.key ? order.direction : null;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={sortedBy === "asc" ? "ascending" : sortedBy === "desc" ? "descending" : "none"}
                >
                  <button type="button" className="dashboard-th" onClick={() => clickHeader(column)}>
                    {column.label}
                    {sortedBy && <span aria-hidden="true">{sortedBy === "asc" ? " ↑" : " ↓"}</span>}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.entry.noteId} className="dashboard-row">
              {columns.map((column) => (
                <td key={column.key}>
                  <Cell row={row} column={column} labelName={labelName} onOpen={onOpen} now={now} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({
  row,
  column,
  labelName,
  onOpen,
  now,
}: {
  row: ViewRow;
  column: Column;
  labelName: (id: string) => string;
  onOpen: (path: string) => void;
  now: number;
}) {
  if (column.kind === "name") {
    return (
      <button type="button" className="dashboard-link" title={row.entry.path} onClick={() => onOpen(row.entry.path)}>
        {row.entry.name}
      </button>
    );
  }
  const value = cellValue(row, column, labelName);
  if (value.kind === "date") {
    if (!value.ms) return null;
    return <span title={fullDate(value.ms)}>{relativeDate(value.ms, now)}</span>;
  }
  if (value.kind === "links") {
    return (
      <>
        {value.links.map((link, i) => (
          <span key={i}>
            {i > 0 && ", "}
            {link.path ? (
              <button type="button" className="dashboard-link" title={link.path} onClick={() => onOpen(link.path!)}>
                {link.label}
              </button>
            ) : (
              <span className="dashboard-missing">{link.label}</span>
            )}
          </span>
        ))}
      </>
    );
  }
  return <>{value.text}</>;
}
