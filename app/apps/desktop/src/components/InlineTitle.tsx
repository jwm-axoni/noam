import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { ITEM_COLORS, itemColorValue } from "../lib/appearance";
import { frontmatterField } from "../lib/editor/frontmatter";
import { bodyStart, getHeaderFocus, registerHeaderFocus } from "../lib/editor/headerFocus";
import { addPropertyToNote } from "./properties/PropertiesPanel";
import { planInlineTitleRename, TITLE_REFUSAL_MESSAGE } from "../lib/editor/titlePlan";
import { stemOf } from "../lib/notePath";
import { useStore } from "../store";
import * as ipc from "../lib/ipc";
import { applyPresentationPatch } from "../lib/presentation/edit";
import {
  pickPresentationAsset,
  savePresentationAsset,
  type PresentationAssetTarget,
} from "../lib/presentation/assets";
import {
  DEFAULT_COVER_HEIGHT,
  COVER_PRESETS,
  ICON_COLOR_IDS,
  PRESENTATION_KEYS,
  serializePresentationIcon,
  type NotePresentation,
  type PresentationIcon as PresentationIconValue,
} from "../lib/presentation/types";
import { PresentationIcon } from "./PresentationIcon";
import { ViewportMenu } from "./ViewportMenu";
import "./presentation.css";

const IconPicker = lazy(() =>
  import("./IconPicker").then((module) => ({ default: module.IconPicker })),
);

/**
 * The note's name, at the top of the note, as a real `<input>`.
 *
 * The title IS the filename, so committing it is a RENAME — never a document
 * edit, never a CRDT write. That is why this is an input over a decoration
 * rather than the first line of the buffer: a title that lived in the text would
 * be a second source of truth for a note's identity, and the whole product rests
 * on there being exactly one.
 *
 * Refusals are inline and specific (see `titlePlan.ts`), and a collision keeps
 * focus rather than silently landing the user on `Name 1`.
 */
