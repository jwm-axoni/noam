import { useCallback, useEffect, useRef, useState } from "react";
import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import "../../styles/properties.css";
import {
  findFrontmatter,
  frontmatterField,
} from "../../lib/editor/frontmatter";
import { bodyStart, getHeaderFocus, registerHeaderFocus } from "../../lib/editor/headerFocus";
import {
  planAddProperty,
  planDeleteProperty,
  planRenameKey,
  planSetValue,
  type SpanChange,
} from "../../lib/frontmatter/edit";
import {
  isFixedType,
  isListType,
  PROPERTY_TYPES,
  type PropertyType,
} from "../../lib/frontmatter/infer";
import { coerceValue } from "../../lib/frontmatter/infer";
import {
  parseFrontmatter,
  type PropEntry,
  type PropValue,
  valueToText,
} from "../../lib/frontmatter/parse";
import { setType, subscribeTypes, typeFor } from "../../lib/frontmatter/types";
import { useStore } from "../../store";
import { MenuSelect } from "../MenuSelect";
import { PropertyIcon } from "./PropertyIcons";
import {
  DOCUMENT_ID_KEY,
  RELATIONSHIPS_KEY,
  getKnowledgeCatalogSnapshot,
  labelPresentation,
  subscribeKnowledgeCatalog,
  type KnowledgeCatalogV1,
  type LabelDefinition,
} from "../../lib/knowledge";

/**
 * YAML frontmatter as a table of typed properties.
 *
 * Everything here is a MINIMAL SPAN REPLACEMENT dispatched as an ordinary CM6
 * transaction: `yCollab` puts it in the Y.Text, the bridge egests it to the
 * `.md`, Rust re-indexes, and Yjs undo treats it as one step. Nothing about the
 * CRDT path is special-cased — changing a checkbox writes five bytes, and every
 * comment, quote style and key order elsewhere in the block is untouched.
 *
 * Collaboration rests on three things: the widget's `updateDOM` returns true so
 * this component's host node survives a remote keystroke; rows are keyed by
 * property NAME, so a property inserted above the one being edited does not
 * remount it; and the focused field's draft beats the document, so a teammate
 * editing a different property repaints their row and leaves the caret alone.
 * A commit then re-parses and finds its entry by key, because the span it was
 * computed against may have moved.
 */

/** The new property a `⌘;` just created, so the panel can focus its name. */
const pendingFocus = new WeakMap<EditorView, { key: string; cell: "name" | "value" }>();

function docEntries(view: EditorView): { entries: PropEntry[]; ok: boolean } {
  const fm = findFrontmatter(view.state.doc);
  if (!fm) return { entries: [], ok: true };
  const parsed = parseFrontmatter(view.state.doc, fm);
  return parsed.ok
    ? {
        entries: parsed.entries.filter(
          (entry) => entry.key !== DOCUMENT_ID_KEY && entry.key !== RELATIONSHIPS_KEY,
        ),
        ok: true,
      }
    : { entries: [], ok: false };
}

function dispatch(view: EditorView, changes: SpanChange[]): void {
  if (view.state.readOnly || changes.length === 0) return;
  view.dispatch({
    changes,
    // Deliberately no selection change: a frontmatter edit made with the caret
    // in the body maps that caret forward and leaves it there, so the panel
    // cannot flip itself to source mode as a side effect of its own edit.
    annotations: Transaction.userEvent.of("input.properties"),
    scrollIntoView: false,
  });
}

/** `property`, `property 2`, … — a name that is free in this note. */
function freeKey(taken: ReadonlySet<string>): string {
  if (!taken.has("property")) return "property";
  for (let i = 2; i < 1000; i++) {
    if (!taken.has(`property ${i}`)) return `property ${i}`;
  }
  return `property ${Date.now()}`;
}

