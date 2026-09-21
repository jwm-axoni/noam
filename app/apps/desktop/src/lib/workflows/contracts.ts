// Frozen shared contracts for the Noam workflow system: templates, quick
// capture, workflow definitions, the command service, and portable packages.
//
// This file is the boundary between three owners:
//   - the command engine (`src/lib/workflows/engine/*`)
//   - the package service (`src/lib/workflows/packages/*`, `quickadd/*`)
//   - the UI entry points (slash menu, action picker, prompts, Workflows view)
//
// Rules that every owner relies on:
//   - Nothing here evaluates JavaScript, shell, Templater code or expressions.
//   - Workflow definitions and templates are ORDINARY vault files. They are
//     never stored only under `.context/`. Recovery records may live there.
//   - The engine re-resolves its target immediately before writing. A stale or
//     ambiguous target fails with a structured result, never a silent write.
//   - One engine powers every UI entry point.

// ---------------------------------------------------------------------------
// File recognition
// ---------------------------------------------------------------------------

/** Frontmatter key/value that marks a Markdown note as a workflow definition. */
export const WORKFLOW_KIND_KEY = "noam_kind";
export const WORKFLOW_KIND_VALUE = "workflow";

/**
 * A workflow note is a Markdown file whose frontmatter has
 * `noam_kind: workflow` AND whose body contains exactly one fenced code block
 * whose info string starts with `json noam-workflow`. The fence body is the
 * JSON definition below. Prose outside the fence is free-form documentation.
 * Extra fences with other info strings are ignored.
 */
export const WORKFLOW_FENCE_INFO = "json noam-workflow";

/** Default folders. Users may keep definitions anywhere; these are defaults. */
export const DEFAULT_WORKFLOWS_FOLDER = "Workflows";
export const DEFAULT_TEMPLATES_FOLDER = "Templates";

/** Templates are ordinary Markdown files. No marker is required. */

// ---------------------------------------------------------------------------
// Workflow definition schema (version 1)
// ---------------------------------------------------------------------------

export const WORKFLOW_SCHEMA_VERSION = 1 as const;

/** Stable command id: lowercase, `[a-z0-9][a-z0-9-]{0,63}`. Unique per vault. */
export type WorkflowId = string;
export const WORKFLOW_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Variable names: `[a-z][a-z0-9_]{0,31}`; must not shadow a built-in. */
export const VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Built-in expansion names. `{{date}}`/`{{time}}` accept a bounded format
 * (`{{date:YYYY-MM-DD}}`), see `DATE_FORMAT_TOKENS`. `{{title}}`, `{{path}}`,
 * `{{folder}}` describe the CURRENT note when one is open, else empty string
 * (validation reports a warning when a workflow uses them without a target).
 * `{{selection}}` is the editor selection (empty if none). `{{clipboard}}` is
 * ONLY populated by an explicit user action in the prompt UI; the engine
 * never reads the clipboard itself. `{{link:<vault path>}}` renders an
 * ordinary Markdown link to that note, `[Name](relative/path.md)`.
 */
export const BUILTIN_VARIABLES = [
  "date",
  "time",
  "title",
  "path",
  "folder",
  "selection",
  "clipboard",
  "link",
] as const;
export type BuiltinVariable = (typeof BUILTIN_VARIABLES)[number];

/**
 * Bounded date/time format tokens. Anything else is literal text.
 *
 * `GGGG`/`WW` are the ISO 8601 week-year and week number (week 1 is the week
 * containing the year's first Thursday). They are a PAIR: a weekly note called
 * `2024-W01` belongs to 30 December 2024, so `YYYY` would file it under the
 * wrong year for a few days every year. Added for the calendar's weekly
 * `pathTemplate` (`src/lib/tasks/contracts.ts PeriodicNoteSettings`).
 */
export const DATE_FORMAT_TOKENS = [
  "YYYY",
  "YY",
  "MM",
  "DD",
  "HH",
  "mm",
  "ss",
  "ddd",
  "MMM",
  "GGGG",
  "WW",
] as const;
export const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";
export const DEFAULT_TIME_FORMAT = "HH:mm";

export type PromptType = "text" | "multiline" | "choice" | "date" | "clipboard";

export interface WorkflowVariable {
  name: string;
  label?: string;
  type?: PromptType; // default "text"
  required?: boolean; // default true
  default?: string;
  placeholder?: string;
  /** Required when `type === "choice"`. */
  choices?: string[];
}

