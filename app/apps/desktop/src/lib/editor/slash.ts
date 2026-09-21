// Slash-command block menu. Type `/` at the start of a line to open a menu of
// block templates (headings, lists, tasks, quote, code, table, divider) plus
// the vault's own workflows. It reuses CodeMirror's autocomplete surface, so it
// looks and keys like the `[[wiki-link]]` menu. A block option replaces the
// `/query` it was triggered from with the block's markdown and parks the caret
// where you'd start typing; a workflow option removes the `/query` and hands
// off to the shared run flow.
//
// The workflows arrive through an INJECTED source rather than an import of the
// command service. This file has to stay testable in plain Node — and the run
// flow is React — so the only thing it knows is a list, a runner and "which
// note is open".

import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** Build an `apply` that replaces the trigger with `insert`, caret at `caret`
 *  (offset from the insert start) or selecting [selFrom, selTo). */
function applyBlock(
  insert: string,
  caret: number,
  selTo?: number
): (view: EditorView, c: Completion, from: number, to: number) => void {
  return (view, _c, from, to) => {
    // A completion can be accepted with the pointer after the editor became
    // read-only. Enter is guarded by CodeMirror, custom apply callbacks are not.
    if (view.state.readOnly) return;
    view.dispatch({
      changes: { from, to, insert },
      selection:
        selTo != null
          ? EditorSelection.range(from + caret, from + selTo)
          : EditorSelection.cursor(from + caret),
      scrollIntoView: true,
      userEvent: "input.complete",
    });
  };
}

interface Block {
  label: string;
  detail: string;
  keywords: string;
  insert: string;
  caret: number;
  selTo?: number;
}

const BLOCKS: Block[] = [
  { label: "Heading 1", detail: "#", keywords: "h1 title", insert: "# ", caret: 2 },
  { label: "Heading 2", detail: "##", keywords: "h2", insert: "## ", caret: 3 },
  { label: "Heading 3", detail: "###", keywords: "h3", insert: "### ", caret: 4 },
  { label: "Bullet list", detail: "-", keywords: "ul unordered", insert: "- ", caret: 2 },
  { label: "Numbered list", detail: "1.", keywords: "ol ordered", insert: "1. ", caret: 3 },
  { label: "Task", detail: "- [ ]", keywords: "todo checkbox", insert: "- [ ] ", caret: 6 },
  { label: "Quote", detail: ">", keywords: "blockquote", insert: "> ", caret: 2 },
  {
    label: "Code block",
    detail: "```",
    keywords: "fence pre",
    insert: "```\n\n```",
    caret: 4, // inside the fences (after "```\n")
  },
  {
    label: "Table",
    detail: "columns",
    keywords: "grid",
    insert: "| Column | Column |\n| --- | --- |\n|  |  |",
    caret: 2, // select the first header cell
    selTo: 8,
  },
  { label: "Divider", detail: "---", keywords: "hr rule separator", insert: "---\n", caret: 4 },
];

/** One workflow, as the slash menu needs to see it. */
export interface SlashWorkflowItem {
  id: string;
  name: string;
  description?: string;
  /** `slash: false` keeps a workflow out of this menu. Default true. */
  slash?: boolean;
  /** A workflow with an error-severity issue is never offered here. */
  runnable: boolean;
}

/** Editor context a workflow run starts from. */
export interface SlashRunContext {
  currentPath?: string;
  selection?: string;
}

export interface SlashWorkflowSource {
  /** Every registered workflow; this module applies the `slash`/runnable rule. */
  list(): readonly SlashWorkflowItem[];
  /** Start the shared run flow (the prompt dialog). */
  run(id: string, ctx: SlashRunContext): void;
  /** Vault-relative path of the note being edited, or null. */
  currentPath(): string | null;
}

let workflowSource: SlashWorkflowSource | null = null;

/**
 * Wire the vault's workflows into the slash menu. Called once when the command
 * service is built, and with `null` on vault teardown.
 */
export function setSlashWorkflowSource(source: SlashWorkflowSource | null): void {
  workflowSource = source;
}

/** The workflows this menu may offer, in the order the service listed them. */
export function slashWorkflows(): SlashWorkflowItem[] {
  return (workflowSource?.list() ?? []).filter((w) => w.runnable && w.slash !== false);
}

/**
 * Remove the `/query` and start the run. The selection is read BEFORE the
 * delete, and a selection that is only the trigger text is no selection at all.
 */
function applyWorkflow(
  item: SlashWorkflowItem,
): (view: EditorView, c: Completion, from: number, to: number) => void {
  return (view, _c, from, to) => {
    if (view.state.readOnly) return;
    const range = view.state.selection.main;
    const selection =
      range.empty || (range.from >= from && range.to <= to)
        ? ""
        : view.state.sliceDoc(range.from, range.to);
    view.dispatch({
      changes: { from, to, insert: "" },
      selection: EditorSelection.cursor(from),
      scrollIntoView: true,
      userEvent: "input.complete",
    });
    const path = workflowSource?.currentPath() ?? null;
    workflowSource?.run(item.id, {
      ...(path ? { currentPath: path } : {}),
      ...(selection ? { selection } : {}),
    });
  };
}

const COMPLETIONS: Completion[] = BLOCKS.map((b) => ({
  label: `/${b.label}`,
  detail: b.detail,
  type: "keyword",
  apply: applyBlock(b.insert, b.caret, b.selTo),
}));

/** Completion source: only fires for a `/…` that begins a line. */
export function slashCompletions(context: CompletionContext): CompletionResult | null {
  if (context.state.readOnly) return null;
  const before = context.matchBefore(/\/\w*/);
  if (!before) return null;
  // The `/` must be the first non-space char on the line (a block trigger),
  // not a slash mid-sentence (dates, paths, "and/or").
  const line = context.state.doc.lineAt(before.from);
  if (before.from !== line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0)) {
    return null;
  }
  if (before.from === before.to && !context.explicit) return null;

  const typed = before.text.slice(1).toLowerCase();
  const options = COMPLETIONS.filter((_, i) => {
    if (!typed) return true;
    const b = BLOCKS[i];
    return (
      b.label.toLowerCase().includes(typed) || b.keywords.includes(typed)
    );
  });

  // Workflows are built per call: the registry re-scans whenever a `.md`
  // changes, so a cached list would offer a command the vault no longer has.
  for (const item of slashWorkflows()) {
    const name = item.name.toLowerCase();
    if (typed && !name.includes(typed) && !item.id.toLowerCase().includes(typed)) continue;
    options.push({
      label: `/${item.name}`,
      detail: item.description ?? "Workflow",
      type: "function",
      apply: applyWorkflow(item),
    });
  }

  return { from: before.from, to: before.to, options, filter: false };
}
