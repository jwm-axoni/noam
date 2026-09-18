// Editor factory. Builds the CodeMirror 6 extension set for a markdown note.
// Designed so Phase 1 can append a Yjs `y-codemirror.next` binding to
// `extraExtensions` without changing any callsite.

import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension, Prec, Text } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  keymap,
  type KeyBinding,
  lineNumbers,
} from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import type { NoteTitle } from "../ipc";
import { blockDecorations } from "./blocks";
import { codeFenceFlair } from "./codeFence";
import { codeLanguages } from "./codeLanguages";
import { folding, preserveFoldsAcrossModes } from "./folding";
import { formattingKeymap } from "./formatting";
import { frontmatterDecorations } from "./frontmatter";
import { indentGuides } from "./indentGuides";
import { listKeymap } from "./lists";
import { livePreview } from "./livePreview";
import { noteHeader, type NoteHeaderOptions } from "./noteHeader";
import { ofmDecorations, ofmMarkdown, tagCompletions, type TagSuggestion } from "./ofm";
import { smartPaste, type SaveAttachment } from "./paste";
import { tableAtomicRanges } from "./table/atomic";
import { tripleClickLine } from "./selection";
import { revealState } from "./reveal";
import { slashCompletions } from "./slash";
import { checkboxes, taskKeymap } from "./tasks";
import { editorTheme, markdownHighlight } from "./theme";
import { viewMode as viewModeFacet, type ViewMode } from "./viewMode";
import { wikilinkCompletions, wikilinks } from "./wikilinks";

export interface CreateEditorOptions {
  doc: string;
  getTitles: () => NoteTitle[];
  /**
   * Every `#tag` in the vault, most-used first, for the `#` completion. Omitted
   * (the version-preview view, the tests) → typing `#` suggests nothing.
   */
  getTags?: () => TagSuggestion[];
  onNavigate: (target: string) => void;
  /** Phase-0 buffer callback; omitted for CRDT-managed notes (yCollab syncs). */
  onChange?: (doc: string) => void;
  /** Later phases (Yjs binding) append here. */
  extraExtensions?: Extension[];
  /**
   * Turn an image `src` from a note into a URL the webview can load. Local
   * vault paths become `asset:` URLs (via convertFileSrc); http/data URLs pass
   * through. Omitted → images render with their raw `src`.
   */
  resolveAsset?: (src: string) => string;
  /**
   * Persist pasted/dropped image bytes into the vault and return the markdown
   * `src` to embed. Omitted → image paste/drop falls back to default handling.
   */
  saveAttachment?: SaveAttachment;
  /**
   * When true, a Yjs `y-codemirror.next` binding (passed via extraExtensions)
   * owns change propagation and undo history, so we drop CM6's local
   * `history()` + its keymap and the buffer `onChange` listener (spec 03 §5).
   */
  collab?: boolean;
  /**
   * The inline title + Properties panel above the body. Omitted for editors
   * with no note behind them — the version-preview view and the tests — which
   * then keep the plain dimmed frontmatter block.
   */
  header?: NoteHeaderOptions;
  /**
   * Show the line-number gutter (Settings → Appearance; off by default, because
   * a gutter takes real width from the prose column). Compartmented so the
   * toggle reconfigures the live view instead of rebuilding it.
   */
  lineNumbers?: { on: boolean; compartment: Compartment };
  /**
   * Live Preview, literal Markdown source, or rendered read-only presentation.
   * Compartmented so switching modes keeps this EditorView and its Y.Text
   * binding alive.
   */
  viewMode?: { mode: ViewMode; compartment: Compartment };
}

/** The `lineNumbers()` gutter, or nothing. Exported for the Editor's toggle. */
export function lineNumberExtension(on: boolean): Extension {
  return on ? lineNumbers() : [];
}

/** CodeMirror's two editability facets, shared by access locks and Reading. */
export function editableExtensions(readOnly: boolean): Extension {
  return readOnly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [];
}

/**
 * Consume native undo/redo input while the current state is locked. The Yjs
 * binding owns its own `beforeinput` handler, so CodeMirror's read-only facet
 * cannot stop it for us. Highest precedence makes this guard run before the
 * binding without blocking ordinary incoming Y.Text transactions.
 */
export const readOnlyHistoryGuard = Prec.highest(
  EditorView.domEventHandlers({
    beforeinput(event, view) {
      if (
        view.state.readOnly &&
        (event.inputType === "historyUndo" || event.inputType === "historyRedo")
      ) {
        event.preventDefault();
        return true;
      }
      return false;
    },
  }),
);

/** Guard third-party commands that mutate outside CodeMirror's input pipeline. */
export function readOnlyGuardedKeymap(bindings: readonly KeyBinding[]): KeyBinding[] {
  return bindings.map((binding) => ({
    ...binding,
    run: (view) => (view.state.readOnly ? true : (binding.run?.(view) ?? false)),
  }));
}

/**
 * Everything that changes how Markdown is presented. Source deliberately
 * installs no marker-hiding, replacement widgets, folding, or decorative line
 * classes; syntax highlighting and dimmed frontmatter remain in the stable
 * base below. Reading uses the Live Preview set but contributes read-only
 * facets and a theme hook for its local-caret treatment.
 */
