/**
 * The command service: one registry of workflows, and the single `run` every UI
 * entry point calls.
 *
 * The slash menu, the action picker, a keyboard shortcut and the Workflows view
 * all go through this object, so a workflow cannot behave differently depending
 * on where it was started from. It is deliberately a plain factory over injected
 * I/O — `listNotes` and `readNote` — so the whole thing tests without Tauri;
 * `adapter.ts` supplies the production pair.
 *
 * Broken files stay in the list. A workflow note with a typo is something the
 * user has to be able to FIND, and a registry that silently drops it leaves
 * them looking for a command that vanished.
 */

import {
  type CommandService,
  type EditorContext,
  type ExecutionResult,
  type ParsedWorkflowFile,
  type PromptValues,
  type RegisteredWorkflow,
  type WorkflowDefinition,
  type WorkflowHost,
  type WorkflowId,
  type WorkflowIssue,
  type WorkflowVariable,
} from "../contracts";
import { runWorkflow } from "./executor";
import { hasWorkflowMarker, parseWorkflowNote } from "./parse";
import { validateDefinition } from "./validate";

export interface CommandServiceDeps {
  /** Every note path in the vault. Only `.md` files are considered. */
  listNotes(): Promise<string[]>;
  /** Note text, or null when it could not be read. */
  readNote(path: string): Promise<string | null>;
  /** Where runs write. */
  host: WorkflowHost;
  /** Shortcuts the app already owns; a workflow claiming one gets a warning. */
  reservedShortcuts?: ReadonlySet<string>;
}

function hasErrors(issues: readonly WorkflowIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

/** Name first, path as the tiebreak — and for files with no readable name. */
function compare(a: RegisteredWorkflow, b: RegisteredWorkflow): number {
  const an = a.definition?.name ?? a.path;
  const bn = b.definition?.name ?? b.path;
  return an.localeCompare(bn) || a.path.localeCompare(b.path);
}

/** Vault-relative template paths a definition's steps render. */
function templatePathsOf(def: WorkflowDefinition): string[] {
  const out: string[] = [];
  for (const step of def.steps ?? []) {
    const candidate = step as { template?: unknown; createIfMissing?: { template?: unknown } };
    if (typeof candidate?.template === "string") out.push(candidate.template);
    const seed = candidate?.createIfMissing?.template;
    if (typeof seed === "string") out.push(seed);
  }
  return out;
}

/** Ids claimed by more than one file. */
function duplicateIdsIn(files: readonly ParsedWorkflowFile[]): Set<WorkflowId> {
  const seen = new Set<WorkflowId>();
  const duplicates = new Set<WorkflowId>();
  for (const file of files) {
    const id = file.definition?.id;
    if (typeof id !== "string" || id === "") continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return duplicates;
}

export function createCommandService(deps: CommandServiceDeps): CommandService {
  let workflows: RegisteredWorkflow[] = [];
  let byId = new Map<WorkflowId, RegisteredWorkflow>();
  const listeners = new Set<() => void>();
  let inFlight: Promise<void> | null = null;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const scan = async (): Promise<void> => {
    const paths = (await deps.listNotes()).filter((p) => p.toLowerCase().endsWith(".md"));
    const files: ParsedWorkflowFile[] = [];
    for (const path of paths) {
      const text = await deps.readNote(path);
      // The marker is the cheap question; everything else costs a parse.
      if (text === null || !hasWorkflowMarker(text)) continue;
      files.push(parseWorkflowNote(path, text, { validate: false }));
    }

    const duplicateIds = duplicateIdsIn(files);
    // First file wins the id slot, so the cycle walk has one definition per id
    // even while two files are fighting over it (both are non-runnable anyway).
    const definitions = new Map<WorkflowId, WorkflowDefinition>();
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const id = file.definition?.id;
      if (typeof id === "string" && id !== "" && !definitions.has(id)) {
        definitions.set(id, file.definition!);
      }
    }

    // The templates the steps render, read here because this is already the
    // layer that reads notes. Validation uses them to tell a variable only a
    // template uses from one nothing uses at all. A path with `{{…}}` in it is
    // only known at run time, so it stays unread — and unread means "do not
    // warn", not "warn".
    const templateSources = new Map<string, string>();
    const wanted = new Set<string>();
    for (const file of files) {
      if (file.definition) for (const path of templatePathsOf(file.definition)) wanted.add(path);
    }
    for (const path of wanted) {
      if (path.includes("{{")) continue;
      const text = await deps.readNote(path).catch(() => null);
      if (text !== null) templateSources.set(path, text);
    }

    const registered = files.map((file): RegisteredWorkflow => {
      const issues = file.definition
        ? [
            ...file.issues,
            ...validateDefinition(file.definition, {
              byId: definitions,
              duplicateIds,
              templateSources,
              ...(deps.reservedShortcuts ? { reservedShortcuts: deps.reservedShortcuts } : {}),
            }),
          ]
        : file.issues;
      return {
        id: typeof file.definition?.id === "string" ? file.definition.id : "",
        path: file.path,
        definition: file.definition,
        issues,
        runnable: file.definition !== null && !hasErrors(issues),
      };
    });

    registered.sort(compare);
    workflows = registered;
    byId = new Map();
    for (const entry of registered) {
      if (entry.id !== "" && !byId.has(entry.id)) byId.set(entry.id, entry);
    }
    notify();
  };

  const runnableDefinitions = (): Map<WorkflowId, WorkflowDefinition> => {
    const map = new Map<WorkflowId, WorkflowDefinition>();
    for (const entry of workflows) {
      if (entry.runnable && entry.definition) map.set(entry.id, entry.definition);
    }
    return map;
  };

  return {
    list: () => workflows,
    get: (id) => byId.get(id) ?? null,
    promptsFor(id): WorkflowVariable[] {
      return byId.get(id)?.definition?.variables ?? [];
    },
    async run(id: WorkflowId, values: PromptValues, ctx: EditorContext): Promise<ExecutionResult> {
      const entry = byId.get(id);
      const refuse = (message: string, field?: string): ExecutionResult => ({
        ok: false,
        workflowId: id,
        kind: "validation",
        message,
        completed: [],
        recovery: { retryable: false },
        ...(field === undefined ? {} : { field }),
      });
      if (!entry) return refuse(`No workflow in this vault has the id "${id}".`);
      if (!entry.definition) return refuse(`"${entry.path}" is not a readable workflow.`);
      if (!entry.runnable) {
        const first = entry.issues.find((i) => i.severity === "error");
        return refuse(
          `"${entry.definition.name}" has a problem that must be fixed first: ${first?.message ?? "unknown"}`,
          first?.field,
        );
      }
      return runWorkflow(entry.definition, values, ctx, deps.host, runnableDefinitions());
    },
    refresh(): Promise<void> {
      // Serialized: two overlapping scans would publish in whichever order they
      // happened to finish, and the older one could win.
      inFlight = (inFlight ?? Promise.resolve()).then(scan, scan);
      return inFlight;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
