import { useEffect, useRef, useState } from "react";
import type { SearchResult } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { noteLabel } from "../lib/notePath";
import type { PanelBodyProps } from "../layout/panelRegistry";
import { useStore } from "../store";
import { consumeSearchInputFocus } from "./searchFocus";

/** Persistent dock body: query, results, cursor, and scroll survive tab swaps. */
export function SearchPanel({ vaultKey, vaultEpoch, visible, onOpenNote }: PanelBodyProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(false);
  const timer = useRef<number | null>(null);
  const generation = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    // Only steal focus on an explicit user-initiated open (activity bar, ⌘F),
    // never because a sibling tab closed or a split flipped the active tab.
    if (visible && consumeSearchInputFocus()) inputRef.current?.focus();
  }, [visible]);

  useEffect(() => {
    generation.current += 1;
    const request = generation.current;
    if (timer.current != null) window.clearTimeout(timer.current);
    if (!query.trim()) {
      setResults([]);
      setActive(0);
      setPending(false);
      return;
    }
    setPending(true);
    timer.current = window.setTimeout(async () => {
      try {
        const next = await ipc.searchNotes(query);
        const currentVault = useStore.getState().vault;
        if (
          request !== generation.current ||
          currentVault?.path !== vaultKey ||
          currentVault.epoch !== vaultEpoch
        ) return;
        setResults(next);
        setActive(0);
      } catch (error) {
        if (request === generation.current) console.error("search failed", error);
      } finally {
        if (request === generation.current) setPending(false);
      }
    }, 180);
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, [query, vaultKey, vaultEpoch]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const open = (path: string) => onOpenNote(path);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" && results.length) {
      setActive((index) => (index + 1) % results.length);
    } else if (event.key === "ArrowUp" && results.length) {
      setActive((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === "Enter" && results[active]) {
      open(results[active].path);
    } else {
      return;
    }
    event.preventDefault();
  };

  return (
    <div className="search-panel" aria-label="Search notes">
      <div className="search-field">
        <span className="search-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
          </svg>
        </span>
        <input
          ref={inputRef}
          className="search-box"
          placeholder="Search notes…"
          value={query}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <ul className="search-results" ref={listRef} aria-busy={pending || undefined}>
        {query.trim() && !pending && results.length === 0 && <li className="search-none">No matches</li>}
        {results.map((result, index) => (
          <li key={result.id}>
            <button
              type="button"
              data-idx={index}
              className={`search-result${index === active ? " active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => open(result.path)}
              title={result.path}
            >
              <span className="search-title">{noteLabel(result.path)}</span>
              <span className="search-snippet" dangerouslySetInnerHTML={{ __html: result.snippet }} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
