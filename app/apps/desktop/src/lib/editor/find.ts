// In-note find and replace: a floating bubble in the editor's top-right
// (plan `PLAN-INTERACTIVE-VIEWS.md` Part 5).
//
// This is NOT a second search engine. It is a custom `createPanel` for
// `@codemirror/search`, so the query, the match decorations
// (`.cm-searchMatch` / `.cm-searchMatch-selected`), findNext/findPrevious and
// replaceNext/replaceAll are all the library's own. Replace All is the
// library's single `view.dispatch`, which is what makes it ONE undo step both
// under CM6 `history()` (solo) and under the Yjs UndoManager (collab: yCollab
// turns one CodeMirror transaction into one Y transaction).
//
// The panel sits in `.cm-panels-top`, which the theme below lifts out of the
// flow (`position: absolute`), so it floats over the text instead of taking a
// row. CodeMirror still measures it for `scrollMargins`, so a match scrolled
// into view never lands underneath the bubble.
//
// Keys:
//   Mod-f            open, focused on the search input (selection prefills it
//                    when it is one line)
//   Mod-Alt-f (mac)  open with the replace row expanded. Never Mod-h on macOS:
//   Ctrl-h (else)    ⌘H hides the app.
//   Enter / Shift-Enter   next / previous (in the bubble)
//   Enter in replace      Replace
//   Esc                   close, focus back in the editor on the current match

import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchKeymap,
  searchPanelOpen,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import {
  EditorSelection,
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  type Command,
  EditorView,
  type KeyBinding,
  type Panel,
  runScopeHandlers,
  type ViewUpdate,
} from "@codemirror/view";

/** Stop counting past this many matches; the label then reads "n of 1000+". */
export const MATCH_COUNT_LIMIT = 1000;

/** Longest selection that prefills the search input. */
const PREFILL_MAX = 200;

// ---- Match counting -------------------------------------------------------

export interface MatchCount {
  /** 1-based index of the match the main selection sits on, or null. */
  current: number | null;
  total: number;
  /** True when counting stopped at `MATCH_COUNT_LIMIT`. */
  capped: boolean;
}

/** Count `query`'s matches and find which one the main selection is on. */
export function countMatches(
  state: EditorState,
  query: SearchQuery,
  limit = MATCH_COUNT_LIMIT,
): MatchCount {
  if (!query.valid) return { current: null, total: 0, capped: false };
  const { from, to } = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0;
  let current: number | null = null;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    if (total >= limit) return { current, total, capped: true };
    total++;
    if (current === null && next.value.from === from && next.value.to === to) current = total;
  }
  return { current, total, capped: false };
}

/** "3 of 12", "12 results", "No results", or "" for an empty query. */
export function matchCountLabel(query: SearchQuery, count: MatchCount): string {
  if (query.search === "") return "";
  if (count.total === 0) return "No results";
  const total = count.capped ? `${count.total}+` : String(count.total);
  if (count.current !== null) return `${count.current} of ${total}`;
  return count.total === 1 && !count.capped ? "1 result" : `${total} results`;
}

// ---- Replace-row state ----------------------------------------------------

/** Show or hide the replace row. Survives the panel being closed and reopened. */
export const setReplaceOpen = StateEffect.define<boolean>();

export const replaceOpenField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setReplaceOpen)) value = e.value;
    return value;
  },
});

// ---- Commands -------------------------------------------------------------

function panelDom(view: EditorView): HTMLElement | null {
  return view.dom.querySelector<HTMLElement>(".cm-find");
}

function focusField(view: EditorView, field: "search" | "replace"): void {
  const input = panelDom(view)?.querySelector<HTMLInputElement>(
    field === "search" ? "input[main-field]" : "input[name=replace]",
  );
  if (!input) return;
  input.focus();
  input.select();
}

