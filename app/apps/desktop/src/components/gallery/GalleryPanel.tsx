// The folder gallery (plan `docs/PLAN-INTERACTIVE-VIEWS.md` Part 3): one
// folder's direct children as a grid of cards.
//
// Everything a card shows comes from the index (`list_folder_cards`), never
// from rendering markdown here: the excerpt and first image were derived when
// the note was indexed. Card order is the sidebar's (`orderCards` runs the
// folder through `sortTree` + `applyOrder`), so the two views always agree.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { PanelBodyProps } from "../../layout/panelRegistry";
import { useLayoutStore } from "../../layout/store";
import * as ipc from "../../lib/ipc";
import type { FolderCard, FolderCardNote } from "../../lib/ipc";
import { resolveVaultAsset } from "../../lib/fileTypes/assetResolver";
import { breadcrumbs, fullDate, nextCardIndex, orderCards, relativeDate } from "../../lib/gallery/cards";
import { retargetGallery } from "../../lib/gallery/open";
import { galleryFolder } from "../../lib/gallery/panelState";
import { treeSortLabel } from "../../lib/tree/sort";
import { useStore } from "../../store";
import "./gallery.css";

/** Batched watcher events settle for this long before the grid re-reads. */
const REFRESH_DEBOUNCE_MS = 250;
/** Start loading a thumbnail this far before it scrolls into view. */
const THUMB_ROOT_MARGIN = "400px 0px";

type Observe = (el: Element, onNear: () => void) => () => void;
const NearViewport = createContext<Observe | null>(null);

/** Does a watcher change touch what this gallery shows? */
function touches(folder: string, path: string): boolean {
  if (!folder) return true;
  return path === folder || path.startsWith(`${folder}/`) || folder.startsWith(`${path}/`);
}

