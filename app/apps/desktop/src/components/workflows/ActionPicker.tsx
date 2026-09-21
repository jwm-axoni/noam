// The action picker: ⌘⇧P, type a few letters, Enter.
//
// It lists BROKEN workflows too. A workflow note with a typo is a command the
// user believes exists, and a palette that silently omitted it would leave
// them hunting for something that vanished — so it shows with a warning glyph,
// and Enter on it explains the problem instead of pretending to run.
//
// Focus goes back where it came from on close, including when the pick starts
// a run: the picker hands its OWN opener to the run request, because its input
// has left the document by the time the prompt dialog closes.

import { useEffect, useMemo, useRef, useState } from "react";
import type { RegisteredWorkflow } from "../../lib/workflows";
import { platformClass } from "../../lib/platform";
import { PresentationIcon } from "../PresentationIcon";
import { parsePresentationIcon } from "../../lib/presentation/types";
import { currentEditorContext } from "./editorContext";
import { requestWorkflowRun } from "./runWorkflow";
import { useWorkflows } from "./service";
import { shortcutLabel } from "./shortcuts";
import "./workflows.css";

/** Every character of `needle`, in order, somewhere in `haystack`. */
function subsequence(haystack: string, needle: string): boolean {
  let at = 0;
  for (const char of needle) {
    at = haystack.indexOf(char, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}

/**
 * Lower is better; null means no match. Exact-prefix beats substring beats a
 * scattered subsequence, so typing "mee" puts "Meeting note" above "Weekly
 * team meeting" above "Move entry".
 */
export function matchScore(workflow: RegisteredWorkflow, query: string): number | null {
  if (query === "") return 0;
  const name = (workflow.definition?.name ?? workflow.path).toLowerCase();
  const description = (workflow.definition?.description ?? "").toLowerCase();
  const id = workflow.id.toLowerCase();
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (id.includes(query)) return 2;
  if (description.includes(query)) return 3;
  if (subsequence(name, query)) return 4;
  return null;
}

/** The picker's result list: matches, best first, ties keeping name order. */
export function filterWorkflows(
  workflows: readonly RegisteredWorkflow[],
  rawQuery: string,
): RegisteredWorkflow[] {
  const query = rawQuery.trim().toLowerCase();
  return workflows
    .map((workflow, index) => ({ workflow, index, score: matchScore(workflow, query) }))
    .filter((row): row is { workflow: RegisteredWorkflow; index: number; score: number } =>
      row.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((row) => row.workflow);
}

function WarningGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

export function ActionPicker({ onClose }: { onClose: () => void }) {
  const workflows = useWorkflows();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [issuesFor, setIssuesFor] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const isMac = platformClass() === "macos";

  const results = useMemo(() => filterWorkflows(workflows, query), [workflows, query]);

  // Remember the opener before the input takes focus, and give it back on close.
  useEffect(() => {
    const opener = document.activeElement;
    openerRef.current = opener instanceof HTMLElement ? opener : null;
    inputRef.current?.focus();
    return () => openerRef.current?.focus();
  }, []);

  useEffect(() => {
    setActive(0);
    setIssuesFor(null);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, results.length]);

  const choose = (workflow: RegisteredWorkflow | undefined) => {
    if (!workflow) return;
    if (!workflow.runnable) {
      setIssuesFor(workflow.path);
      return;
    }
    requestWorkflowRun(workflow.id, currentEditorContext(), openerRef.current);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" && results.length > 0) {
      setActive((index) => (index + 1) % results.length);
    } else if (event.key === "ArrowUp" && results.length > 0) {
      setActive((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      choose(results[active]);
    } else {
      return;
    }
    event.preventDefault();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal action-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Run a workflow"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="action-picker-input"
          type="text"
          role="combobox"
          aria-expanded
          aria-controls="action-picker-list"
          aria-activedescendant={results[active] ? `action-picker-${active}` : undefined}
          placeholder="Run a workflow…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {results.length === 0 ? (
          <p className="action-picker-empty">
            {workflows.length === 0
              ? "This vault has no workflows yet. Open the Workflows view to install the examples."
              : "No workflow matches that."}
          </p>
        ) : (
          <ul className="action-picker-list" id="action-picker-list" role="listbox" ref={listRef}>
            {results.map((workflow, index) => {
              const definition = workflow.definition;
              const icon = parsePresentationIcon(definition?.icon);
              const errors = workflow.issues.filter((issue) => issue.severity === "error");
              const showIssues = issuesFor === workflow.path;
              return (
                <li
                  key={workflow.path}
                  id={`action-picker-${index}`}
                  data-idx={index}
                  role="option"
                  aria-selected={index === active}
                  aria-disabled={!workflow.runnable || undefined}
                  className={`action-picker-row${index === active ? " active" : ""}${
                    workflow.runnable ? "" : " broken"
                  }`}
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(workflow)}
                >
                  <span className="action-picker-icon" aria-hidden="true">
                    {workflow.runnable ? (
                      icon ? <PresentationIcon icon={icon} /> : null
                    ) : (
                      <WarningGlyph />
                    )}
                  </span>
                  <span className="action-picker-text">
                    <span className="action-picker-name">
                      {definition?.name ?? workflow.path}
                    </span>
                    {definition?.description && (
                      <span className="action-picker-description">{definition.description}</span>
                    )}
                    {showIssues && (
                      <ul className="action-picker-issues" role="alert">
                        {(errors.length > 0 ? errors : workflow.issues).map((issue, at) => (
                          <li key={`${issue.code}-${at}`}>
                            {issue.step !== undefined && <>Step {issue.step + 1}: </>}
                            {issue.field && <code>{issue.field}</code>}
                            {issue.field ? " — " : ""}
                            {issue.message}
                          </li>
                        ))}
                        <li className="action-picker-issue-path">{workflow.path}</li>
                      </ul>
                    )}
                  </span>
                  {definition?.shortcut && (
                    <kbd className="action-picker-shortcut">
                      {shortcutLabel(definition.shortcut, isMac)}
                    </kbd>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