/** The main selection's text, when it is non-empty and on one line. */
function singleLineSelection(state: EditorState): string | null {
  const { from, to, empty } = state.selection.main;
  if (empty || to - from > PREFILL_MAX) return null;
  if (state.doc.lineAt(from).number !== state.doc.lineAt(to).number) return null;
  return state.sliceDoc(from, to);
}

/**
 * Open (or re-focus) the bubble. `replace: true` also expands the replace row,
 * and a read-only editor opens find only. Always returns true so the key is
 * consumed — this is the answer to Mod-f whether or not anything changed.
 */
export function openFind(view: EditorView, opts: { replace?: boolean } = {}): boolean {
  const { state } = view;
  const prefill = singleLineSelection(state);
  const spec = getSearchQuery(state);
  const query = new SearchQuery({
    search: prefill ?? spec.search,
    caseSensitive: spec.caseSensitive,
    literal: spec.literal,
    regexp: spec.regexp,
    wholeWord: spec.wholeWord,
    replace: spec.replace,
  });
  // openSearchPanel adds the panel (and seeds the query from ANY selection up
  // to 100 chars, multi-line too); the dispatch after it states ours instead.
  if (!searchPanelOpen(state)) openSearchPanel(view);
  const replace = !!opts.replace && !view.state.readOnly;
  view.dispatch({
    effects: [
      setSearchQuery.of(query),
      ...(replace ? [setReplaceOpen.of(true)] : []),
    ],
  });
  focusField(view, replace && query.search !== "" ? "replace" : "search");
  return true;
}

export const openFindCommand: Command = (view) => openFind(view);
export const openReplaceCommand: Command = (view) => openFind(view, { replace: true });

/**
 * Point the query at `next` and move the selection to its first match at or
 * after `origin` — find-as-you-type, so "n of m" always has an n.
 */
function searchFrom(view: EditorView, next: SearchQuery, origin: number): void {
  const effects: StateEffect<unknown>[] = [setSearchQuery.of(next)];
  if (!next.valid) {
    view.dispatch({ effects });
    return;
  }
  const cursor = next.getCursor(view.state, origin);
  let hit = cursor.next();
  if (hit.done) hit = next.getCursor(view.state, 0, origin).next();
  if (hit.done) {
    view.dispatch({ effects });
    return;
  }
  const range = EditorSelection.range(hit.value.from, hit.value.to);
  view.dispatch({
    effects: [...effects, EditorView.scrollIntoView(range, { y: "center" })],
    selection: EditorSelection.single(hit.value.from, hit.value.to),
    userEvent: "select.search",
  });
}

// ---- The bubble -----------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

/** A 16px stroke icon from one path (lucide geometry). */
function icon(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}

const ICON = {
  up: "m18 15-6-6-6 6",
  down: "m6 9 6 6 6-6",
  right: "m9 18 6-6-6-6",
  close: "M18 6 6 18M6 6l12 12",
};

function button(
  name: string,
  label: string,
  content: Node | string,
  onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.name = name;
  b.className = "cm-find-button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(content);
  b.addEventListener("click", onClick);
  return b;
}

type Toggle = "caseSensitive" | "regexp" | "wholeWord";
type QueryPatch = Partial<
  Pick<SearchQuery, "search" | "replace" | "caseSensitive" | "regexp" | "wholeWord">
>;

class FindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private query: SearchQuery;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly expand: HTMLButtonElement;
  private readonly toggles: Record<Toggle, HTMLButtonElement>;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);

    this.searchField = document.createElement("input");
    this.searchField.setAttribute("main-field", "true");
    this.searchField.name = "search";
    this.searchField.className = "cm-find-input";
    this.searchField.placeholder = "Find";
    this.searchField.setAttribute("aria-label", "Find");
    this.searchField.spellcheck = false;
    this.searchField.autocomplete = "off";
    this.searchField.addEventListener("input", () =>
      this.commit({ search: this.searchField.value }, true),
    );

    this.count = document.createElement("span");
    this.count.className = "cm-find-count";
    this.count.setAttribute("aria-live", "polite");

    const toggle = (key: Toggle, label: string, text: string) => {
      const b = button(key, label, text, () =>
        this.commit({ [key]: !this.query[key] }, true),
      );
      b.classList.add("cm-find-toggle");
      return b;
    };
    this.toggles = {
      caseSensitive: toggle("caseSensitive", "Match case", "Aa"),
      wholeWord: toggle("wholeWord", "Whole word", "ab"),
      regexp: toggle("regexp", "Regular expression", ".*"),
    };

    this.expand = button("expand", "Toggle replace", icon(ICON.right), () => {
      const open = !this.view.state.field(replaceOpenField);
      this.view.dispatch({ effects: setReplaceOpen.of(open) });
      (open ? this.replaceField : this.searchField).focus();
    });
    this.expand.classList.add("cm-find-expand");

    const field = document.createElement("div");
    field.className = "cm-find-field";
    field.append(
      this.searchField,
      this.count,
      this.toggles.caseSensitive,
      this.toggles.wholeWord,
      this.toggles.regexp,
    );

    const findRow = document.createElement("div");
    findRow.className = "cm-find-row";
    findRow.append(
      this.expand,
      field,
      button("prev", "Previous match (Shift+Enter)", icon(ICON.up), () => findPrevious(this.view)),
      button("next", "Next match (Enter)", icon(ICON.down), () => findNext(this.view)),
      button("close", "Close (Esc)", icon(ICON.close), () => closeSearchPanel(this.view)),
    );

    this.replaceField = document.createElement("input");
    this.replaceField.name = "replace";
    this.replaceField.className = "cm-find-input";
    this.replaceField.placeholder = "Replace";
    this.replaceField.setAttribute("aria-label", "Replace");
    this.replaceField.spellcheck = false;
    this.replaceField.autocomplete = "off";
    this.replaceField.addEventListener("input", () =>
      this.commit({ replace: this.replaceField.value }, false),
    );

    const replaceBox = document.createElement("div");
    replaceBox.className = "cm-find-field";
    replaceBox.append(this.replaceField);

    const replaceOne = button("replace", "Replace (Enter)", "Replace", () => replaceNext(this.view));
    const replaceEvery = button("replaceAll", "Replace all", "Replace all", () =>
      replaceAll(this.view),
    );
    replaceOne.classList.add("cm-find-text-button");
    replaceEvery.classList.add("cm-find-text-button");

    const replaceRow = document.createElement("div");
    replaceRow.className = "cm-find-row cm-find-replace-row";
    replaceRow.append(replaceBox, replaceOne, replaceEvery);

    this.dom = document.createElement("div");
    this.dom.className = "cm-find";
    this.dom.setAttribute("role", "search");
    this.dom.addEventListener("keydown", (e) => this.keydown(e));
    this.dom.append(findRow, replaceRow);

    this.sync(view.state);
  }

  mount(): void {
    this.searchField.focus();
    this.searchField.select();
  }

  update(update: ViewUpdate): void {
    this.query = getSearchQuery(update.state);
    const queryChanged = !this.query.eq(getSearchQuery(update.startState));
    if (
      queryChanged ||
      update.docChanged ||
      update.selectionSet ||
      update.state.readOnly !== update.startState.readOnly ||
      update.state.field(replaceOpenField) !== update.startState.field(replaceOpenField)
    ) {
      this.sync(update.state);
    }
  }

  private sync(state: EditorState): void {
    const q = this.query;
    if (this.searchField.value !== q.search) this.searchField.value = q.search;
    if (this.replaceField.value !== q.replace) this.replaceField.value = q.replace;
    for (const key of Object.keys(this.toggles) as Toggle[]) {
      this.toggles[key].setAttribute("aria-pressed", String(q[key]));
    }
    const invalid = q.search !== "" && !q.valid;
    this.searchField.toggleAttribute("aria-invalid", invalid);
    this.count.textContent = matchCountLabel(q, countMatches(state, q));

    const readOnly = state.readOnly;
    const open = !readOnly && state.field(replaceOpenField);
    this.dom.classList.toggle("cm-find-replacing", open);
    this.dom.classList.toggle("cm-find-readonly", readOnly);
    this.expand.hidden = readOnly;
    this.expand.setAttribute("aria-expanded", String(open));
    const replaceRow = this.dom.querySelector<HTMLElement>(".cm-find-replace-row")!;
    replaceRow.hidden = !open;
    for (const el of replaceRow.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      "input, button",
    )) {
      el.disabled = readOnly;
    }
  }

  /** Build a query from the current one plus `patch`, and apply it. */
  private commit(patch: QueryPatch, research: boolean): void {
    const q = this.query;
    const next = new SearchQuery({
      search: q.search,
      caseSensitive: q.caseSensitive,
      literal: q.literal,
      regexp: q.regexp,
      wholeWord: q.wholeWord,
      replace: q.replace,
      ...patch,
    });
    if (next.eq(q)) return;
    this.query = next;
    if (research) searchFrom(this.view, next, this.view.state.selection.main.from);
    else this.view.dispatch({ effects: setSearchQuery.of(next) });
  }

  private keydown(e: KeyboardEvent): void {
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.key === "Escape" && plain && !e.shiftKey) {
      e.preventDefault();
      closeSearchPanel(this.view);
      return;
    }
    if (e.key === "Enter" && plain && !e.isComposing) {
      const target = e.target as HTMLElement | null;
      if (target === this.searchField) {
        e.preventDefault();
        (e.shiftKey ? findPrevious : findNext)(this.view);
        return;
      }
      if (target === this.replaceField && !e.shiftKey) {
        e.preventDefault();
        replaceNext(this.view);
        return;
      }
    }
    // Mod-f, the replace key, Mod-g / F3 … — the same bindings as the editor.
    if (runScopeHandlers(this.view, e, "search-panel")) e.preventDefault();
  }
}

