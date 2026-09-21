// Build a package file out of workflows and templates already in this vault.
//
// The package is built here, shown, then saved through the native save
// dialog (`ipc.saveFile` + `ipc.writeExternalFile`, which writes to the
// absolute path the user chose and nothing inside the vault). Copying the
// JSON to the clipboard stays as a fallback.

import { useEffect, useMemo, useState } from "react";
import { AsyncButton } from "../AsyncButton";
import * as ipc from "../../lib/ipc";
import { copyText } from "../../lib/clipboard";
import { toast } from "../../lib/toast";
import {
  DEFAULT_TEMPLATES_FOLDER,
  PACKAGE_FILE_SUFFIX,
  WORKFLOW_ID_PATTERN,
  exportPackage,
  serializePackage,
  type PackageSelectionEntry,
  type RegisteredWorkflow,
} from "../../lib/workflows";
import { packageContext, useWorkflows } from "./service";
import "./workflows.css";

const VERSION_PATTERN = /^\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$/;

/** Every `.md` under `Templates/`, from the tree Rust already walks. */
async function listTemplates(epoch: ipc.VaultEpoch): Promise<string[]> {
  const root = await ipc.listTree(epoch);
  const out: string[] = [];
  const prefix = `${DEFAULT_TEMPLATES_FOLDER.toLowerCase()}/`;
  const walk = (node: ipc.TreeNode) => {
    if (node.isDir) {
      node.children?.forEach(walk);
      return;
    }
    const lower = node.path.toLowerCase();
    if (lower.startsWith(prefix) && lower.endsWith(".md")) out.push(node.path);
  };
  root.children?.forEach(walk);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Why this workflow cannot go into a package, or null when it can.
 *
 * The registry deliberately KEEPS broken workflow notes — a file with a typo is
 * something the user has to be able to find — but a package built out of one is
 * an artifact that cannot be imported: an unreadable definition has no id, and
 * `validatePackage` refuses a workflow entry without one. So they are listed,
 * disabled, with the reason.
 */
export function exportBlockReason(workflow: RegisteredWorkflow): string | null {
  if (workflow.runnable && workflow.id !== "") return null;
  if (!workflow.definition) return "not a readable workflow note";
  if (workflow.id === "") return "this workflow has no id";
  const first = workflow.issues.find((issue) => issue.severity === "error");
  return first ? first.message : "this workflow has errors to fix first";
}

/** What the selection exports. A blocked workflow is never one of them. */
export function selectedEntries(
  workflows: readonly RegisteredWorkflow[],
  templates: readonly string[],
  chosen: ReadonlySet<string>,
): PackageSelectionEntry[] {
  const out: PackageSelectionEntry[] = [];
  // Templates first so a workflow's `requires` meets its template on import.
  for (const path of templates) {
    if (chosen.has(path)) out.push({ path, kind: "template" });
  }
  for (const workflow of workflows) {
    if (!chosen.has(workflow.path) || exportBlockReason(workflow) !== null) continue;
    out.push({ path: workflow.path, kind: "workflow", id: workflow.id });
  }
  return out;
}

export function PackageExportDialog({
  vault,
  onClose,
}: {
  vault: { path: string; epoch: ipc.VaultEpoch };
  onClose: () => void;
}) {
  const workflows = useWorkflows();
  const [templates, setTemplates] = useState<string[]>([]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [name, setName] = useState("My workflows");
  const [id, setId] = useState("my-workflows");
  const [version, setVersion] = useState("1.0.0");
  const [description, setDescription] = useState("");
  const [built, setBuilt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listTemplates(vault.epoch)
      .then((found) => {
        if (live) setTemplates(found);
      })
      .catch(() => {
        if (live) setTemplates([]);
      });
    return () => {
      live = false;
    };
  }, [vault.epoch]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const entries = useMemo<PackageSelectionEntry[]>(
    () => selectedEntries(workflows, templates, chosen),
    [chosen, templates, workflows],
  );

  const toggle = (path: string) => {
    setBuilt(null);
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const idBad = !WORKFLOW_ID_PATTERN.test(id);
  const versionBad = !VERSION_PATTERN.test(version);
  const fileName = `${name.trim() || id}${PACKAGE_FILE_SUFFIX}`;

  const build = async () => {
    setError(null);
    setBuilt(null);
    try {
      const context = await packageContext(vault);
      const pkg = await exportPackage(
        {
          id,
          name: name.trim() || id,
          version,
          entries,
          ...(description.trim() ? { description: description.trim() } : {}),
        },
        context.host,
      );
      setBuilt(serializePackage(pkg));
    } catch (thrown) {
      setError(String(thrown));
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal workflow-package-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Export a workflow package"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <span>Export a package</span>
        </div>

        <div className="workflow-field">
          <label htmlFor="pkg-name">Name</label>
          <input
            id="pkg-name"
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setBuilt(null);
            }}
          />
        </div>
        <div className="workflow-field">
          <label htmlFor="pkg-id">Package id</label>
          <input
            id="pkg-id"
            type="text"
            value={id}
            aria-invalid={idBad || undefined}
            onChange={(event) => {
              setId(event.target.value);
              setBuilt(null);
            }}
          />
          {idBad && (
            <p className="workflow-field-error" role="alert">
              Lowercase letters, digits and hyphens only.
            </p>
          )}
        </div>
        <div className="workflow-field">
          <label htmlFor="pkg-version">Version</label>
          <input
            id="pkg-version"
            type="text"
            value={version}
            aria-invalid={versionBad || undefined}
            onChange={(event) => {
              setVersion(event.target.value);
              setBuilt(null);
            }}
          />
          {versionBad && (
            <p className="workflow-field-error" role="alert">
              Use a version like 1, 1.2 or 1.2.3.
            </p>
          )}
        </div>
        <div className="workflow-field">
          <label htmlFor="pkg-description">Description</label>
          <input
            id="pkg-description"
            type="text"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              setBuilt(null);
            }}
          />
        </div>

        <h3 className="workflow-dialog-subhead">Workflows</h3>
        {workflows.length === 0 ? (
          <p className="workflow-dialog-note">This vault has no workflow notes yet.</p>
        ) : (
          <ul className="workflow-pick-list">
            {workflows.map((workflow) => {
              const blocked = exportBlockReason(workflow);
              return (
                <li key={workflow.path}>
                  <label title={blocked ?? undefined}>
                    <input
                      type="checkbox"
                      checked={blocked === null && chosen.has(workflow.path)}
                      disabled={blocked !== null}
                      onChange={() => toggle(workflow.path)}
                    />
                    <span>{workflow.definition?.name ?? workflow.path}</span>
                    <span className="workflow-muted">
                      {blocked === null ? workflow.path : `${workflow.path} — can't export: ${blocked}`}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <h3 className="workflow-dialog-subhead">Templates</h3>
        {templates.length === 0 ? (
          <p className="workflow-dialog-note">No notes under {DEFAULT_TEMPLATES_FOLDER}/.</p>
        ) : (
          <ul className="workflow-pick-list">
            {templates.map((path) => (
              <li key={path}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(path)}
                    onChange={() => toggle(path)}
                  />
                  <span>{path}</span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {error && (
          <p className="workflow-field-error" role="alert">
            {error}
          </p>
        )}

        {built && (
          <div className="workflow-result" role="status">
            <p className="workflow-result-title">Package ready — {fileName}</p>
            <p className="workflow-result-message">
              Noam cannot yet write a file outside the vault, so copy this and save it as{" "}
              <code>{fileName}</code>.
            </p>
            <textarea className="workflow-package-json" readOnly rows={8} value={built} />
          </div>
        )}

        <div className="workflow-dialog-actions">
          <button type="button" className="ghost-pill" onClick={onClose}>
            Close
          </button>
          {built ? (
            <>
              <AsyncButton
                className="ghost-pill"
                onClick={async () => {
                  const ok = await copyText(built);
                  toast(ok ? `Copied ${fileName}` : "Couldn't copy the package", ok ? "success" : "error");
                }}
              >
                Copy JSON
              </AsyncButton>
              <AsyncButton
                className="primary"
                onClick={async () => {
                  const dest = await ipc.saveFile(fileName);
                  if (!dest) return;
                  try {
                    await ipc.writeExternalFile(dest, built);
                    toast(`Saved ${fileName}`);
                    onClose();
                  } catch (err) {
                    toast(`Couldn't save the package: ${String(err)}`, "error");
                  }
                }}
              >
                Save package…
              </AsyncButton>
            </>
          ) : (
            <AsyncButton
              className="primary"
              disabled={entries.length === 0 || idBad || versionBad}
              onClick={build}
            >
              Build package
            </AsyncButton>
          )}
        </div>
      </div>
    </div>
  );
}
