/**
 * The workflow system's public surface.
 *
 * UI code imports from HERE, never from `engine/*` — the engine's internal
 * shape (which file owns `planAppend`, where the scope type lives) is free to
 * move, and this list is the promise that does not.
 *
 * The three things a UI entry point needs:
 *   - `createVaultCommandService()` once per vault, then `refresh()`;
 *   - `service.promptsFor(id)` to build the prompt, whose answers become the
 *     `PromptValues` record passed to `service.run(id, values, ctx)`;
 *   - the `ExecutionResult` back, which is either effects + warnings or a
 *     failure naming the step, the field and how to recover.
 */

// The frozen contracts, so nobody has to know they live one level down.
export * from "./contracts";

// Reading and writing workflow notes.
export {
  hasWorkflowMarker,
  isWorkflowNote,
  parseWorkflowNote,
  serializeWorkflowNote,
  type ParseOptions,
} from "./engine/parse";

// Schema checks. `unsafePathReason` is exported because the package importer
// and the QuickAdd converter check destinations with the same rule.
export { unsafePathReason, validateDefinition, type ValidationRegistry } from "./engine/validate";

// Expansion, for a UI that wants to preview what a prompt answer will produce.
export {
  expand,
  formatDate,
  scanVariableRefs,
  type ExpansionResult,
  type VariableRef,
  type VariableScope,
} from "./engine/variables";
export { renderTemplate } from "./engine/template";

// Execution.
export { MAX_WORKFLOW_DEPTH, planAppend, runWorkflow, type AppendPlan } from "./engine/executor";
export { createCommandService, type CommandServiceDeps } from "./engine/registry";

// Production wiring.
export { createVaultCommandService, createWorkflowHost, permissionForPath, CAPTURES_FOLDER } from "./adapter";

// Portable packages. The UI imports these from here too, so `packages/*` can
// reorganise without every dialog changing its import.
export {
  exportPackage,
  parsePackage,
  serializePackage,
  type PackageSelection,
  type PackageSelectionEntry,
} from "./packages/export";
export { previewImport, type PreviewOptions } from "./packages/preview";
export { applyImport, type ApplyOptions } from "./packages/apply";
export { compareVersions, validatePackage } from "./packages/manifest";
export {
  createPackageHost,
  listRecoveryRecords,
  localStorageRecoveryStore,
  memoryRecoveryStore,
  type PackageHostOptions,
  type RecoveryStore,
} from "./packages/hostAdapter";
export {
  PackageLedger,
  ledgerKey,
  localStorageLedgerStore,
  memoryLedgerStore,
  type LedgerEntry,
  type LedgerRecord,
  type LedgerStore,
} from "./packages/ledger";

// QuickAdd conversion.
export { convertQuickAdd, type QuickAddConvertOptions } from "./quickadd/convert";

// Bundled examples, and the package they install through.
export {
  EXAMPLE_FILES,
  EXAMPLES_PACKAGE_ID,
  EXAMPLES_PACKAGE_VERSION,
  type ExampleFile,
} from "./examples/index";
export { buildExamplesPackage, EXAMPLES_PACKAGE_NAME } from "./examples/package";
