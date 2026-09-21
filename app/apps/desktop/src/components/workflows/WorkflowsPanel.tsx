// The Workflows view: every command this vault has, why a broken one is
// broken, and the four ways workflows get into a vault (write one, install the
// examples, import a package, import from QuickAdd).
//
// Broken workflows are listed, with their exact step and field. A view that
// hid them would leave someone hunting for a command that vanished — and the
// whole reason definitions live in ordinary notes is that "Open source" can
// take you straight to the text you have to fix.
//
// Installing the examples is NOT a shortcut past the package machinery: it
// builds the same kind of package file and runs it through the same preview,
// so a vault that already has `Workflows/Meeting note (example).md` gets the
// same collision handling a downloaded package would get.

import { lazy, Suspense, useEffect, useState } from "react";
import type { PanelBodyProps } from "../../layout/panelRegistry";
import * as ipc from "../../lib/ipc";
import { platformClass } from "../../lib/platform";
import { toast } from "../../lib/toast";
import { useStore } from "../../store";
import { parsePresentationIcon } from "../../lib/presentation/types";
import { PresentationIcon } from "../PresentationIcon";
import {
  DEFAULT_WORKFLOWS_FOLDER,
  buildExamplesPackage,
  convertQuickAdd,
  listRecoveryRecords,
  parsePackage,
  serializeWorkflowNote,
  type ImportRecoveryRecord,
  type NoamPackage,
  type QuickAddConversion,
  type WorkflowDefinition,
} from "../../lib/workflows";
import { currentEditorContext } from "./editorContext";
import { requestWorkflowRun } from "./runWorkflow";
import { appVersion, refreshWorkflows, useWorkflows } from "./service";
import { shortcutLabel } from "./shortcuts";
import "./workflows.css";

const PackageImportDialog = lazy(() =>
  import("./PackageImportDialog").then((m) => ({ default: m.PackageImportDialog })),
);
const PackageExportDialog = lazy(() =>
  import("./PackageExportDialog").then((m) => ({ default: m.PackageExportDialog })),
);
const QuickAddImportDialog = lazy(() =>
  import("./QuickAddImportDialog").then((m) => ({ default: m.QuickAddImportDialog })),
);

type Dialog =
  | { kind: "import"; pkg: NoamPackage; label: string }
  | { kind: "export" }
  | { kind: "quickadd"; conversion: QuickAddConversion; label: string }
  | null;

/** A starter definition that validates clean and does something on day one. */
function starterDefinition(id: string, name: string): WorkflowDefinition {
  return {
    version: 1,
    id,
    name,
    description: "Describe what this does, then edit the JSON below.",
    variables: [{ name: "entry", label: "What happened?", type: "multiline", required: true }],
    steps: [
      { type: "append", target: "current", content: "- {{date}} {{time}} — {{entry}}" },
    ],
  } as WorkflowDefinition;
}

const fileBase = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