/**
 * Add a property to the note under `view`, creating the frontmatter block if it
 * has none, and remember to focus the new row's name.
 *
 * The new row is written with a placeholder name rather than being held in the
 * UI unnamed: the panel is derived entirely from the document, so a row that is
 * not in the file has nowhere to live — and a pending row would have to survive
 * a widget that does not exist yet when the note has no frontmatter at all.
 */
export function addPropertyToNote(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const fm = findFrontmatter(view.state.doc);
  const parsed = fm ? parseFrontmatter(view.state.doc, fm) : null;
  if (parsed && !parsed.ok) return false; // never rewrite YAML we can't read
  const entries = parsed?.ok ? parsed.entries : [];
  const taken = new Set(entries.map((entry) => entry.key));
  const catalogSnapshot = getKnowledgeCatalogSnapshot();
  const activeEpoch = useStore.getState().vault?.epoch ?? null;
  if (
    catalogSnapshot.loading
    || catalogSnapshot.error
    || (activeEpoch != null && (
      !catalogSnapshot.loaded || catalogSnapshot.epoch !== activeEpoch
    ))
  ) return false;
  const catalog = catalogSnapshot.catalog;
  const definition = catalog?.properties.find((property) => !taken.has(property.key));
  if (catalog && !definition) return false;
  const key = definition?.key ?? freeKey(taken);
  const value: PropValue = definition?.type.cardinality === "many"
    ? { kind: "list", value: [] }
    : definition?.type.kind === "checkbox"
      ? { kind: "checkbox", value: false }
      : { kind: "text", value: "" };
  getHeaderFocus(view).expandProperties?.();
  dispatch(
    view,
    planAddProperty(view.state.doc, fm, entries, key, value),
  );
  pendingFocus.set(view, { key, cell: definition ? "value" : "name" });
  return true;
}

