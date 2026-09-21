import { syntaxTree } from "@codemirror/language";
import { type ChangeSpec, type EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { viewMode } from "./viewMode";
import { findFrontmatter } from "./frontmatter";

export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink", "purple"] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

interface HighlightSpan {
  from: number;
  contentFrom: number;
  contentTo: number;
  to: number;
  color: HighlightColor;
  syntax: "default" | "html";
}

const COLORED_MARK_RE =
  /<mark data-noam-color="(yellow|green|blue|pink|purple)">([^\n]*?)<\/mark>/g;
const DEFAULT_MARK_RE = /==([^\n]*?)==/g;

function spansInLine(text: string): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  for (const match of text.matchAll(COLORED_MARK_RE)) {
    const from = match.index;
    const openLength = match[0].indexOf(">") + 1;
    spans.push({
      from,
      contentFrom: from + openLength,
      contentTo: from + match[0].lastIndexOf("</mark>"),
      to: from + match[0].length,
      color: match[1] as HighlightColor,
      syntax: "html",
    });
  }
  for (const match of text.matchAll(DEFAULT_MARK_RE)) {
    const from = match.index;
    if (spans.some((span) => from >= span.from && from < span.to)) continue;
    spans.push({
      from,
      contentFrom: from + 2,
      contentTo: from + match[0].length - 2,
      to: from + match[0].length,
      color: "yellow",
      syntax: "default",
    });
  }
  return spans.sort((a, b) => a.from - b.from);
}

function openMark(color: HighlightColor | null): string {
  if (color === null) return "";
  return color === "yellow" ? "==" : `<mark data-noam-color="${color}">`;
}

function closeMark(color: HighlightColor | null): string {
  if (color === null) return "";
  return color === "yellow" ? "==" : "</mark>";
}

interface TextRange {
  from: number;
  to: number;
}

interface ToolbarPlacement {
  left: number;
  top: number;
  placement: "above" | "below";
}

function rawSelectionRanges(state: EditorState): TextRange[] {
  return state.selection.ranges.flatMap((range): TextRange[] => {
    if (!range.empty) return [{ from: range.from, to: range.to }];
    const word = state.wordAt(range.head);
    return word ? [{ from: word.from, to: word.to }] : [];
  });
}

const PROTECTED_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock"]);

function protectedRanges(state: EditorState): TextRange[] {
  const ranges: TextRange[] = [];
  const frontmatter = findFrontmatter(state.doc);
  if (frontmatter) ranges.push({ from: frontmatter.from, to: frontmatter.to });
  syntaxTree(state).iterate({
    enter(node) {
      if (PROTECTED_NODES.has(node.name)) {
        ranges.push({ from: node.from, to: node.to });
        return false;
      }
      return undefined;
    },
  });
  return ranges.sort((a, b) => a.from - b.from);
}

function subtractProtected(range: TextRange, protectedItems: readonly TextRange[]): TextRange[] {
  let pieces = [range];
  for (const blocked of protectedItems) {
    pieces = pieces.flatMap((piece) => {
      if (blocked.to <= piece.from || blocked.from >= piece.to) return [piece];
      const next: TextRange[] = [];
      if (blocked.from > piece.from) next.push({ from: piece.from, to: blocked.from });
      if (blocked.to < piece.to) next.push({ from: blocked.to, to: piece.to });
      return next;
    });
  }
  return pieces;
}

