// Thin shim over the engine's workflow-note reader and writer so the package
// and QuickAdd services never carry a second copy of the file format.

import type { WorkflowDefinition } from "../contracts";
import {
  parseWorkflowNote as parseWorkflowFile,
  serializeWorkflowNote as serializeWorkflowFile,
} from "../engine/parse";

/** Render a workflow definition as the Markdown note that carries it. */
export function serializeWorkflowNote(definition: WorkflowDefinition): string {
  const prose = definition.description
    ? `# ${definition.name}\n\n${definition.description}`
    : `# ${definition.name}`;
  return serializeWorkflowFile(definition, prose);
}

/** The JSON fence body of a workflow note, or null when this is not one. */
export function parseWorkflowNote(markdown: string): WorkflowDefinition | null {
  return parseWorkflowFile("", markdown, { validate: false }).definition;
}

/** The workflow id a note declares, if it is a workflow note at all. */
export function readWorkflowId(markdown: string): string | null {
  const definition = parseWorkflowNote(markdown);
  return typeof definition?.id === "string" ? definition.id : null;
}