export function PropertiesPanel({
  view,
  readOnly,
  collapsed,
  onCollapsedChange,
  getPropertyKeys,
  getPropertyValues,
  showHeader = true,
}: {
  view: EditorView;
  readOnly: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  getPropertyKeys?: () => string[];
  getPropertyValues?: (key: string) => string[];
  showHeader?: boolean;
}) {
  const { entries } = docEntries(view);
  const activeEpoch = useStore((state) => state.vault?.epoch ?? null);
  const catalogSnapshot = getKnowledgeCatalogSnapshot();
  const catalog = catalogSnapshot.catalog;
  const catalogUnavailable = catalogSnapshot.loading
    || catalogSnapshot.error != null
    || (activeEpoch != null && (
      !catalogSnapshot.loaded || catalogSnapshot.epoch !== activeEpoch
    ));
  const effectiveReadOnly = readOnly || catalogUnavailable;
  // The type registry lives outside React (it is per-vault, not per-note), so
  // subscribe rather than lift it into state.
  const [, bump] = useState(0);
  useEffect(() => {
    const repaint = () => bump((n) => n + 1);
    const unsubscribeTypes = subscribeTypes(repaint);
    const unsubscribeCatalog = subscribeKnowledgeCatalog(repaint);
    return () => {
      unsubscribeTypes();
      unsubscribeCatalog();
    };
  }, []);

  const rowRefs = useRef(new Map<string, { name?: HTMLInputElement; value?: HTMLElement }>());
  const refFor = (key: string) => {
    let slot = rowRefs.current.get(key);
    if (!slot) {
      slot = {};
      rowRefs.current.set(key, slot);
    }
    return slot;
  };

  const focusRow = useCallback((key: string | undefined, cell: "name" | "value") => {
    if (!key) return false;
    const slot = rowRefs.current.get(key);
    const el = cell === "name" ? slot?.name : slot?.value;
    if (!el) return false;
    el.focus();
    if (cell === "name" && slot?.name) slot.name.select();
    return true;
  }, []);

  const toBody = useCallback(() => {
    const fm = view.state.field(frontmatterField, false) ?? null;
    view.dispatch({ selection: { anchor: bodyStart(fm, view.state.doc.length) } });
    view.focus();
  }, [view]);

  const keys = entries.map((e) => e.key);
  useEffect(() => {
    const expand = () => {
      if (collapsed) onCollapsedChange(false);
    };
    registerHeaderFocus(view, {
      expandProperties: expand,
      focusFirstProperty: () => {
        expand();
        return focusRow(keys[0], "value");
      },
      focusLastProperty: () => {
        expand();
        return focusRow(keys[keys.length - 1], "value");
      },
    });
  }, [view, collapsed, onCollapsedChange, focusRow, keys.join("\0")]);

  // A row added by `⌘;` (possibly from the title widget, before this panel
  // existed) gets its name focused and selected, so typing replaces it.
  useEffect(() => {
    const pending = pendingFocus.get(view);
    if (!pending) return;
    if (focusRow(pending.key, pending.cell)) pendingFocus.delete(view);
  });

  const move = (index: number, delta: number, cell: "name" | "value") => {
    const next = index + delta;
    if (next < 0) return getHeaderFocus(view).focusTitle?.(true) ?? false;
    if (next >= keys.length) {
      toBody();
      return true;
    }
    return focusRow(keys[next], cell);
  };

  return (
    <div className="prop-panel">
      {showHeader && (
        <button
          type="button"
          className="prop-panel-header"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} properties, ${entries.length}`}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          <span>
            Properties <span className="prop-panel-count">· {entries.length}</span>
          </span>
          <span className="prop-panel-chevron" aria-hidden="true">
            {collapsed ? "▸" : "▾"}
          </span>
        </button>
      )}
      {(!collapsed || !showHeader) && (
        <div className="prop-panel-body" role="table" aria-label="Note properties">
          {entries.map((entry, index) => (
            <PropertyRow
              key={entry.key}
              view={view}
              entry={entry}
              catalog={catalog}
              readOnly={effectiveReadOnly}
              slot={refFor(entry.key)}
              suggestions={getPropertyKeys?.() ?? []}
              valueSuggestions={getPropertyValues?.(entry.key) ?? []}
              onMove={(delta, cell) => move(index, delta, cell)}
              onToBody={toBody}
            />
          ))}
          {!effectiveReadOnly && (!catalog || catalog.properties.some(
            (definition) => !entries.some((entry) => entry.key === definition.key),
          )) && (
            <button
              type="button"
              className="prop-add"
              onClick={() => addPropertyToNote(view)}
            >
              + Add property
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PropertyRow({
  view,
  entry,
  catalog,
  readOnly,
  slot,
  suggestions,
  valueSuggestions,
  onMove,
  onToBody,
}: {
  view: EditorView;
  entry: PropEntry;
  catalog: KnowledgeCatalogV1 | null;
  readOnly: boolean;
  slot: { name?: HTMLInputElement; value?: HTMLElement };
  suggestions: string[];
  valueSuggestions: string[];
  onMove: (delta: number, cell: "name" | "value") => boolean;
  onToBody: () => void;
}) {
  const epoch = useStore((s) => s.vault?.epoch);
  const type = typeFor(entry.key, entry.value);
  const sharedDefinition = catalog?.properties.find((definition) => definition.key === entry.key);
  const catalogUnknown = catalog != null && sharedDefinition == null;
  const storageKeyLocked = sharedDefinition != null || catalogUnknown;
  const labelValued = sharedDefinition?.type.kind === "label" || sharedDefinition?.type.kind === "tag";
  const labelOptions = labelValued
    ? catalog?.labels.filter((label) =>
        !sharedDefinition.allowedLabelIds || sharedDefinition.allowedLabelIds.includes(label.id),
      ) ?? []
    : [];
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [valueDraft, setValueDraft] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The value's serialization when the draft began, so a commit can tell
  // whether someone else moved it underneath us.
  const rawAtStart = useRef(entry.raw);

  useEffect(() => {
    if (valueDraft === null) rawAtStart.current = entry.raw;
  }, [entry.raw, valueDraft]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  /**
   * Re-parse, find this property by NAME, and replace its CURRENT span. The
   * draft was computed against a span that may have moved or vanished — this is
   * the MCP write path's `expectedRevision` idea applied to a span. No lock is
   * needed (the CRDT merges); it only has to not write to a stale offset.
   */
  const commitValue = useCallback(
    (next: PropValue) => {
      if (view.state.readOnly) return;
      if (sharedDefinition?.allowedLabelIds) {
        const submitted = next.kind === "list"
          ? next.value
          : next.kind === "text"
            ? [next.value]
            : [];
        if (submitted.some((value) => !sharedDefinition.allowedLabelIds!.includes(value))) {
          setValueDraft(null);
          setNote("Choose one of this property's allowed labels.");
          return;
        }
      }
      const fm = findFrontmatter(view.state.doc);
      const parsed = fm ? parseFrontmatter(view.state.doc, fm) : null;
      const current = parsed?.ok
        ? parsed.entries.find((e) => e.key === entry.key)
        : undefined;
      if (!current) {
        setValueDraft(null);
        setNote("This property was removed.");
        return;
      }
      const moved = current.raw !== rawAtStart.current;
      setValueDraft(null);
      rawAtStart.current = current.raw;
      if (moved) {
        setNote("Changed by someone else while you were typing.");
        return;
      }
      dispatch(view, planSetValue(current, next));
    },
    [view, entry.key, sharedDefinition],
  );

  const commitText = useCallback(
    (text: string) => {
      commitValue(coerceValue({ kind: "text", value: text }, type));
    },
    [commitValue, type],
  );

  const commitName = useCallback(() => {
    if (view.state.readOnly || storageKeyLocked) return;
    if (nameDraft === null) return;
    const next = nameDraft.trim();
    setNameDraft(null);
    if (next === "" || next === entry.key) return;
    const fm = findFrontmatter(view.state.doc);
    const parsed = fm ? parseFrontmatter(view.state.doc, fm) : null;
    const current = parsed?.ok
      ? parsed.entries.find((e) => e.key === entry.key)
      : undefined;
    if (!current) {
      setNote("This property was removed.");
      return;
    }
    if (parsed?.ok && parsed.entries.some((e) => e.key === next)) {
      setNote(`There is already a property called "${next}".`);
      return;
    }
    dispatch(view, planRenameKey(current, next));
  }, [nameDraft, entry.key, storageKeyLocked, view]);

  const remove = useCallback(() => {
    if (view.state.readOnly || catalogUnknown) return;
    const fm = findFrontmatter(view.state.doc);
    const parsed = fm ? parseFrontmatter(view.state.doc, fm) : null;
    const current = parsed?.ok
      ? parsed.entries.find((e) => e.key === entry.key)
      : undefined;
    if (!current) return;
    dispatch(view, planDeleteProperty(view.state.doc, current));
    onMove(-1, "value");
  }, [view, entry.key, onMove, catalogUnknown]);

  const onCellKeyDown = (e: React.KeyboardEvent, cell: "name" | "value") => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      onMove(1, cell);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      onMove(-1, cell);
    } else if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      remove();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setNameDraft(null);
      setValueDraft(null);
    }
  };

  const listId = `prop-keys-${entry.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  return (
    <div className="prop-row" role="row">
      <MenuSelect<PropertyType>
        value={type}
        options={PROPERTY_TYPES.map((t) => ({ value: t.id, label: t.label }))}
        onSelect={(next) => {
          if (view.state.readOnly || storageKeyLocked) return;
          setType(entry.key, next, epoch);
          commitValue(coerceValue(entry.value, next));
        }}
        disabled={readOnly || storageKeyLocked || isFixedType(entry.key)}
        ariaLabel={`Type of ${entry.key}`}
        triggerClassName="prop-type-trigger"
        triggerContent={<PropertyIcon type={type} />}
        caret={false}
      />
      <input
        ref={(el) => {
          slot.name = el ?? undefined;
        }}
        className="prop-name"
        value={sharedDefinition?.name ?? nameDraft ?? entry.key}
        readOnly={readOnly || storageKeyLocked}
        disabled={readOnly || storageKeyLocked}
        aria-label={sharedDefinition ? `${sharedDefinition.name} storage key` : "Property name"}
        list={suggestions.length > 0 ? listId : undefined}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitName();
            return;
          }
          if (e.key === "ArrowRight") {
            const el = e.currentTarget;
            if (el.selectionStart === el.value.length) {
              e.preventDefault();
              slot.value?.focus();
              return;
            }
          }
          onCellKeyDown(e, "name");
        }}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      <div className="prop-value">
        {catalogUnknown ? (
          <code
            ref={(element) => { slot.value = element ?? undefined; }}
            className="prop-raw-value"
            tabIndex={0}
            aria-label={`${entry.key} raw value`}
          >
            {entry.raw || "Empty"}
          </code>
        ) : (
          <ValueControl
            type={type}
            entry={entry}
            readOnly={readOnly}
            draft={valueDraft}
            setDraft={setValueDraft}
            commitValue={commitValue}
            commitText={commitText}
            suggestions={valueSuggestions}
            labelOptions={labelOptions}
            slot={slot}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                const el = e.currentTarget as HTMLInputElement;
                if (el.selectionStart === 0) {
                  e.preventDefault();
                  slot.name?.focus();
                  return;
                }
              }
              onCellKeyDown(e, "value");
            }}
            onToBody={onToBody}
            labelValued={labelValued}
          />
        )}
        {note && <p className="prop-note">{note}</p>}
      </div>
      {!readOnly && !catalogUnknown && (
        <button
          type="button"
          className="prop-remove"
          aria-label={`Remove ${entry.key}`}
          onClick={remove}
        >
          ×
        </button>
      )}
    </div>
  );
}

