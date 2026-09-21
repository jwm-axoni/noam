// The prompt every workflow run goes through, and the only place a failure is
// ever shown.
//
// Two rules shape this file.
//
// THE CLIPBOARD IS A BUTTON, NOT A READ. A `clipboard` variable renders a
// read-only preview and a "Paste from clipboard" button; nothing calls
// `readClipboardText` until that button is pressed. `{{clipboard}}` is
// therefore always text a person deliberately handed over.
//
// A RUN THAT STARTED CANNOT BE ABANDONED. Once `live.run` is in flight the
// dialog refuses to close — Escape, the backdrop and Cancel all do nothing
// until it settles, and the submit button says "Running…". The engine writes
// notes step by step with no cancellation channel, so a dialog that vanished
// mid-run would leave those writes happening behind a UI that said otherwise.
//
// NOTHING A PERSON TYPED IS DISCARDED. A failure keeps the dialog open with
// the answers still in it, names the step and the field, and — when the engine
// had already rendered content it could not write — shows that content with a
// Copy button and says where it was parked (`Captures/…`). Closing on a
// failure without showing the text would lose a capture.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AsyncButton } from "../AsyncButton";
import { copyText } from "../../lib/clipboard";
import { toast } from "../../lib/toast";
import { useStore } from "../../store";
import type {
  ExecutionFailure,
  PromptValues,
  WorkflowVariable,
} from "../../lib/workflows";
import { readClipboardText } from "./clipboard";
import { getWorkflowService } from "./service";
import { describeEffects, type WorkflowRunRequest } from "./runWorkflow";
import "./workflows.css";

/** Human wording for a failure kind; the raw kind is shown beside it. */
const KIND_TITLES: Readonly<Record<string, string>> = {
  validation: "This workflow needs fixing",
  cancelled: "Cancelled",
  permission: "No access",
  "read-only": "Read-only",
  "stale-target": "The note changed",
  "missing-target": "Note not found",
  "missing-heading": "Heading not found",
  conflict: "Conflict",
  offline: "Offline",
  error: "Something went wrong",
};

function labelFor(variable: WorkflowVariable): string {
  return variable.label ?? variable.name;
}

function isRequired(variable: WorkflowVariable): boolean {
  return variable.required !== false;
}

function initialValues(variables: readonly WorkflowVariable[]): PromptValues {
  const out: PromptValues = {};
  for (const variable of variables) {
    if (variable.default !== undefined) out[variable.name] = variable.default;
    else if (variable.type === "choice") out[variable.name] = variable.choices?.[0] ?? "";
    else out[variable.name] = "";
  }
  return out;
}

/** Field-name → message for every answer that cannot be submitted. */
export function validatePromptValues(
  variables: readonly WorkflowVariable[],
  values: PromptValues,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const variable of variables) {
    const value = values[variable.name] ?? "";
    if (isRequired(variable) && value.trim() === "") {
      errors[variable.name] =
        variable.type === "clipboard"
          ? "Press Paste from clipboard to fill this in."
          : `${labelFor(variable)} is required.`;
      continue;
    }
    if (variable.type === "choice" && value !== "" && !(variable.choices ?? []).includes(value)) {
      errors[variable.name] = `Pick one of: ${(variable.choices ?? []).join(", ")}`;
    }
  }
  return errors;
}