function structuralPrefixLength(text: string): number {
  let offset = 0;
  const quote = text.slice(offset).match(/^(?:\s{0,3}>[ \t]?)+/);
  if (quote) offset += quote[0].length;
  const marker = text.slice(offset).match(
    /^(?:\s{0,3}#{1,6}[ \t]+|\s{0,3}(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/,
  );
  if (marker) offset += marker[0].length;
  return offset;
}

function selectedLines(state: EditorState): Map<number, TextRange[]> {
  const byLine = new Map<number, TextRange[]>();
  const blocked = protectedRanges(state);
  for (const raw of rawSelectionRanges(state)) {
    for (const range of subtractProtected(raw, blocked)) {
      const startLine = state.doc.lineAt(range.from).number;
      const endLine = state.doc.lineAt(Math.max(range.from, range.to - 1)).number;
      for (let number = startLine; number <= endLine; number++) {
        const line = state.doc.line(number);
        let from = Math.max(range.from, line.from) - line.from;
        let to = Math.min(range.to, line.to) - line.from;
        from = Math.max(from, structuralPrefixLength(line.text));
        while (from < to && /\s/.test(line.text[from])) from++;
        while (to > from && /\s/.test(line.text[to - 1])) to--;
        if (from === to) continue;
        const ranges = byLine.get(number) ?? [];
        ranges.push({ from, to });
        byLine.set(number, ranges);
      }
    }
  }
  for (const [number, ranges] of byLine) {
    ranges.sort((a, b) => a.from - b.from);
    const merged: typeof ranges = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
      else merged.push({ ...range });
    }
    byLine.set(number, merged);
  }
  return byLine;
}

function rangeHasStyle(
  spans: readonly HighlightSpan[],
  from: number,
  to: number,
  color: HighlightColor,
): boolean {
  let coveredTo = from;
  for (const span of spans) {
    if (span.color !== color || span.to <= coveredTo) continue;
    if (span.from > coveredTo) return false;
    coveredTo = Math.max(coveredTo, span.to);
    if (coveredTo >= to) return true;
  }
  return false;
}

function selected(from: number, to: number, ranges: readonly TextRange[]): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}