function ValueControl({
  type,
  entry,
  readOnly,
  draft,
  setDraft,
  commitValue,
  commitText,
  suggestions,
  labelOptions,
  slot,
  onKeyDown,
  labelValued = false,
}: {
  type: PropertyType;
  entry: PropEntry;
  readOnly: boolean;
  draft: string | null;
  setDraft: (v: string | null) => void;
  commitValue: (v: PropValue) => void;
  commitText: (v: string) => void;
  suggestions: string[];
  labelOptions: LabelDefinition[];
  slot: { name?: HTMLInputElement; value?: HTMLElement };
  onKeyDown: (e: React.KeyboardEvent) => void;
  onToBody: () => void;
  labelValued?: boolean;
}) {
  const setRef = (el: HTMLElement | null) => {
    slot.value = el ?? undefined;
  };

  if (type === "checkbox") {
    const on = entry.value.kind === "checkbox" ? entry.value.value : false;
    return (
      <input
        ref={setRef}
        type="checkbox"
        className="prop-checkbox"
        checked={on}
        disabled={readOnly}
        aria-label={entry.key}
        onChange={(e) => commitValue({ kind: "checkbox", value: e.target.checked })}
        onKeyDown={onKeyDown}
      />
    );
  }

  if (isListType(type)) {
    return (
      <Chips
        entry={entry}
        readOnly={readOnly}
        labelValued={labelValued}
        draft={draft}
        setDraft={setDraft}
        commitValue={commitValue}
        suggestions={suggestions}
        labelOptions={labelOptions}
        setRef={setRef}
        onKeyDown={onKeyDown}
      />
    );
  }

  const inputType =
    type === "number"
      ? "number"
      : type === "date"
        ? "date"
        : type === "datetime"
          ? "datetime-local"
          : "text";
  // `datetime-local` cannot hold a trailing `Z`; keep what the file says and
  // fall back to a text field rather than silently dropping the zone.
  const raw = valueToText(entry.value);
  const shown = draft ?? (
    type === "datetime"
      ? raw.replace(/Z$/, "").slice(0, 16)
      : raw
  );
  const presentedLabel = labelValued ? labelPresentation(shown) : null;
  const labelColor = presentedLabel?.color;
  const choices = labelValued ? labelOptions.map((label) => label.id) : suggestions;
  const listId = choices.length > 0 ? `prop-values-${entry.key}` : undefined;

  const input = (
    <input
      ref={setRef}
      type={inputType}
      className={`prop-input${labelValued ? " prop-label-input" : ""}`}
      style={{ "--prop-chip-color": labelColor } as React.CSSProperties}
      value={shown}
      readOnly={readOnly}
      disabled={readOnly}
      aria-label={entry.key}
      list={listId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null) commitText(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (draft !== null) commitText(draft);
          return;
        }
        onKeyDown(e);
      }}
    />
  );

  return (
    <>
      {labelValued ? (
        <div className="prop-label-field">
          {input}
          {presentedLabel && presentedLabel.label !== shown && (
            <span className="prop-label-name">{presentedLabel.label}</span>
          )}
        </div>
      ) : input}
      {listId && (
        <datalist id={listId}>
          {labelValued
            ? labelOptions.map((label) => (
                <option key={label.id} value={label.id} label={label.name} />
              ))
            : suggestions.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
        </datalist>
      )}
    </>
  );
}