export function GalleryPanel({ instanceId, vaultEpoch, visible, onOpenNote, onRequestClose }: PanelBodyProps) {
  const folder = useLayoutStore((s) => galleryFolder(s.layout.panels[instanceId]?.state));
  const vaultPath = useStore((s) => s.vault?.path ?? null);
  const vaultName = useStore((s) => s.vault?.name ?? "Vault");
  const treeSort = useStore((s) => s.treeSort);
  const folderSorts = useStore((s) => s.folderSorts);
  const itemOrder = useStore((s) => s.itemOrder);
  // Filled only while a Created sort is active (see `lib/tree/createdTimes`).
  const createdTimes = useStore((s) => s.createdTimes);
  const setFolderView = useStore((s) => s.setFolderView);

  // undefined: loading; null: the folder is gone.
  const [cards, setCards] = useState<FolderCard[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(() => {
    const ticket = ++request.current;
    ipc.listFolderCards(folder, vaultEpoch).then(
      (next) => {
        if (ticket !== request.current) return;
        setCards(next);
        setError(null);
      },
      (e: unknown) => {
        if (ticket !== request.current) return;
        setError(String(e));
      },
    );
  }, [folder, vaultEpoch]);

  useEffect(() => {
    setCards(undefined);
    load();
  }, [load]);

  // Re-read on watcher batches that touch this folder, debounced. A batch that
  // arrives while the tab is hidden marks it stale; showing it re-reads once.
  const stale = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void ipc
      .onFilesChanged((changes) => {
        if (!changes.some((c) => touches(folder, c.path))) return;
        if (!visibleRef.current) {
          stale.current = true;
          return;
        }
        if (timer) clearTimeout(timer);
        timer = setTimeout(load, REFRESH_DEBOUNCE_MS);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* no Tauri runtime (tests) — the gallery just does not live-refresh */
      });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [folder, load]);
  useEffect(() => {
    if (visible && stale.current) {
      stale.current = false;
      load();
    }
  }, [visible, load]);

  const ordered = useMemo(
    () => (cards ? orderCards(cards, folder, treeSort, folderSorts, itemOrder, createdTimes) : []),
    [cards, folder, treeSort, folderSorts, itemOrder, createdTimes],
  );

  // One IntersectionObserver per panel, rooted at the scroller, so a folder of
  // hundreds of notes only decodes the thumbnails near the viewport.
  const scroller = useRef<HTMLDivElement | null>(null);
  const [observe, setObserve] = useState<Observe | null>(null);
  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof IntersectionObserver === "undefined") {
      setObserve(() => (_el: Element, onNear: () => void) => {
        onNear();
        return () => {};
      });
      return;
    }
    const waiting = new Map<Element, () => void>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          waiting.get(entry.target)?.();
          waiting.delete(entry.target);
          io.unobserve(entry.target);
        }
      },
      { root, rootMargin: THUMB_ROOT_MARGIN },
    );
    setObserve(() => (el: Element, onNear: () => void) => {
      waiting.set(el, onNear);
      io.observe(el);
      return () => {
        waiting.delete(el);
        io.unobserve(el);
      };
    });
    return () => io.disconnect();
  }, []);

  // Roving focus across the grid.
  const grid = useRef<HTMLDivElement | null>(null);
  const [activeRaw, setActive] = useState(0);
  useEffect(() => setActive(0), [folder]);
  // A refresh can shrink the grid under the remembered index.
  const active = Math.max(0, Math.min(activeRaw, ordered.length - 1));
  const focusCard = (index: number) => {
    setActive(index);
    grid.current?.querySelector<HTMLElement>(`[data-card-index="${index}"]`)?.focus();
  };
  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const el = grid.current;
    if (!el) return;
    const columns = getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length;
    const next = nextCardIndex(event.key, active, ordered.length, columns);
    if (next == null) return;
    event.preventDefault();
    focusCard(next);
  };

  const activate = (card: FolderCard) => {
    if (card.kind === "folder") retargetGallery(instanceId, card.path);
    else onOpenNote(card.path);
  };

  const sortLabel = treeSortLabel(folderSorts[folder] ?? treeSort);
  const crumbs = breadcrumbs(folder);
  const title = crumbs.length ? crumbs[crumbs.length - 1]!.name : vaultName;

  return (
    <div className="gallery-panel">
      <header className="gallery-header">
        <div className="gallery-heading">
          <nav className="gallery-crumbs" aria-label="Folder path">
            <button type="button" className="gallery-crumb" onClick={() => retargetGallery(instanceId, "")}>
              {vaultName}
            </button>
            {crumbs.slice(0, -1).map((crumb) => (
              <span key={crumb.path} className="gallery-crumb-wrap">
                <span className="gallery-crumb-sep" aria-hidden="true">/</span>
                <button type="button" className="gallery-crumb" onClick={() => retargetGallery(instanceId, crumb.path)}>
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>
          <h2 className="gallery-title" title={folder || vaultName}>{title}</h2>
        </div>
        <div className="gallery-tools">
          <span className="gallery-sort" title="Change it from the folder's menu in the sidebar">
            {sortLabel}
          </span>
          <div className="gallery-toggle" role="group" aria-label="View as">
            <button
              type="button"
              aria-pressed={false}
              title="Show this folder as a list in the sidebar"
              onClick={() => {
                if (folder) setFolderView(folder, "list");
                onRequestClose();
              }}
            >
              List
            </button>
            <button
              type="button"
              aria-pressed={true}
              className="is-on"
              title="Clicking this folder opens its gallery"
              onClick={() => folder && setFolderView(folder, "gallery")}
            >
              Gallery
            </button>
          </div>
        </div>
      </header>

      <div className="gallery-scroll" ref={scroller}>
        {error ? (
          <div className="workspace-panel-empty">Couldn't list this folder. {error}</div>
        ) : cards === undefined ? (
          <div className="workspace-panel-empty">Loading…</div>
        ) : cards === null ? (
          <div className="gallery-gone">
            <p>This folder no longer exists.</p>
            <button type="button" className="gallery-gone-action" onClick={() => retargetGallery(instanceId, "")}>
              Show {vaultName}
            </button>
          </div>
        ) : ordered.length === 0 ? (
          <div className="workspace-panel-empty">This folder is empty.</div>
        ) : (
          <NearViewport.Provider value={observe}>
            <div className="gallery-grid" role="list" ref={grid} onKeyDown={onGridKey}>
              {ordered.map((card, index) => (
                <div role="listitem" key={card.path} className="gallery-cell">
                  <button
                    type="button"
                    data-card-index={index}
                    tabIndex={index === active ? 0 : -1}
                    className={`gallery-card ${card.kind === "folder" ? "is-folder" : "is-note"}${
                      card.kind === "note" && card.empty ? " is-empty" : ""
                    }`}
                    title={card.path}
                    onFocus={() => setActive(index)}
                    onClick={() => activate(card)}
                  >
                    {card.kind === "folder" ? (
                      <FolderFace name={card.name} count={card.noteCount} />
                    ) : (
                      <NoteFace card={card} vaultPath={vaultPath} />
                    )}
                  </button>
                </div>
              ))}
            </div>
          </NearViewport.Provider>
        )}
      </div>
    </div>
  );
}

function FolderFace({ name, count }: { name: string; count: number }) {
  return (
    <>
      <span className="gallery-thumb gallery-thumb-folder" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6.5h7l2 2h9v10H3z" />
          <path d="M3 6.5V4h7l2 2" />
        </svg>
      </span>
      <span className="gallery-card-meta">
        <span className="gallery-card-title">{name}</span>
        <span className="gallery-card-sub">{count === 1 ? "1 note" : `${count} notes`}</span>
      </span>
    </>
  );
}

function NoteFace({ card, vaultPath }: { card: FolderCardNote; vaultPath: string | null }) {
  const observe = useContext(NearViewport);
  const thumbRef = useRef<HTMLSpanElement | null>(null);
  const [near, setNear] = useState(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (!card.firstImage || near) return;
    const el = thumbRef.current;
    if (!el || !observe) return;
    return observe(el, () => setNear(true));
  }, [card.firstImage, near, observe]);
  useEffect(() => setBroken(false), [card.firstImage]);

  const src = card.firstImage && near && !broken && vaultPath
    ? resolveVaultAsset({ vaultPath, documentPath: "", source: card.firstImage, sourceKind: "path" })
    : null;
  const now = Date.now();

  let thumb;
  if (card.empty) {
    thumb = <span className="gallery-placeholder">Not downloaded yet</span>;
  } else if (card.firstImage && !broken) {
    // Blank until the card nears the viewport; a failed load falls back to text.
    thumb = src
      ? <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} />
      : null;
  } else if (card.excerpt) {
    thumb = <span className="gallery-excerpt">{card.excerpt}</span>;
  } else {
    thumb = <span className="gallery-placeholder">Empty note</span>;
  }

  return (
    <>
      <span className="gallery-thumb" ref={thumbRef}>{thumb}</span>
      <span className="gallery-card-meta">
        <span className="gallery-card-title">{card.name}</span>
        {card.modified > 0 && (
          <span className="gallery-card-sub" title={fullDate(card.modified)}>
            {relativeDate(card.modified, now)}
          </span>
        )}
      </span>
    </>
  );
}