export function PromptDialog({
  request,
  onClose,
}: {
  request: WorkflowRunRequest;
  onClose: () => void;
}) {
  const service = getWorkflowService();
  const entry = service?.get(request.id) ?? null;
  const name = entry?.definition?.name ?? request.id;
  const variables = useMemo(
    () => service?.promptsFor(request.id) ?? [],
    [service, request.id],
  );

  const [values, setValues] = useState<PromptValues>(() => initialValues(variables));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<ExecutionFailure | null>(null);
  const [running, setRunning] = useState(variables.length === 0);
  const [clipboardNote, setClipboardNote] = useState<string | null>(null);

  const fields = useRef(new Map<string, HTMLElement>());
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const startedRef = useRef(false);
  const returnFocus = request.returnFocus;

  const run = useCallback(
    async (submitted: PromptValues) => {
      const live = getWorkflowService();
      if (!live) {
        toast("No vault is open, so no workflow can run.", "error");
        onClose();
        return;
      }
      setRunning(true);
      setFailure(null);
      const result = await live.run(request.id, submitted, request.ctx);
      setRunning(false);
      if (result.ok) {
        toast(`${name} — ${describeEffects(result.effects)}`);
        if (result.warnings.length > 0) {
          toast(
            `${name}: ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"} — ${result.warnings[0].message}`,
            "neutral",
          );
        }
        onClose();
        return;
      }
      setFailure(result);
    },
    [name, onClose, request.ctx, request.id],
  );

  // A workflow with no variables has nothing to ask: run it straight away and
  // stay invisible unless it fails. That is what makes a keyboard shortcut or a
  // slash-menu pick feel like a command rather than a form.
  useEffect(() => {
    if (variables.length > 0 || startedRef.current) return;
    startedRef.current = true;
    void run({});
  }, [run, variables.length]);

  // Focus the first field on open, and the offending one after a failure.
  useEffect(() => {
    if (failure?.field && fields.current.has(failure.field)) {
      fields.current.get(failure.field)?.focus();
      return;
    }
    if (failure) {
      dialogRef.current?.querySelector<HTMLElement>(".workflow-result-actions button")?.focus();
      return;
    }
    const first = variables[0];
    if (first) fields.current.get(first.name)?.focus();
  }, [failure, variables]);

  // Focus goes back where it came from — the editor, the picker's opener, the
  // Workflows view's Run button.
  useEffect(() => () => returnFocus?.focus(), [returnFocus]);

  // Closing is the user's, except while a run is in flight: the steps are
  // already being written and there is nothing to call back to stop them.
  const requestClose = useCallback(() => {
    if (running) return;
    onClose();
  }, [onClose, running]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  if (variables.length === 0 && !failure) return null;

  const setValue = (variable: WorkflowVariable, value: string) => {
    setValues((prev) => ({ ...prev, [variable.name]: value }));
    setErrors((prev) => {
      if (!(variable.name in prev)) return prev;
      const next = { ...prev };
      delete next[variable.name];
      return next;
    });
  };

  const register = (variable: WorkflowVariable) => (node: HTMLElement | null) => {
    if (node) fields.current.set(variable.name, node);
    else fields.current.delete(variable.name);
  };

  const pasteInto = async (variable: WorkflowVariable) => {
    const text = await readClipboardText();
    if (text === null || text === "") {
      setClipboardNote(
        text === "" ? "The clipboard is empty." : "Noam could not read the clipboard.",
      );
      return;
    }
    setClipboardNote(null);
    setValue(variable, text);
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    // A run is already writing notes; a second Enter must not start another.
    if (running) return;
    const found = validatePromptValues(variables, values);
    setErrors(found);
    const firstBad = variables.find((variable) => found[variable.name]);
    if (firstBad) {
      fields.current.get(firstBad.name)?.focus();
      return;
    }
    void run(values);
  };

  const recovery = failure?.recovery;

  return (
    <div className="modal-backdrop" onMouseDown={requestClose}>
      <div
        className="modal workflow-prompt"
        role="dialog"
        aria-modal="true"
        aria-label={`Run ${name}`}
        aria-busy={running || undefined}
        ref={dialogRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <span>{name}</span>
        </div>
        {entry?.definition?.description && (
          <p className="workflow-prompt-description">{entry.definition.description}</p>
        )}

        {variables.length > 0 && (
          <form className="workflow-prompt-form" onSubmit={onSubmit} noValidate>
            {variables.map((variable) => {
              const id = `workflow-field-${variable.name}`;
              const error = errors[variable.name];
              const value = values[variable.name] ?? "";
              const described = error ? `${id}-error` : undefined;
              return (
                <div className="workflow-field" key={variable.name}>
                  <label htmlFor={id}>
                    {labelFor(variable)}
                    {!isRequired(variable) && <span className="workflow-optional"> (optional)</span>}
                  </label>
                  {variable.type === "multiline" ? (
                    <textarea
                      id={id}
                      rows={4}
                      value={value}
                      placeholder={variable.placeholder ?? ""}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={described}
                      ref={register(variable)}
                      onChange={(event) => setValue(variable, event.target.value)}
                    />
                  ) : variable.type === "choice" ? (
                    <select
                      id={id}
                      value={value}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={described}
                      ref={register(variable)}
                      onChange={(event) => setValue(variable, event.target.value)}
                    >
                      {!isRequired(variable) && <option value="">—</option>}
                      {(variable.choices ?? []).map((choice) => (
                        <option key={choice} value={choice}>
                          {choice}
                        </option>
                      ))}
                    </select>
                  ) : variable.type === "clipboard" ? (
                    <div className="workflow-clipboard">
                      <textarea
                        id={id}
                        rows={3}
                        readOnly
                        value={value}
                        placeholder="Nothing pasted yet"
                        aria-invalid={error ? true : undefined}
                        aria-describedby={described}
                        ref={register(variable)}
                      />
                      <AsyncButton
                        type="button"
                        className="ghost-pill"
                        data-clipboard-paste={variable.name}
                        onClick={() => pasteInto(variable)}
                      >
                        Paste from clipboard
                      </AsyncButton>
                    </div>
                  ) : (
                    <input
                      id={id}
                      type={variable.type === "date" ? "date" : "text"}
                      value={value}
                      placeholder={variable.placeholder ?? ""}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={described}
                      ref={register(variable)}
                      onChange={(event) => setValue(variable, event.target.value)}
                    />
                  )}
                  {error && (
                    <p className="workflow-field-error" id={`${id}-error`} role="alert">
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
            {clipboardNote && (
              <p className="workflow-field-error" role="alert">
                {clipboardNote}
              </p>
            )}
            <div className="workflow-prompt-actions">
              <button type="button" className="ghost-pill" onClick={requestClose} disabled={running}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={running}>
                {running ? "Running…" : "Run"}
              </button>
            </div>
          </form>
        )}

        {failure && (
          <div className="workflow-result" role="alert" data-failure-kind={failure.kind}>
            <p className="workflow-result-title">
              {KIND_TITLES[failure.kind] ?? "Failed"}
              <span className="workflow-result-kind">{failure.kind}</span>
            </p>
            <p className="workflow-result-message">{failure.message}</p>
            {(failure.step !== undefined || failure.field) && (
              <p className="workflow-result-where">
                {failure.step !== undefined && <>Step {failure.step + 1}</>}
                {failure.step !== undefined && failure.field ? " · " : null}
                {failure.field && <code>{failure.field}</code>}
              </p>
            )}
            {failure.completed.length > 0 && (
              <p className="workflow-result-where">
                Already done: {describeEffects(failure.completed)}
              </p>
            )}
            {recovery?.pendingContent && (
              <div className="workflow-recovery">
                <p>
                  {recovery.preservedAt
                    ? `Your text was preserved at ${recovery.preservedAt}.`
                    : "Your text was not written anywhere — copy it before you close this."}
                </p>
                <pre className="workflow-pending">{recovery.pendingContent}</pre>
                <div className="workflow-recovery-actions">
                  <AsyncButton
                    type="button"
                    className="ghost-pill"
                    confirm
                    onClick={async () => {
                      const ok = await copyText(recovery.pendingContent ?? "");
                      toast(ok ? "Copied the unsaved text" : "Couldn't copy that", ok ? "success" : "error");
                    }}
                  >
                    Copy
                  </AsyncButton>
                  {recovery.preservedAt && (
                    <button
                      type="button"
                      className="ghost-pill"
                      onClick={() => {
                        const path = recovery.preservedAt;
                        if (path) void useStore.getState().openNoteByPath(path);
                        onClose();
                      }}
                    >
                      Open capture
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="workflow-result-actions">
              {recovery?.retryable && (
                <button
                  type="button"
                  className="primary"
                  disabled={running}
                  onClick={() => void run(values)}
                >
                  Retry
                </button>
              )}
              <button type="button" className="ghost-pill" onClick={requestClose} disabled={running}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