function Chips({
  entry,
  readOnly,
  labelValued,
  draft,
  setDraft,
  commitValue,
  suggestions,
  labelOptions,
  setRef,
  onKeyDown,
}: {
  entry: PropEntry;
  readOnly: boolean;
  labelValued: boolean;
  draft: string | null;
  setDraft: (v: string | null) => void;
  commitValue: (v: PropValue) => void;
  suggestions: string[];
  labelOptions: LabelDefinition[];
  setRef: (el: HTMLElement | null) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const items =
    entry.value.kind === "list"
      ? entry.value.value
      : valueToText(entry.value).trim() === ""
        ? []
        : [valueToText(entry.value)];
  const choices = labelValued ? labelOptions.map((label) => label.id) : suggestions;
  const listId = choices.length > 0 ? `prop-chips-${entry.key}` : undefined;

  const setItems = (next: string[]) => commitValue({ kind: "list", value: next });

  return (
    <div className="prop-chips">
      {items.map((item, i) => (
        <span
          className="prop-chip"
          key={`${item}-${i}`}
          style={labelValued
            ? { "--prop-chip-color": labelPresentation(item).color } as React.CSSProperties
            : undefined}
        >
          {labelValued ? labelPresentation(item).label : item}
          {!readOnly && (
            <button
              type="button"
              aria-label={`Remove ${item}`}
              onClick={() => setItems(items.filter((_, n) => n !== i))}
            >
              ×
            </button>
          )}
        </span>
      ))}
      <input
        ref={setRef}
        className="prop-chip-input"
        value={draft ?? ""}
        readOnly={readOnly}
        disabled={readOnly}
        aria-label={`Add to ${entry.key}`}
        list={listId}
        placeholder={items.length === 0 ? "Empty" : ""}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const text = (draft ?? "").trim();
          setDraft(null);
          if (text !== "") setItems([...items, text]);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const text = (draft ?? "").trim();
            setDraft(null);
            if (text !== "") setItems([...items, text]);
            return;
          }
          if (e.key === "Backspace" && (draft ?? "") === "" && items.length > 0) {
            e.preventDefault();
            setItems(items.slice(0, -1));
            return;
          }
          onKeyDown(e);
        }}
      />
      {listId && (
        <datalist id={listId}>
          {labelValued
            ? labelOptions.map((label) => (
                <option key={label.id} value={label.id} label={label.name} />
              ))
            : suggestions.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
        </datalist>
      )}
    </div>
  );
}