export function createFindPanel(view: EditorView): Panel {
  return new FindPanel(view);
}

// ---- Keymap + theme -------------------------------------------------------

/**
 * The bubble's keys, ahead of what we keep from `searchKeymap` (Mod-g / F3,
 * Escape, Mod-d, Mod-Shift-l, Mod-Alt-g). `searchKeymap`'s own Mod-f is
 * dropped: ours prefills only a one-line selection.
 */
export const findKeymap: readonly KeyBinding[] = [
  { key: "Mod-f", run: openFindCommand, scope: "editor search-panel", preventDefault: true },
  // `mac` REPLACES `key` on macOS, so Ctrl-h (Emacs backspace there) and
  // Mod-h (Hide Noam) are never bound on a Mac.
  {
    key: "Ctrl-h",
    mac: "Mod-Alt-f",
    run: openReplaceCommand,
    scope: "editor search-panel",
    preventDefault: true,
  },
  ...searchKeymap.filter((binding) => binding.key !== "Mod-f"),
];

// Four classes deep so it beats `@codemirror/view`'s and `@codemirror/search`'s
// base themes (`&light .cm-panels-top`, `&light .cm-searchMatch` …) whatever
// order the style modules mount in.
const S = "&.cm-editor";

export const findTheme = EditorView.theme({
  [`${S} .cm-panels.cm-panels-top`]: {
    position: "absolute",
    // CodeMirror stamps an inline `top: 0` on this node, so the gap from the
    // editor's top edge is a margin rather than `top`.
    marginTop: "var(--sp-2)",
    right: "var(--sp-4)",
    left: "auto",
    maxWidth: "calc(100% - var(--sp-8))",
    border: "none",
    background: "transparent",
    color: "inherit",
    zIndex: "20",
  },
  [`${S} .cm-find`]: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--sp-1)",
    padding: "var(--sp-1)",
    background: "var(--bg-surface)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-md)",
    fontFamily: "var(--font-body)",
    fontSize: "var(--type-chrome-size)",
    lineHeight: "var(--type-leading-chrome)",
  },
  [`${S} .cm-find-row`]: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
  },
  [`${S} .cm-find-row[hidden]`]: { display: "none" },
  // The replace row lines its input up under the search input.
  [`${S} .cm-find-replace-row`]: { paddingLeft: "26px" },
  [`${S} .cm-find-replace-row .cm-find-field`]: { width: "auto", flex: "1" },
  [`${S} .cm-find-readonly .cm-find-replace-row`]: { display: "none" },
  [`${S} .cm-find-field`]: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    width: "260px",
    maxWidth: "100%",
    height: "28px",
    padding: "0 2px 0 var(--sp-2)",
    background: "var(--bg-subtle)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
  },
  [`${S} .cm-find-field:focus-within`]: {
    borderColor: "var(--border-strong)",
    boxShadow: "var(--focus-ring)",
  },
  [`${S} .cm-find-input`]: {
    flex: "1",
    width: "0",
    minWidth: "0",
    margin: "0",
    padding: "0",
    border: "none",
    outline: "none",
    background: "transparent",
    color: "var(--text-primary)",
    font: "inherit",
  },
  [`${S} .cm-find-input::placeholder`]: { color: "var(--text-tertiary)" },
  [`${S} .cm-find-input[aria-invalid]`]: { color: "var(--danger)" },
  [`${S} .cm-find-count`]: {
    flexShrink: "0",
    padding: "0 var(--sp-1)",
    color: "var(--text-tertiary)",
    fontSize: "var(--type-caption-size)",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  [`${S} .cm-find-button`]: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: "0",
    minWidth: "24px",
    height: "24px",
    margin: "0",
    padding: "0 4px",
    border: "none",
    borderRadius: "var(--radius-sm)",
    background: "transparent",
    color: "var(--text-secondary)",
    font: "inherit",
    cursor: "pointer",
  },
  [`${S} .cm-find-button:hover:not(:disabled)`]: {
    background: "var(--bg-hover)",
    color: "var(--text-primary)",
  },
  [`${S} .cm-find-button:focus-visible`]: { outline: "none", boxShadow: "var(--focus-ring)" },
  [`${S} .cm-find-button:disabled`]: { opacity: "0.5", cursor: "default" },
  [`${S} .cm-find-toggle`]: {
    minWidth: "22px",
    height: "22px",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--type-caption-size)",
  },
  [`${S} .cm-find-toggle[name=wholeWord]`]: {
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  [`${S} .cm-find-toggle[aria-pressed=true]`]: {
    background: "var(--accent-soft)",
    color: "var(--text-primary)",
  },
  [`${S} .cm-find-expand svg`]: { transition: "transform 120ms ease" },
  [`${S} .cm-find-expand[aria-expanded=true] svg`]: { transform: "rotate(90deg)" },
  [`${S} .cm-find-text-button`]: { padding: "0 var(--sp-2)" },

  // Every match gets a soft wash; the ACTIVE one a solid fill plus a ring, so
  // it reads at a glance among the rest (the editor theme's older, plainer
  // rules stay for anything else that emits these classes).
  [`${S} .cm-content .cm-searchMatch`]: {
    backgroundColor: "var(--warning-soft)",
    boxShadow: "inset 0 -1px 0 color-mix(in srgb, var(--warning) 45%, transparent)",
    borderRadius: "3px",
  },
  [`${S} .cm-content .cm-searchMatch-selected`]: {
    backgroundColor: "color-mix(in srgb, var(--warning) 42%, transparent)",
    boxShadow: "0 0 0 1px var(--warning)",
  },
});

/** Everything the editor needs for the bubble. */
export function findReplace(): Extension {
  return [
    replaceOpenField,
    search({ top: true, literal: true, createPanel: createFindPanel }),
    findTheme,
  ];
}