export function WorkflowsPanel({ vaultKey, vaultEpoch }: PanelBodyProps) {
  const workflows = useWorkflows();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [records, setRecords] = useState<Array<{ path: string; record: ImportRecoveryRecord }>>([]);
  const isMac = platformClass() === "macos";
  const vault = { path: vaultKey, epoch: vaultEpoch };

  // Re-read after every dialog close: an import that half-finished leaves one.
  useEffect(() => {
    try {
      setRecords(listRecoveryRecords());
    } catch {
      setRecords([]);
    }
  }, [vaultKey, dialog]);

  const newWorkflow = async () => {
    const taken = new Set(workflows.map((w) => w.id).filter(Boolean));
    let name = "New workflow";
    let id = "new-workflow";
    for (let n = 2; taken.has(id) || (await ipc.noteExists(`${DEFAULT_WORKFLOWS_FOLDER}/${name}.md`, vaultEpoch)); n += 1) {
      name = `New workflow ${n}`;
      id = `new-workflow-${n}`;
      if (n > 50) break;
    }
    const path = `${DEFAULT_WORKFLOWS_FOLDER}/${name}.md`;
    try {
      await ipc.ensureFolder(DEFAULT_WORKFLOWS_FOLDER, vaultEpoch);
      const created = await ipc.writeNoteIfMissing(
        path,
        serializeWorkflowNote(starterDefinition(id, name)),
        vaultEpoch,
      );
      if (!created) {
        toast(`${path} already exists`, "error");
        return;
      }
      await useStore.getState().refreshTree();
      await refreshWorkflows();
      await useStore.getState().openNoteByPath(path);
    } catch (error) {
      toast(`Couldn't create that workflow: ${String(error)}`, "error");
    }
  };

  const installExamples = async () => {
    try {
      const pkg = await buildExamplesPackage(await appVersion());
      setDialog({ kind: "import", pkg, label: "Bundled examples" });
    } catch (error) {
      toast(`Couldn't build the examples package: ${String(error)}`, "error");
    }
  };

  const importPackage = async () => {
    const picked = await ipc.pickFiles().catch(() => null);
    const path = picked?.[0];
    if (!path) return;
    try {
      const bytes = await ipc.readExternalFile(path);
      const parsed = parsePackage(new TextDecoder().decode(bytes));
      if ("error" in parsed) {
        toast(`That is not a Noam package: ${parsed.error}`, "error");
        return;
      }
      setDialog({ kind: "import", pkg: parsed.pkg, label: path });
    } catch (error) {
      toast(`Couldn't read that file: ${String(error)}`, "error");
    }
  };

  const importQuickAdd = async () => {
    const picked = await ipc.pickFiles().catch(() => null);
    const path = picked?.[0];
    if (!path) return;
    try {
      const bytes = await ipc.readExternalFile(path);
      const conversion = convertQuickAdd(JSON.parse(new TextDecoder().decode(bytes)), {
        folder: DEFAULT_WORKFLOWS_FOLDER,
      });
      setDialog({ kind: "quickadd", conversion, label: path });
    } catch (error) {
      toast(`Couldn't read that QuickAdd file: ${String(error)}`, "error");
    }
  };

  return (
    <div className="workflows-panel" aria-label="Workflows">
      <div className="workflows-toolbar" role="group" aria-label="Workflow actions">
        <button type="button" className="ghost-pill" onClick={() => void newWorkflow()}>
          New workflow
        </button>
        <button type="button" className="ghost-pill" onClick={() => void installExamples()}>
          Install examples
        </button>
        <button type="button" className="ghost-pill" onClick={() => void importPackage()}>
          Import package…
        </button>
        <button type="button" className="ghost-pill" onClick={() => setDialog({ kind: "export" })}>
          Export package…
        </button>
        <button type="button" className="ghost-pill" onClick={() => void importQuickAdd()}>
          Import from QuickAdd…
        </button>
      </div>

      {records.length > 0 && (
        <div className="workflows-recovery-notice" role="alert">
          <strong>An import did not finish.</strong>
          <ul>
            {records.map((entry) => (
              <li key={entry.path}>
                {entry.record.packageId} started {entry.record.startedAt} —{" "}
                {entry.record.written.length} file
                {entry.record.written.length === 1 ? "" : "s"} written. The original contents are
                kept at <code>{entry.path}</code>.
              </li>
            ))}
          </ul>
        </div>
      )}

      {workflows.length === 0 ? (
        <p className="workspace-panel-empty">
          No workflows yet. Install the examples, or write one — a workflow is an ordinary note
          under {DEFAULT_WORKFLOWS_FOLDER}/.
        </p>
      ) : (
        <ul className="workflows-list">
          {workflows.map((workflow) => {
            const definition = workflow.definition;
            const errors = workflow.issues.filter((issue) => issue.severity === "error");
            const icon = parsePresentationIcon(definition?.icon);
            const open = expanded === workflow.path;
            return (
              <li
                key={workflow.path}
                className={`workflows-row${workflow.runnable ? "" : " broken"}`}
                data-runnable={workflow.runnable}
              >
                <div className="workflows-row-head">
                  <span className="workflows-row-icon" aria-hidden="true">
                    {icon ? <PresentationIcon icon={icon} /> : null}
                  </span>
                  <span className="workflows-row-text">
                    <span className="workflows-row-name">
                      {definition?.name ?? fileBase(workflow.path)}
                    </span>
                    {definition?.description && (
                      <span className="workflows-row-description">{definition.description}</span>
                    )}
                    <span className="workflows-row-path">{workflow.path}</span>
                  </span>
                  {definition?.shortcut && (
                    <kbd className="workflows-row-shortcut">
                      {shortcutLabel(definition.shortcut, isMac)}
                    </kbd>
                  )}
                </div>
                <div className="workflows-row-actions">
                  <button
                    type="button"
                    className="ghost-pill"
                    disabled={!workflow.runnable}
                    title={workflow.runnable ? undefined : "Fix the problems below first"}
                    onClick={(event) =>
                      requestWorkflowRun(workflow.id, currentEditorContext(), event.currentTarget)
                    }
                  >
                    Run
                  </button>
                  <button
                    type="button"
                    className="ghost-pill"
                    onClick={() => void useStore.getState().openNoteByPath(workflow.path)}
                  >
                    Open source
                  </button>
                  {workflow.issues.length > 0 && (
                    <button
                      type="button"
                      className="ghost-pill"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : workflow.path)}
                    >
                      {errors.length > 0
                        ? `${errors.length} problem${errors.length === 1 ? "" : "s"}`
                        : `${workflow.issues.length} warning${workflow.issues.length === 1 ? "" : "s"}`}
                    </button>
                  )}
                </div>
                {open && workflow.issues.length > 0 && (
                  <ul className="workflow-issue-list">
                    {workflow.issues.map((issue, at) => (
                      <li key={`${issue.code}-${at}`} data-severity={issue.severity}>
                        <span className="workflow-issue-severity">{issue.severity}</span>
                        {issue.step !== undefined && <span>Step {issue.step + 1}</span>}
                        {issue.field && <code>{issue.field}</code>}
                        <span>{issue.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {dialog && (
        <Suspense fallback={null}>
          {dialog.kind === "import" && (
            <PackageImportDialog
              pkg={dialog.pkg}
              sourceLabel={dialog.label}
              vault={vault}
              onClose={() => setDialog(null)}
            />
          )}
          {dialog.kind === "export" && (
            <PackageExportDialog vault={vault} onClose={() => setDialog(null)} />
          )}
          {dialog.kind === "quickadd" && (
            <QuickAddImportDialog
              conversion={dialog.conversion}
              sourceLabel={dialog.label}
              vault={vault}
              onClose={() => setDialog(null)}
            />
          )}
        </Suspense>
      )}
    </div>
  );
}
