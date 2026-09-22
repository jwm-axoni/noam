// The flair on every fenced code block: a language label and a copy button.
//
// One inline widget, `side: 1` at the END of the opening fence line, so it rides
// the fence rather than the code: no block decoration, no height the layout has
// to account for. livePreview.ts hides the fence TEXT while the block is not
// being edited, so the label is how you still see what a fence claims to be;
// put the caret in the block and the raw ```lang comes back beside it.
//
// `html` fences are skipped: live preview replaces those with a rendered
// preview, so the flair would be attached to a line that is not on screen.
//
// Positioning is `position: absolute` against the line box (theme.ts gives
// `.cm-line` `position: relative`), pinned to the right edge of the prose
// column with `--editor-pad-x` — the same inset every other full-width line
// decoration uses.

import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { copyText } from "../clipboard";

/** How long the button says "Copied" before going back to "Copy". */
const COPIED_MS = 1200;

/** Fences whose content is rendered instead of shown (see livePreview.ts). */
const RENDERED = new Set(["html", "htm"]);

class FenceFlairWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly lang: string,
  ) {
    super();
  }
  eq(other: FenceFlairWidget) {
    return other.code === this.code && other.lang === this.lang;
  }
  toDOM() {
    const flair = document.createElement("span");
    flair.className = "cm-fence-flair";
    if (this.lang) {
      const label = document.createElement("span");
      label.className = "cm-fence-lang";
      label.textContent = this.lang;
      flair.appendChild(label);
    }
    if (this.code.trim()) flair.appendChild(this.copyButton());
    return flair;
  }
  private copyButton() {
    const button = document.createElement("button");
    button.className = "cm-fence-copy";
    button.type = "button";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy code");
    button.addEventListener("mousedown", (event) => {
      // `mousedown`, and prevented: a click must not move the caret into the
      // fence, and must not steal focus from the text the writer was in.
      event.preventDefault();
      void copyText(this.code).then((ok) => {
        if (!ok) return;
        button.textContent = "Copied";
        // The timer lives on the node, so a re-render (any keystroke inside the
        // fence rebuilds this widget) cannot leave a stray timeout behind that
        // relabels a button belonging to a different block.
        const node = button as HTMLButtonElement & { _revert?: number };
        window.clearTimeout(node._revert);
        node._revert = window.setTimeout(() => {
          button.textContent = "Copy";
        }, COPIED_MS);
      });
    });
    return button;
  }
  ignoreEvent() {
    // False, or CodeMirror swallows the mousedown before the listener above.
    return false;
  }
}

function buildFlair(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const decos: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "FencedCode") return;
        const info = node.node.getChild("CodeInfo");
        // The first word only: `ts title="x.ts"` is a TypeScript fence.
        const lang = info ? (doc.sliceString(info.from, info.to).trim().split(/\s/)[0] ?? "") : "";
        if (RENDERED.has(lang.toLowerCase())) return false;
        const body = node.node.getChild("CodeText");
        const code = body ? doc.sliceString(body.from, body.to) : "";
        if (!code.trim() && !lang) return false;
        const openLine = doc.lineAt(node.from);
        decos.push(
          Decoration.widget({ widget: new FenceFlairWidget(code, lang), side: 1 }).range(
            openLine.to,
          ),
        );
        return false;
      },
    });
  }
  return Decoration.set(decos, true);
}

export const codeFenceFlair = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildFlair(view);
    }
    update(u: ViewUpdate) {
      // Doc and viewport only: the button does not care where the caret is.
      if (u.docChanged || u.viewportChanged) this.decorations = buildFlair(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
