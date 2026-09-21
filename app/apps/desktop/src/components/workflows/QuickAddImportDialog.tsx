// The QuickAdd report, shown BEFORE anything is written.
//
// This is not QuickAdd compatibility and it never will be: the converter reads
// `data.json` as data and executes nothing. What it cannot express it refuses,
// itemised, with the reason and a bounded excerpt — which is why this dialog
// lists the unsupported rows just as prominently as the converted ones. A
// silent partial import would leave someone believing a macro came across.
//
// Every note is written CREATE-ONLY, so a second run cannot overwrite a
// workflow the user has since edited.

import { useEffect, useState } from "react";
import { AsyncButton } from "../AsyncButton";
import * as ipc from "../../lib/ipc";
import { toast } from "../../lib/toast";
import { useStore } from "../../store";
import { DEFAULT_WORKFLOWS_FOLDER, type QuickAddConversion } from "../../lib/workflows";
import { refreshWorkflows } from "./service";
import "./workflows.css";

const STATUS_LABELS = {
  converted: "Converted",
  skipped: "Skipped",
  unsupported: "Not supported",
} as const;

interface WriteOutcome {
  created: string[];
  existed: string[];
  failed: Array<{ path: string; message: string }>;
}

export function QuickAddImportDialog({
  conversion,
  sourceLabel,
  vault,
  onClose,
}: {
  conversion: QuickAddConversion;
  sourceLabel: string;
  vault: { path: string; epoch: ipc.VaultEpoch };
  onClose: () => void;
}) {
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const counts = {
    converted: conversion.report.filter((row) => row.status === "converted").length,
    skipped: conversion.report.filter((row) => row.status === "skipped").length,
    unsupported: conversion.report.filter((row) => row.status === "unsupported").length,
  };

  const write = async () => {
    const result: WriteOutcome = { created: [], existed: [], failed: [] };
    try {
      await ipc.ensureFolder(DEFAULT_WORKFLOWS_FOLDER, vault.epoch);
    } catch {
      /* the folder may already be there; the writes below report the truth */
    }
    for (const workflow of conversion.workflows) {
      try {
        const created = await ipc.writeNoteIfMissing(workflow.path, workflow.markdown, vault.epoch);
        (created ? result.created : result.existed).push(workflow.path);
      } catch (error) {
        result.failed.push({ path: workflow.path, message: String(error) });
      }
    }
    setOutcome(result);
    await useStore.getState().refreshTree();
    await refreshWorkflows();
    toast(
      result.failed.length > 0
        ? `Imported ${result.created.length} workflow${result.created.length === 1 ? "" : "s"}, ${result.failed.length} failed`
        : `Imported ${result.created.length} workflow${result.created.length === 1 ? "" : "s"} from QuickAdd`,
      result.failed.length > 0 ? "error" : "success",
    );
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal workflow-package-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Import from QuickAdd"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <span>Import from QuickAdd</span>
        </div>
        <p className="workflow-dialog-source">{sourceLabel}</p>
        <p className="workflow-dialog-note">
          {counts.converted} converted · {counts.skipped} skipped · {counts.unsupported} not
          supported. Nothing from the source is executed — user scripts, Obsidian commands and
          Templater are refused by design.
        </p>

        <h3 className="workflow-dialog-subhead">Every item in the file</h3>
        <ul className="workflow-preview-list">
          {conversion.report.map((row, at) => (
            <li key={`${row.sourceName}-${at}`} data-status={row.status}>
              <span className="workflow-preview-path">{row.sourceName}</span>
              <span className="workflow-preview-decision">{STATUS_LABELS[row.status]}</span>
              <span className="workflow-muted">{row.sourceType}</span>
              {row.workflowId && <code>{row.workflowId}</code>}
              {row.reason && <span className="workflow-preview-reason">{row.reason}</span>}
              {row.sourceExcerpt && (
                <pre className="workflow-excerpt">{row.sourceExcerpt}</pre>
              )}
            </li>
          ))}
        </ul>

        {conversion.workflows.length > 0 && !outcome && (
          <>
            <h3 className="workflow-dialog-subhead">Will be written (create-only)</h3>
            <ul className="workflow-issue-list">
              {conversion.workflows.map((workflow) => (
                <li key={workflow.path}>{workflow.path}</li>
              ))}
            </ul>
          </>
        )}

        {outcome && (
          <div className="workflow-result" role="status">
            <p className="workflow-result-title">Done</p>
            <p className="workflow-result-message">
              {outcome.created.length} created, {outcome.existed.length} already there,{" "}
              {outcome.failed.length} failed.
            </p>
            {outcome.existed.length > 0 && (
              <p className="workflow-result-where">
                Existing notes were left untouched: {outcome.existed.join(", ")}
              </p>
            )}
            {outcome.failed.length > 0 && (
              <ul className="workflow-issue-list" role="alert">
                {outcome.failed.map((failure) => (
                  <li key={failure.path}>
                    {failure.path} — {failure.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="workflow-dialog-actions">
          <button type="button" className="ghost-pill" onClick={onClose}>
            {outcome ? "Close" : "Cancel"}
          </button>
          {!outcome && (
            <AsyncButton
              className="primary"
              disabled={conversion.workflows.length === 0}
              onClick={write}
            >
              Import {conversion.workflows.length} workflow
              {conversion.workflows.length === 1 ? "" : "s"}
            </AsyncButton>
          )}
        </div>
      </div>
    </div>
  );
}