export function InlineTitle({
  view,
  docId,
  path,
  readOnly,
  hasFrontmatter,
  renameTo,
  noteExists,
  presentation,
  resolveAsset,
}: {
  view: EditorView;
  docId?: string;
  path: string;
  readOnly: boolean;
  hasFrontmatter: boolean;
  renameTo: (nextPath: string) => Promise<string | null>;
  noteExists: (path: string) => Promise<boolean>;
  presentation: NotePresentation;
  resolveAsset?: (source: string, sourceKind?: "url" | "path") => string;
}) {
  const stem = stemOf(path);
  const [draft, setDraft] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [coverEditing, setCoverEditing] = useState(false);
  const [coverError, setCoverError] = useState(false);
  const vaultPath = useStore((state) => state.vault?.path ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const iconButtonRef = useRef<HTMLButtonElement | null>(null);
  const iconMenuRef = useRef<HTMLDivElement | null>(null);
  // Read by the commit path so a stale closure can't rename to an old draft.
  const draftRef = useRef<string | null>(null);
  draftRef.current = draft;
  const pathRef = useRef(path);
  pathRef.current = path;

  const value = draft ?? stem;

  const capturePresentationTarget = useCallback((): PresentationAssetTarget | null => {
    const state = useStore.getState();
    const vault = state.vault;
    const vaultEpoch = vault?.epoch;
    const noteId = docId ?? null;
    if (
      !vault ||
      vaultEpoch == null ||
      state.openNote?.path !== path ||
      state.openNote.id !== noteId
    ) {
      return null;
    }
    return {
      vaultEpoch,
      vaultScope: vault.path,
      isCurrent: () => {
        const current = useStore.getState();
        return (
          current.vault?.epoch === vaultEpoch &&
          current.openNote?.path === path &&
          current.openNote.id === noteId
        );
      },
    };
  }, [docId, path]);

  const patch = useCallback(
    (values: Parameters<typeof applyPresentationPatch>[1]) => {
      const result = applyPresentationPatch(view, values);
      if (!result.ok) {
        setWarning(
          result.reason === "read-only"
            ? "This note is read-only."
            : "Edit this note's YAML source before changing its presentation.",
        );
        return false;
      }
      setWarning(null);
      return true;
    },
    [view],
  );

  const chooseIcon = (icon: PresentationIconValue) => {
    const existingColor = useStore.getState().itemColors[path];
    const portableColor =
      icon.kind === "lucide" && !presentation.iconColor &&
      ICON_COLOR_IDS.includes(existingColor as (typeof ICON_COLOR_IDS)[number])
        ? { kind: "text" as const, value: existingColor! }
        : undefined;
    return patch({
      [PRESENTATION_KEYS.icon]: { kind: "text", value: serializePresentationIcon(icon) },
      [PRESENTATION_KEYS.iconColor]: portableColor,
    });
  };

  const chooseCover = async () => {
    const target = capturePresentationTarget();
    if (!target) return;
    const result = await pickPresentationAsset("cover", target);
    if (!result) return;
    if ("error" in result) {
      setWarning(result.error);
      return;
    }
    patch({
      [PRESENTATION_KEYS.cover]: { kind: "text", value: result.path },
      [PRESENTATION_KEYS.coverSource]: result.sourcePath
        ? { kind: "text", value: result.sourcePath }
        : null,
      [PRESENTATION_KEYS.coverX]: { kind: "number", value: 50 },
      [PRESENTATION_KEYS.coverY]: { kind: "number", value: 50 },
      [PRESENTATION_KEYS.coverHeight]: { kind: "number", value: DEFAULT_COVER_HEIGHT },
    });
    setCoverError(false);
  };

  const dropCover = async (event: React.DragEvent) => {
    event.preventDefault();
    if (readOnly) return;
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const target = capturePresentationTarget();
    if (!target) return;
    const result = await savePresentationAsset(
      file.name,
      new Uint8Array(await file.arrayBuffer()),
      "cover",
      target,
    );
    if ("error" in result) {
      setWarning(result.error);
      return;
    }
    patch({
      [PRESENTATION_KEYS.cover]: { kind: "text", value: result.path },
      [PRESENTATION_KEYS.coverSource]: result.sourcePath
        ? { kind: "text", value: result.sourcePath }
        : null,
      [PRESENTATION_KEYS.coverX]: { kind: "number", value: 50 },
      [PRESENTATION_KEYS.coverY]: { kind: "number", value: 50 },
      [PRESENTATION_KEYS.coverHeight]: { kind: "number", value: DEFAULT_COVER_HEIGHT },
    });
  };

  const iconAsset =
    presentation.icon?.kind === "asset"
      ? resolveAsset?.(presentation.icon.path, "path")
      : null;
  const coverAsset =
    presentation.cover && !presentation.cover.startsWith("preset:")
      ? resolveAsset?.(presentation.cover, "path")
      : null;

  const commit = useCallback(async () => {
    const typed = draftRef.current;
    if (typed === null) return;
    const plan = planInlineTitleRename(pathRef.current, typed);
    if (!plan.ok) {
      if (plan.reason === "unchanged") {
        setDraft(null);
        setWarning(null);
        return;
      }
      setWarning(TITLE_REFUSAL_MESSAGE[plan.reason]);
      inputRef.current?.focus();
      return;
    }
    // Case-insensitive by way of the filesystem: `resolve_in_vault` goes
    // through the real path, and macOS treats `Foo.md` and `foo.md` as one.
    if (await noteExists(plan.nextPath)) {
      setWarning(`A note called "${plan.stem}" already exists here.`);
      inputRef.current?.focus();
      return;
    }
    const failure = await renameTo(plan.nextPath);
    if (failure) {
      setWarning(failure);
      inputRef.current?.focus();
      return;
    }
    setDraft(null);
    setWarning(null);
  }, [noteExists, renameTo]);

  // A pending rename must survive the widget going away — a note switch, ⌘N, or
  // the window closing all unmount us with the draft uncommitted. The widget's
  // `destroy` runs this before React unmounts the root.
  useEffect(() => {
    const flush = () => {
      if (draftRef.current !== null) void commit();
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [commit]);

  const toBody = useCallback(() => {
    const fm = view.state.field(frontmatterField, false) ?? null;
    view.dispatch({ selection: { anchor: bodyStart(fm, view.state.doc.length) } });
    view.focus();
  }, [view]);

  // A note that was just created lands here with its name selected: ⌘N (or the
  // sidebar's +) creates an EMPTY note called `Untitled`, and typing over that
  // is the whole naming flow. Consumed once, by the widget itself, because the
  // widget mounts several awaits after the create.
  useEffect(() => {
    const store = useStore.getState();
    if (store.pendingTitleFocus !== path) return;
    store.setPendingTitleFocus(null);
    const el = inputRef.current;
    el?.focus();
    el?.select();
  }, [path]);

  useEffect(() => {
    registerHeaderFocus(view, {
      focusTitle: (select?: boolean) => {
        const el = inputRef.current;
        if (!el) return false;
        el.focus();
        if (select) el.select();
        return true;
      },
    });
  }, [view]);

  return (
    <div className="inline-title-wrap">
      {presentation.cover ? (
        <div data-cover-drop="true" className={`note-cover${presentation.cover.startsWith("preset:") ? ` cover-${presentation.cover.slice(7)}` : ""}`} style={{ height: presentation.coverHeight }} onDragOver={(event) => { if (!readOnly) event.preventDefault(); }} onDrop={(event) => void dropCover(event)}>
          {coverAsset && !coverError ? (
            <img
              src={coverAsset}
              alt={presentation.coverAlt}
              style={{ objectPosition: `${presentation.coverX}% ${presentation.coverY}%` }}
              onError={() => setCoverError(true)}
              draggable={false}
            />
          ) : (
            <div className="note-cover-placeholder">
              <span>{coverError ? "Cover image is missing." : ""}</span>
              {coverError && !readOnly && <button type="button" onClick={() => void chooseCover()}>Retry or replace</button>}
            </div>
          )}
          {!readOnly && (
            <div className="note-cover-controls">
              <button type="button" onClick={() => void chooseCover()}>Change cover</button>
              <select
                aria-label="Choose cover preset"
                value={presentation.cover.startsWith("preset:") ? presentation.cover.slice(7) : ""}
                onChange={(event) => {
                  if (!event.target.value) return;
                  patch({
                    [PRESENTATION_KEYS.cover]: {
                      kind: "text",
                      value: `preset:${event.target.value}`,
                    },
                    [PRESENTATION_KEYS.coverSource]: null,
                  });
                  setCoverError(false);
                }}
              >
                <option value="" disabled>Preset…</option>
                {COVER_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.label}</option>
                ))}
              </select>
              <button type="button" onClick={() => setCoverEditing((value) => !value)}>Reposition</button>
              <button type="button" onClick={() => patch({
                [PRESENTATION_KEYS.cover]: null,
                [PRESENTATION_KEYS.coverSource]: null,
              })}>Remove</button>
            </div>
          )}
          {coverEditing && !readOnly && (
            <div className="note-cover-fields">
              <label>X <input aria-label="Cover horizontal position" type="range" min="0" max="100" value={presentation.coverX} onChange={(event) => patch({ [PRESENTATION_KEYS.coverX]: { kind: "number", value: Number(event.target.value) } })} /></label>
              <label>Y <input aria-label="Cover vertical position" type="range" min="0" max="100" value={presentation.coverY} onChange={(event) => patch({ [PRESENTATION_KEYS.coverY]: { kind: "number", value: Number(event.target.value) } })} /></label>
              <label>Height <input aria-label="Cover height" type="range" min="120" max="420" value={presentation.coverHeight} onChange={(event) => patch({ [PRESENTATION_KEYS.coverHeight]: { kind: "number", value: Number(event.target.value) } })} /></label>
              <label>Alt <input aria-label="Cover description" type="text" value={presentation.coverAlt} onChange={(event) => patch({ [PRESENTATION_KEYS.coverAlt]: { kind: "text", value: event.target.value } })} /></label>
            </div>
          )}
        </div>
      ) : !readOnly ? (
        <div data-cover-drop="true" className="note-cover-add-row" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void dropCover(event)}>
          <button type="button" className="note-add-cover" onClick={() => void chooseCover()}>Add cover</button>
          {COVER_PRESETS.map((preset) => (
            <button key={preset.id} type="button" className={`cover-preset-chip cover-${preset.id}`} onClick={() => patch({
              [PRESENTATION_KEYS.cover]: { kind: "text", value: `preset:${preset.id}` },
              [PRESENTATION_KEYS.coverSource]: null,
            })}>{preset.label}</button>
          ))}
        </div>
      ) : null}
      <div className="note-title-row">
        <span className="presentation-anchor">
          <button ref={iconButtonRef} type="button" className="presentation-icon-button" style={presentation.icon?.kind === "lucide" ? { color: itemColorValue(presentation.iconColor ?? undefined) } : undefined} disabled={readOnly} aria-label={presentation.icon ? "Change icon" : "Add icon"} onClick={() => setPickerOpen((open) => !open)}>
            {presentation.icon ? (
              <PresentationIcon icon={presentation.icon} assetUrl={iconAsset} className="presentation-icon" />
            ) : (
              <span aria-hidden="true">+</span>
            )}
          </button>
          {pickerOpen && !readOnly && (
            <ViewportMenu
              anchorRef={iconButtonRef}
              menuRef={iconMenuRef}
              align="start"
              className="inline-icon-picker-host"
            >
              <Suspense fallback={<div className="icon-picker">Loading icons…</div>}>
                <IconPicker
                  captureAssetTarget={capturePresentationTarget}
                  vaultScope={vaultPath}
                  assetExists={(assetPath) => {
                    const target = capturePresentationTarget();
                    return target?.isCurrent()
                      ? ipc.noteExists(assetPath, target.vaultEpoch)
                      : Promise.resolve(false);
                  }}
                  onChoose={chooseIcon}
                  resolveAsset={(assetPath, sourceKind) =>
                    resolveAsset?.(assetPath, sourceKind) ?? null
                  }
                  onReset={() => {
                    return presentation.icon
                      ? patch({ [PRESENTATION_KEYS.icon]: null })
                      : true;
                  }}
                  onClose={() => setPickerOpen(false)}
                />
              </Suspense>
            </ViewportMenu>
          )}
        </span>
        <input
          ref={inputRef}
          className="inline-title-input"
        type="text"
        value={value}
        readOnly={readOnly}
        disabled={readOnly}
        aria-readonly={readOnly}
        aria-label="Note name"
        placeholder="Untitled"
        spellCheck
        autoCapitalize="off"
        autoCorrect="off"
        enterKeyHint="done"
        onChange={(e) => {
          if (readOnly) return;
          setWarning(null);
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit().then(() => {
              if (draftRef.current === null) toBody();
            });
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
            setWarning(null);
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!getHeaderFocus(view).focusFirstProperty?.()) toBody();
            return;
          }
          if (e.key === ";" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            addPropertyToNote(view);
          }
        }}
          onBlur={() => void commit()}
        />
      </div>
      {presentation.icon?.kind === "lucide" && !readOnly && (
        <div className="icon-color-row" aria-label="Icon color">
          {ITEM_COLORS.map((color) => (
            <button
              key={color.id}
              type="button"
              className={presentation.iconColor === color.id ? "active" : ""}
              aria-label={color.label}
              title={color.label}
              style={{ backgroundColor: itemColorValue(color.id) }}
              onClick={() => patch({ [PRESENTATION_KEYS.iconColor]: { kind: "text", value: color.id } })}
            />
          ))}
        </div>
      )}
      {warning && (
        <p className="inline-title-warning" role="alert">
          {warning}
        </p>
      )}
      {!hasFrontmatter && !readOnly && (
        <button
          type="button"
          className="inline-title-add"
          onClick={() => addPropertyToNote(view)}
        >
          Add property
        </button>
      )}
    </div>
  );
}