function segmentsForSpan(
  span: HighlightSpan,
  ranges: readonly TextRange[],
  target: HighlightColor | null,
): Array<{ from: number; to: number; color: HighlightColor | null }> {
  const cuts = new Set([span.contentFrom, span.contentTo]);
  for (const range of ranges) {
    if (range.to <= span.contentFrom || range.from >= span.contentTo) continue;
    cuts.add(Math.max(span.contentFrom, range.from));
    cuts.add(Math.min(span.contentTo, range.to));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const segments = points.slice(0, -1).map((from, index) => {
    const to = points[index + 1];
    return { from, to, color: selected(from, to, ranges) ? target : span.color };
  });
  return segments.filter((segment) => segment.from < segment.to);
}

function markerChangesForLine(
  text: string,
  ranges: readonly TextRange[],
  requested: HighlightColor | null,
  lineOffset: number,
): ChangeSpec[] {
  const spans = spansInLine(text);
  const toggleOff =
    requested !== null &&
    ranges.every((range) => rangeHasStyle(spans, range.from, range.to, requested));
  const target = toggleOff ? null : requested;
  const changes: ChangeSpec[] = [];

  for (const span of spans) {
    if (!ranges.some((range) => range.from < span.contentTo && range.to > span.contentFrom)) continue;
    const segments = segmentsForSpan(span, ranges, target);
    if (segments.length === 0) continue;
    const nextOpen = openMark(segments[0].color);
    if (text.slice(span.from, span.contentFrom) !== nextOpen) {
      changes.push({
        from: lineOffset + span.from,
        to: lineOffset + span.contentFrom,
        insert: nextOpen,
      });
    }
    for (let index = 0; index < segments.length - 1; index++) {
      const left = segments[index];
      const right = segments[index + 1];
      if (left.color === right.color) continue;
      changes.push({
        from: lineOffset + left.to,
        insert: closeMark(left.color) + openMark(right.color),
      });
    }
    const nextClose = closeMark(segments[segments.length - 1].color);
    if (text.slice(span.contentTo, span.to) !== nextClose) {
      changes.push({
        from: lineOffset + span.contentTo,
        to: lineOffset + span.to,
        insert: nextClose,
      });
    }
  }

  for (const range of ranges) {
    let cursor = range.from;
    for (const span of spans) {
      if (span.to <= cursor || span.from >= range.to) continue;
      if (cursor < Math.min(span.from, range.to) && target !== null) {
        const to = Math.min(span.from, range.to);
        changes.push({ from: lineOffset + cursor, insert: openMark(target) });
        changes.push({ from: lineOffset + to, insert: closeMark(target) });
      }
      cursor = Math.max(cursor, Math.min(range.to, span.to));
    }
    if (cursor < range.to && target !== null) {
      changes.push({ from: lineOffset + cursor, insert: openMark(target) });
      changes.push({ from: lineOffset + range.to, insert: closeMark(target) });
    }
  }
  return changes;
}

/** Apply, recolor, or clear all current selections in one editor transaction. */
export function applyHighlight(color: HighlightColor | null) {
  return (view: EditorView): boolean => {
    if (view.state.readOnly) return false;
    const lines = selectedLines(view.state);
    if (lines.size === 0) return false;
    const changes = [...lines.entries()].flatMap(([number, ranges]) => {
      const line = view.state.doc.line(number);
      return markerChangesForLine(line.text, ranges, color, line.from);
    });
    if (changes.length === 0) return false;
    view.dispatch({ changes, userEvent: "input.format.highlight" });
    return true;
  };
}

function coloredDecorations(view: EditorView): DecorationSet {
  const ranges: Array<Range<Decoration>> = [];
  const mode = view.state.facet(viewMode);
  const source = mode === "source";
  const doc = view.state.doc;
  const blocked = protectedRanges(view.state);
  for (let number = 1; number <= doc.lines; number++) {
    const line = doc.line(number);
    for (const span of spansInLine(line.text).filter((item) => item.syntax === "html")) {
      const from = line.from + span.from;
      const contentFrom = line.from + span.contentFrom;
      const contentTo = line.from + span.contentTo;
      const to = line.from + span.to;
      if (contentFrom === contentTo) continue;
      if (blocked.some((range) => range.from < to && range.to > from)) continue;
      ranges.push(
        Decoration.mark({ class: `cm-colored-highlight cm-highlight-${span.color}` }).range(
          contentFrom,
          contentTo,
        ),
      );
      const editing = view.state.selection.ranges.some(
        (selection) => selection.from <= to && selection.to >= from,
      );
      if (!source && (mode === "reading" || !editing)) {
        ranges.push(Decoration.replace({}).range(from, contentFrom));
        ranges.push(Decoration.replace({}).range(contentTo, to));
      }
    }
  }
  return Decoration.set(ranges, true);
}

class HighlightTools {
  decorations: DecorationSet;
  readonly toolbar: HTMLDivElement;
  readonly view: EditorView;
  dismissed = false;
  readonly reposition = () => this.position();
  readonly measurePosition = {
    key: this,
    read: () => this.readPosition(),
    write: (placement: ToolbarPlacement | null) => this.writePosition(placement),
  };

  constructor(view: EditorView) {
    this.view = view;
    this.decorations = coloredDecorations(view);
    this.toolbar = document.createElement("div");
    this.toolbar.className = "cm-highlight-toolbar";
    this.toolbar.setAttribute("role", "toolbar");
    this.toolbar.setAttribute("aria-label", "Highlight selection");
    this.toolbar.setAttribute("aria-orientation", "horizontal");
    this.toolbar.setAttribute("aria-keyshortcuts", "Alt+Shift+H");
    for (const color of HIGHLIGHT_COLORS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `cm-highlight-choice cm-highlight-${color}`;
      button.title = `${color[0].toUpperCase()}${color.slice(1)} highlight`;
      button.setAttribute("aria-label", button.title);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => applyHighlight(color)(this.view));
      this.toolbar.append(button);
    }
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "cm-highlight-clear";
    clear.textContent = "Clear";
    clear.addEventListener("mousedown", (event) => event.preventDefault());
    clear.addEventListener("click", () => applyHighlight(null)(this.view));
    this.toolbar.append(clear);
    this.toolbar.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.dismissed = true;
        this.toolbar.hidden = true;
        this.view.focus();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const buttons = [...this.toolbar.querySelectorAll<HTMLButtonElement>("button")];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowRight" ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    });
    this.toolbar.addEventListener("focusin", this.reposition);
    this.toolbar.addEventListener("focusout", () => queueMicrotask(this.reposition));
    document.body.append(this.toolbar);
    this.view.scrollDOM.addEventListener("scroll", this.reposition, { passive: true });
    window.addEventListener("resize", this.reposition);
    this.position();
  }

  update(update: ViewUpdate) {
    this.decorations = coloredDecorations(update.view);
    if (update.selectionSet) this.dismissed = false;
    // ViewPlugin.update runs inside CodeMirror's update phase. Layout reads
    // such as coordsAtPos are forbidden there and make CodeMirror drop the
    // entire plugin. Defer the read and write through its measured-layout API.
    this.view.requestMeasure(this.measurePosition);
  }

  focus() {
    if (this.view.state.selection.main.empty || this.view.state.readOnly) return false;
    this.dismissed = false;
    this.toolbar.hidden = false;
    this.position();
    this.toolbar.querySelector<HTMLButtonElement>("button")?.focus();
    return true;
  }

  position() {
    this.writePosition(this.readPosition());
  }

  readPosition(): ToolbarPlacement | null {
    const selection = this.view.state.selection.main;
    const show =
      !this.dismissed &&
      (this.view.hasFocus || this.toolbar.contains(document.activeElement)) &&
      !selection.empty &&
      !this.view.state.readOnly &&
      this.view.state.facet(viewMode) !== "reading";
    if (!show) return null;
    const start = this.view.coordsAtPos(selection.from);
    const end = this.view.coordsAtPos(selection.to);
    if (!start || !end) return null;
    const bounds = this.toolbar.getBoundingClientRect();
    const width = Math.min(bounds.width || 250, Math.max(0, window.innerWidth - 16));
    const height = bounds.height || 40;
    const half = width / 2;
    const desiredLeft = (start.left + end.right) / 2;
    const left = Math.max(8 + half, Math.min(window.innerWidth - 8 - half, desiredLeft));
    const above = Math.min(start.top, end.top) - 8;
    const placeBelow = above - height < 8;
    const top = placeBelow
      ? Math.min(window.innerHeight - height - 8, Math.max(start.bottom, end.bottom) + 8)
      : above;
    return {
      left,
      top: Math.max(8, top),
      placement: placeBelow ? "below" : "above",
    };
  }

  writePosition(placement: ToolbarPlacement | null) {
    this.toolbar.hidden = placement === null;
    if (!placement) return;
    this.toolbar.dataset.placement = placement.placement;
    this.toolbar.style.left = `${placement.left}px`;
    this.toolbar.style.top = `${placement.top}px`;
  }

  destroy() {
    this.view.scrollDOM.removeEventListener("scroll", this.reposition);
    window.removeEventListener("resize", this.reposition);
    this.toolbar.remove();
  }
}

const highlightToolsPlugin = ViewPlugin.fromClass(HighlightTools, {
  decorations: (value) => value.decorations,
});

function focusHighlightToolbar(view: EditorView): boolean {
  return view.plugin(highlightToolsPlugin)?.focus() ?? false;
}

/** Colored mark rendering, selection toolbar, and command key bindings. */
export function coloredHighlights(): Extension {
  return [
    highlightToolsPlugin,
    keymap.of([
      // Mod-Shift-h belongs to the portable `==highlight==` command in
      // formatting.ts. Keep toolbar focus distinct instead of registering a
      // second unreachable binding with different output.
      { key: "Alt-Shift-h", run: focusHighlightToolbar, preventDefault: true },
    ]),
  ];
}

export const coloredHighlightTest = { spansInLine, markerChangesForLine };
