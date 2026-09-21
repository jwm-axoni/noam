// The import review. Nothing is written until this dialog says what will
// happen and the user agrees.
//
// The preview is the whole point: `previewImport` decides `add` / `replace` /
// `duplicate` / `skip` per entry BEFORE a byte moves, and `replace` is the only
// destructive one — it needs this device's ledger to say "I wrote this file,
// from this package" AND the bytes to still be the ones it wrote. This dialog
// renders that decision verbatim rather than summarising it, because "an
// unrelated note is never overwritten" is only believable if you can see which
// file each entry lands on.
//
// Installing the bundled examples comes through here too, with a package built
// in memory instead of read from disk. Same preview, same collisions, same
// ledger.

import { useEffect, useState } from "react";
import { AsyncButton } from "../AsyncButton";
import * as ipc from "../../lib/ipc";
import { toast } from "../../lib/toast";
import { useStore } from "../../store";
import {
  applyImport,
  previewImport,
  type ImportOutcome,
  type ImportPreview,
  type ImportPreviewItem,
  type NoamPackage,
} from "../../lib/workflows";
import { packageContext, refreshWorkflows } from "./service";
import "./workflows.css";

const DECISION_LABELS: Readonly<Record<ImportPreviewItem["decision"], string>> = {
  add: "New file",
  replace: "Replaces this device's earlier copy",
  duplicate: "Kept alongside the existing file",
  skip: "Already identical",
  unsupported: "Refused",
};

export function PackageImportDialog({
  pkg,
  sourceLabel,
  vault,
  onClose,
}: {
  pkg: NoamPackage;
  /** Where these bytes came from, shown so a stray file is obvious. */
  sourceLabel: string;
  vault: { path: string; epoch: ipc.VaultEpoch };
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const context = await packageContext(vault);
        const next = await previewImport(pkg, context.host, {
          ledger: context.ledger,
          existingWorkflowIds: context.existingWorkflowIds,
        });
        if (live) setPreview(next);
      } catch (error) {
        if (live) setLoadError(String(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [pkg, vault]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const manifest = pkg.manifest;
  const blocked =
    preview === null ||
    preview.errors.length > 0 ||
    preview.idempotent ||
    !preview.compatibility.ok;

  const doImport = async () => {
    if (!preview) return;
    const context = await packageContext(vault);
    const result = await applyImport(preview, pkg, context.host, { ledger: context.ledger });
    setOutcome(result);
    if (result.ok) {
      await useStore.getState().refreshTree();
      await refreshWorkflows();
      toast(
        `Imported ${manifest.name} — ${result.written.length} file${result.written.length === 1 ? "" : "s"} written`,
      );
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal workflow-package-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Import ${manifest.name ?? "package"}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <span>
            Import {manifest.name ?? "package"}
            {manifest.version ? ` ${manifest.version}` : ""}
          </span>
        </div>
        <p className="workflow-dialog-source">{sourceLabel}</p>
        {manifest.description && (
          <p className="workflow-prompt-description">{manifest.description}</p>
        )}

        {loadError && (
          <p className="workflow-field-error" role="alert">
            This package could not be read: {loadError}
          </p>
        )}

        {!preview && !loadError && <p className="workflow-dialog-note">Checking this package…</p>}

        {preview && !outcome && (
          <>
            {!preview.compatibility.ok && (
              <p className="workflow-field-error" role="alert">
                {preview.compatibility.message ?? "This package needs a newer version of Noam."}
              </p>
            )}
            {preview.errors.length > 0 && (
              <ul className="workflow-issue-list" role="alert">
                {preview.errors.map((message, at) => (
                  <li key={at}>{message}</li>
                ))}
              </ul>
            )}
            {preview.idempotent && (
              <p className="workflow-dialog-note" data-idempotent="true">
                Already installed — every file in this package is already in the vault, byte for
                byte. There is nothing to do.
              </p>
            )}

            {preview.dependencies.length > 0 && (
              <>
                <h3 className="workflow-dialog-subhead">Needs</h3>
                <ul className="workflow-dependency-list">
                  {preview.dependencies.map((dependency, at) => (
                    <li
                      key={`${dependency.kind}-${dependency.ref}-${at}`}
                      data-satisfied={dependency.satisfied}
                    >
                      <span className="workflow-dependency-state">
                        {dependency.satisfied ? "Satisfied" : "Missing"}
                      </span>
                      <code>{dependency.ref}</code>
                      <span className="workflow-muted">{dependency.kind}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h3 className="workflow-dialog-subhead">
              {preview.items.length} item{preview.items.length === 1 ? "" : "s"}
            </h3>
            <ul className="workflow-preview-list">
              {preview.items.map((item, at) => (
                <li key={`${item.entry?.path ?? at}`} data-decision={item.decision}>
                  <span className="workflow-preview-path">{item.entry?.path ?? "—"}</span>
                  <span className="workflow-preview-decision">
                    {DECISION_LABELS[item.decision]}
                  </span>
                  {item.destination && item.destination !== item.entry?.path && (
                    <span className="workflow-preview-destination">→ {item.destination}</span>
                  )}
                  {item.reason && <span className="workflow-muted">{item.reason}</span>}
                  {item.existingSha256 && (
                    <span className="workflow-muted">
                      existing {item.existingSha256.slice(0, 8)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {outcome && (
          <div className="workflow-result" role="status">
            {outcome.ok ? (
              <>
                <p className="workflow-result-title">Imported</p>
                <p className="workflow-result-message">
                  {outcome.written.length} written, {outcome.skipped.length} skipped.
                </p>
                {outcome.written.length > 0 && (
                  <ul className="workflow-issue-list">
                    {outcome.written.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <>
                <p className="workflow-result-title">Import failed</p>
                <p className="workflow-result-message">{outcome.message}</p>
                <p className="workflow-result-where">
                  {outcome.rolledBack
                    ? "Everything it had written was put back; the vault is unchanged."
                    : "The rollback did NOT complete — the vault may be part-written."}
                  {outcome.failedAt ? ` Failed at ${outcome.failedAt}.` : ""}
                </p>
                {outcome.recoveryRecord && (
                  <p className="workflow-result-where">
                    A recovery record was kept at <code>{outcome.recoveryRecord}</code>.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        <div className="workflow-dialog-actions">
          <button type="button" className="ghost-pill" onClick={onClose}>
            {outcome ? "Close" : "Cancel"}
          </button>
          {!outcome && (
            <AsyncButton className="primary" disabled={blocked} onClick={doImport}>
              Import
            </AsyncButton>
          )}
        </div>
      </div>
    </div>
  );
}