export function presentationExtensions(
  mode: ViewMode,
  opts: Pick<CreateEditorOptions, "getTitles" | "onNavigate" | "resolveAsset">,
): Extension[] {
  const live = mode !== "source";
  return [
    viewModeFacet.of(mode),
    ...(mode === "reading"
      ? [editableExtensions(true), EditorView.editorAttributes.of({ class: "cm-reading" })]
      : []),
    ...(live
      ? [
          blockDecorations,
          livePreview({ resolveAsset: opts.resolveAsset, onNavigate: opts.onNavigate }),
          tableAtomicRanges,
          checkboxes,
          codeFenceFlair,
          wikilinks({ getTitles: opts.getTitles, onNavigate: opts.onNavigate }),
          ...ofmDecorations,
          ...folding,
          keymap.of(foldKeymap),
          ...indentGuides,
        ]
      : []),
  ];
}

export function baseExtensions(opts: CreateEditorOptions): Extension[] {
  const collab = opts.collab ?? false;
  const mode = opts.viewMode?.mode ?? "live";
  const keys = [
    ...closeBracketsKeymap,
    ...defaultKeymap,
    // CRDT notes use the Yjs UndoManager keymap (added via extraExtensions);
    // the local CM6 history keymap would fight it, so drop it in collab mode.
    ...(collab ? [] : historyKeymap),
    ...searchKeymap,
  ];

  return [
    // Split every STRING change on LF only. This is not merely an initial-load
    // choice: Yjs undo, remote updates, disk ingestion and paste all dispatch
    // strings later, and the default /\r\n?|\n/ splitter would drop CR bytes and
    // desynchronise CodeMirror offsets from Y.Text.
    EditorState.lineSeparator.of("\n"),
    // Local history only for the non-CRDT path; yCollab supplies undo otherwise.
    ...(collab ? [] : [history()]),
    drawSelection(),
    // Triple-click selects a line's content without its trailing newline, so
    // the selection highlight doesn't bleed onto the next line.
    tripleClickLine,
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    // Two spaces: what `lists.ts`'s Tab, `indentOnInput` and every CodeMirror
    // indent command all read, so there is one answer to "how wide is a level".
    indentUnit.of("  "),
    EditorView.lineWrapping,
    closeBrackets(),
    // Markdown-aware editing keys, ahead of the base keymap so they win:
    //   Mod-b/i/k/…    inline formatting toggles (⌘E cycles view mode)
    //   Mod-Alt-1…6    heading level      Shift-Enter  hard break
    //   Mod-l          task toggle        Tab/Shift-Tab list indent
    // (Enter is lang-markdown's, at `Prec.high` — see lists.ts.)
    formattingKeymap(),
    listKeymap(),
    taskKeymap(),
    keymap.of(keys),
    readOnlyHistoryGuard,
    Prec.highest(
      keymap.of([
        {
          key: "Ctrl-Space",
          run: (view) => view.state.readOnly,
          preventDefault: true,
        },
      ]),
    ),
    // One stable completion field avoids leaving autocomplete's DOM timers
    // holding a removed StateField. Sources and custom apply callbacks reject
    // read-only states; Editor closes any open tooltip before entering Reading.
    autocompletion({
      override: [
        slashCompletions,
        wikilinkCompletions({ getTitles: opts.getTitles, onNavigate: opts.onNavigate }),
        ...(opts.getTags ? [tagCompletions({ getTags: opts.getTags })] : []),
      ],
    }),
    // GFM adds tables, task lists, strikethrough, and autolinks; `ofmMarkdown`
    // adds Obsidian's `==highlight==`, `%%comment%%` and `#tag` on top, so a
    // vault reads the same here and in Obsidian.
    // `codeLanguages` are LanguageDescriptions with dynamic imports: nothing
    // here reaches the startup bundle, and a grammar is fetched only when a
    // fence in an open note claims that language.
    markdown({
      base: markdownLanguage,
      extensions: [GFM, ...ofmMarkdown],
      codeLanguages,
    }),
    markdownHighlight,
    // Stable across presentation reconfiguration: switching Source back to
    // Live while the DOM is still focused must not forget that the caret is
    // active until the next blur/focus pair.
    ...revealState,
    // Source deliberately removes folding. Keep its last fold anchors in a
    // stable field and restore them when presentation returns to Live/Reading.
    ...preserveFoldsAcrossModes,
    // Frontmatter first: blocks.ts and livePreview.ts both read its range so
    // nothing else decorates inside it (see lib/editor/frontmatter.ts).
    frontmatterDecorations,
    // The inline title and the Properties panel. After frontmatterDecorations,
    // which yields the region to it (one authority: `frontmatterView`).
    ...(opts.header ? [noteHeader(opts.header)] : []),
    ...(opts.viewMode
      ? [opts.viewMode.compartment.of(presentationExtensions(mode, opts))]
      : presentationExtensions(mode, opts)),
    // Paste a URL over a selection → link; paste/drop an image → attachment.
    smartPaste(opts.saveAttachment),
    editorTheme,
    ...(opts.lineNumbers
      ? [opts.lineNumbers.compartment.of(lineNumberExtension(opts.lineNumbers.on))]
      : []),
    // Only mirror doc changes into the store buffer for the Phase-0 path.
    ...(collab || !opts.onChange
      ? []
      : [
          EditorView.updateListener.of((u) => {
            if (u.docChanged) opts.onChange!(u.state.doc.toString());
          }),
        ]),
    ...(opts.extraExtensions ?? []),
  ];
}

export function createEditorState(opts: CreateEditorOptions): EditorState {
  // CodeMirror's string loader splits on /\r\n?|\n/ and silently drops the CR
  // bytes in an existing CRLF note. Build Text by splitting only on LF so the
  // CR remains part of each line: the editor and Y.Text then keep identical
  // character offsets and a no-edit open/close stays byte-for-byte lossless.
  return EditorState.create({
    doc: Text.of(opts.doc.split("\n")),
    extensions: baseExtensions(opts),
  });
}