/** Where a step writes. `current` = the note open in the active editor. */
export type StepTarget = "current" | { path: string };

export type OnExists = "fail" | "open" | "suffix";

export interface CreateNoteStep {
  type: "create-note";
  /** Vault-relative destination; may use variables. Must end in `.md`. */
  path: string;
  /** Vault-relative template path. Omit for an empty note or use `content`. */
  template?: string;
  /** Literal Markdown body (with variables) used when no template is given. */
  content?: string;
  /** What to do when the destination already exists. Default "fail". */
  onExists?: OnExists;
  /** Open the created note in the editor. Default true. */
  open?: boolean;
}

export interface AppendStep {
  type: "append";
  target: StepTarget;
  /** Markdown to append; variables allowed. */
  content: string;
  /** When set, append under this heading line (exact text, e.g. `## Inbox`). */
  heading?: string;
  /** "end" (default) appends at the end of the note/section; "start" prepends. */
  position?: "start" | "end";
  /** Create the target from a template when it does not exist. */
  createIfMissing?: { template?: string; content?: string };
}

export interface InsertStep {
  type: "insert";
  /** Insert at the caret of the active editor. Target must be "current". */
  target: "current";
  content: string;
}

export interface OpenNoteStep {
  type: "open-note";
  path: string;
}

export interface RunWorkflowStep {
  type: "run-workflow";
  /** Another workflow's stable id; cycles are a validation error. */
  id: WorkflowId;
}

export type WorkflowStep = CreateNoteStep | AppendStep | InsertStep | OpenNoteStep | RunWorkflowStep;
export type WorkflowStepType = WorkflowStep["type"];

export interface WorkflowDependencies {
  /** Vault-relative template paths this workflow needs. */
  templates?: string[];
  /** Workflow ids this workflow calls. */
  workflows?: WorkflowId[];
}

export interface WorkflowDefinition {
  version: typeof WORKFLOW_SCHEMA_VERSION;
  id: WorkflowId;
  name: string;
  description?: string;
  /** `lucide:<id>` or `emoji:<grapheme>`, same encoding as note icons. */
  icon?: string;
  /**
   * Optional keyboard shortcut, e.g. "mod+shift+m". `mod` is ⌘ on macOS and
   * Ctrl elsewhere. Conflicts with built-in shortcuts are reported as
   * validation warnings and the built-in wins.
   */
  shortcut?: string;
  /** Show in the editor slash menu. Default true. */
  slash?: boolean;
  variables?: WorkflowVariable[];
  requires?: WorkflowDependencies;
  steps: WorkflowStep[];
  /** Unknown top-level fields are preserved by the parser under this key. */
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

export interface WorkflowIssue {
  severity: "error" | "warning";
  /** Machine-readable code, e.g. "missing-field", "bad-id", "unknown-step". */
  code: string;
  message: string;
  /** Zero-based step index when the issue belongs to a step. */
  step?: number;
  /** Dotted field path, e.g. "steps.2.path" or "variables.0.name". */
  field?: string;
}

export interface ParsedWorkflowFile {
  /** Vault-relative path of the source note. */
  path: string;
  definition: WorkflowDefinition | null;
  issues: WorkflowIssue[];
  /** Fields the parser did not recognise, preserved verbatim by key. */
  unknownFields: Record<string, unknown>;
  /** Byte offsets of the JSON fence body within the note, for editing. */
  fence: { from: number; to: number } | null;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type PermissionLevel = "edit" | "view" | "none";

/**
 * Resolved right before a write. `revision` is a content hash the host can
 * compare against what the step expects; a mismatch is a `stale-target`.
 */
export interface ResolvedTarget {
  path: string;
  docId: string | null;
  exists: boolean;
  permission: PermissionLevel;
  revision: string | null;
  /**
   * Why the host refused, when a generic "no access" would mislead — a frozen
   * vault root, say. The engine reports it instead of its own wording; absent
   * means the default message.
   */
  permissionReason?: string;
}

export type ExecutionEffect =
  | { kind: "created"; path: string }
  | { kind: "appended"; path: string; heading?: string; bytes: number }
  | { kind: "inserted"; path: string; bytes: number }
  | { kind: "opened"; path: string }
  | { kind: "ran-workflow"; id: WorkflowId };

export type ExecutionFailureKind =
  | "validation"
  | "cancelled"
  | "permission"
  | "read-only"
  | "stale-target"
  | "missing-target"
  | "missing-heading"
  | "conflict"
  | "offline"
  | "error";

export interface ExecutionSuccess {
  ok: true;
  workflowId: WorkflowId;
  effects: ExecutionEffect[];
  warnings: WorkflowIssue[];
}

export interface ExecutionRecovery {
  /** Vault-relative path where the unsaved capture text was preserved, if any. */
  preservedAt?: string;
  /** The rendered content the user was trying to write, so the UI can offer a retry. */
  pendingContent?: string;
  retryable: boolean;
}

export interface ExecutionFailure {
  ok: false;
  workflowId: WorkflowId;
  kind: ExecutionFailureKind;
  message: string;
  step?: number;
  field?: string;
  /** Effects that completed before the failure (a partial sequence). */
  completed: ExecutionEffect[];
  recovery: ExecutionRecovery;
}

export type ExecutionResult = ExecutionSuccess | ExecutionFailure;

/** Values the prompt UI collected. Keys are variable names. */
export type PromptValues = Record<string, string>;

/**
 * Snapshot of the editor the UI passes to a run. All optional: a run from the
 * action picker with no open note has none of these.
 */
export interface EditorContext {
  currentPath?: string;
  selection?: string;
  /** Clipboard text captured by an explicit user action in the prompt UI. */
  clipboard?: string;
}

/**
 * Host abstraction the engine writes through. Production wires it to the
 * store/IPC/bridge; tests use an in-memory fake. Implementations must:
 *   - route edits to an OPEN note through the live editor / resident bridge
 *     so collaboration state is preserved;
 *   - route edits to a CLOSED note through the ordinary note write path (the
 *     watcher/sync layer treats that as an external writer and merges it);
 *   - never write outside the vault (path safety is the host's job too).
 */
export interface WorkflowHost {
  resolveTarget(path: string): Promise<ResolvedTarget>;
  currentNotePath(): string | null;
  readNote(path: string): Promise<string | null>;
  /** Create a new note with content. Fails if it exists. */
  createNote(path: string, content: string): Promise<ResolvedTarget>;
  /**
   * Replace `[from, to)` of the note's current text with `insert`. `expectedRevision`
   * must match the note's live revision or the host rejects with `stale-target`.
   */
  replaceRange(
    path: string,
    expectedRevision: string,
    from: number,
    to: number,
    insert: string,
  ): Promise<{ ok: true; revision: string } | { ok: false; kind: ExecutionFailureKind; message: string }>;
  /** Insert at the caret of the active editor. */
  insertAtCaret(text: string): Promise<boolean>;
  openNote(path: string): Promise<void>;
  /** Preserve capture text that could not be written. Returns where it went. */
  preserveCapture(workflowId: WorkflowId, content: string): Promise<string | null>;
  now(): Date;
}

/** The single command service every UI entry point calls. */
export interface CommandService {
  /** Registered workflows, sorted by name; invalid files appear with issues. */
  list(): readonly RegisteredWorkflow[];
  get(id: WorkflowId): RegisteredWorkflow | null;
  /** Variables the UI must prompt for, in declaration order, after built-ins are resolved. */
  promptsFor(id: WorkflowId): WorkflowVariable[];
  run(id: WorkflowId, values: PromptValues, ctx: EditorContext): Promise<ExecutionResult>;
  /** Re-scan the vault for workflow notes and templates. */
  refresh(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface RegisteredWorkflow {
  id: WorkflowId;
  path: string;
  definition: WorkflowDefinition | null;
  issues: WorkflowIssue[];
  /** False when any error-severity issue exists. */
  runnable: boolean;
}

// ---------------------------------------------------------------------------
// Portable packages (version 1)
// ---------------------------------------------------------------------------

export const PACKAGE_FORMAT = "noam-package" as const;
export const PACKAGE_FORMAT_VERSION = 1 as const;
export const PACKAGE_FILE_SUFFIX = ".noam-package.json";

export type PackageEntryKind = "workflow" | "template" | "asset";

export interface PackageEntry {
  /** Vault-relative destination path. Must be relative, normalised, inside the vault. */
  path: string;
  kind: PackageEntryKind;
  /** Lowercase hex SHA-256 of the entry bytes. */
  sha256: string;
  /** Workflow id when `kind === "workflow"`. */
  id?: WorkflowId;
}

export interface PackageManifest {
  format: typeof PACKAGE_FORMAT;
  formatVersion: typeof PACKAGE_FORMAT_VERSION;
  /** Stable package id, same pattern as workflow ids. */
  id: string;
  name: string;
  description?: string;
  /** Semantic version of the package contents. */
  version: string;
  /** Minimum Noam app version that understands this package. */
  minAppVersion: string;
  /** Workflow schema version the definitions use. */
  workflowSchemaVersion: number;
  dependencies?: Array<{ kind: "workflow" | "template"; id?: WorkflowId; path?: string }>;
  entries: PackageEntry[];
}

export interface PackageFileBody {
  encoding: "utf8" | "base64";
  content: string;
}

/** A package is ONE JSON file: manifest plus embedded file bodies keyed by entry path. */
export interface NoamPackage {
  manifest: PackageManifest;
  files: Record<string, PackageFileBody>;
}

export type ImportDecision = "add" | "replace" | "duplicate" | "skip" | "unsupported";

export interface ImportPreviewItem {
  entry: PackageEntry;
  decision: ImportDecision;
  /** Final vault-relative path after any rename (for "duplicate"). */
  destination: string;
  /** Present for "replace": the existing file is a prior copy of this package entry. */
  existingSha256?: string;
  /**
   * What the preview saw AT `destination`: a lowercase hex SHA-256, or null for
   * "nothing was there". `applyImport` re-checks it immediately before writing,
   * so a destination that changed while the preview was on screen stops the
   * import instead of being overwritten. `existingSha256` cannot answer this:
   * for a "duplicate" it describes the file that FORCED the rename, which is
   * not `destination`.
   */
  destinationSha256?: string | null;
  /** Why the item is skipped or unsupported. */
  reason?: string;
}

export interface ImportPreview {
  manifest: PackageManifest;
  items: ImportPreviewItem[];
  dependencies: Array<{ kind: "workflow" | "template"; ref: string; satisfied: boolean }>;
  compatibility: { ok: boolean; message?: string };
  /** Fatal problems; when non-empty the package cannot be applied. */
  errors: string[];
  /** True when every item is "skip" (already identical), i.e. a re-import is a no-op. */
  idempotent: boolean;
}

export interface ImportRecoveryRecord {
  packageId: string;
  startedAt: string;
  /** Files the import will touch, with their pre-import bytes (null = did not exist). */
  originals: Array<{ path: string; sha256: string | null; content: string | null; encoding: "utf8" | "base64" }>;
  /** Files written so far, updated as the import proceeds. */
  written: string[];
}

export type ImportOutcome =
  | { ok: true; written: string[]; skipped: string[]; recoveryRecord: string | null }
  | { ok: false; message: string; rolledBack: boolean; recoveryRecord: string | null; failedAt?: string };

/**
 * Host abstraction the package service writes through. Production maps to
 * IPC (`readNote`, `writeNoteIfMissing`, `writeNote`, `readBinaryFile`,
 * `writeBinaryFile`, `deleteFile`, `ensureFolder`); tests use an in-memory
 * fake that can be told to fail on the Nth write.
 */
export interface PackageHost {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
  writeText(path: string, content: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  ensureFolder(path: string): Promise<void>;
  /** Write a device-local recovery record; returns its path. */
  writeRecoveryRecord(record: ImportRecoveryRecord): Promise<string>;
  deleteRecoveryRecord(path: string): Promise<void>;
  appVersion(): string;
}

// ---------------------------------------------------------------------------
// QuickAdd conversion (bounded declarative subset)
// ---------------------------------------------------------------------------

export type QuickAddItemStatus = "converted" | "skipped" | "unsupported";

export interface QuickAddReportItem {
  /** QuickAdd choice/macro name as found in the source. */
  sourceName: string;
  sourceType: string;
  status: QuickAddItemStatus;
  /** Resulting workflow id when converted. */
  workflowId?: WorkflowId;
  reason?: string;
  /** Enough of the source for the user to understand the item (bounded, no scripts executed). */
  sourceExcerpt?: string;
}

export interface QuickAddConversion {
  workflows: Array<{ path: string; definition: WorkflowDefinition; markdown: string }>;
  report: QuickAddReportItem[];
}
