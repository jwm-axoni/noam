/**
 * Reading a workflow note, and writing one back.
 *
 * A workflow definition lives in an ORDINARY Markdown file — frontmatter that
 * says `noam_kind: workflow`, prose a person can read, and one fenced block of
 * JSON. That is deliberate: the file syncs, versions, merges and diffs like
 * every other note, and nothing about it needs `.context/`.
 *
 * Recognition is two independent facts (the marker AND the fence), so a note
 * that merely quotes a workflow in a code block is never claimed, and a note
 * whose fence was deleted reports a MISSING fence rather than quietly ceasing
 * to be a workflow.
 *
 * Offsets in `fence` are JS string indices into the note text — the same units
 * CodeMirror uses, so the Workflows view can turn them into a document range
 * without a conversion step.
 */

import { Text } from "@codemirror/state";
import { findFrontmatter } from "../../editor/frontmatter";
import { parseFrontmatter } from "../../frontmatter/parse";
import {
  WORKFLOW_FENCE_INFO,
  WORKFLOW_KIND_KEY,
  WORKFLOW_KIND_VALUE,
  WORKFLOW_SCHEMA_VERSION,
  type ParsedWorkflowFile,
  type WorkflowDefinition,
  type WorkflowIssue,
} from "../contracts";
import { validateDefinition } from "./validate";

/** Top-level keys version 1 defines. Everything else is preserved untouched. */
const KNOWN_FIELDS = [
  "version",
  "id",
  "name",
  "description",
  "icon",
  "shortcut",
  "slash",
  "variables",
  "requires",
  "steps",
] as const;

const KNOWN = new Set<string>(KNOWN_FIELDS);

export interface ParseOptions {
  /** Run the schema checks too. Off for callers that revalidate with a
   *  vault-wide registry (see `registry.ts`) and do not want them twice. */
  validate?: boolean;
}

function error(code: string, message: string, extra: Partial<WorkflowIssue> = {}): WorkflowIssue {
  return { severity: "error", code, message, ...extra };
}

/**
 * Does the frontmatter carry the workflow marker?
 *
 * The vault scan filters on THIS rather than on `isWorkflowNote`: a note whose
 * author said it is a workflow and then deleted its fence has to be reported as
 * broken, not quietly dropped from the command list.
 */
export function hasWorkflowMarker(markdown: string): boolean {
  const doc = Text.of(markdown.split("\n"));
  const fm = findFrontmatter(doc);
  if (!fm) return false;
  const parsed = parseFrontmatter(doc, fm);
  if (!parsed.ok) return false;
  const entry = parsed.entries.find((e) => e.key === WORKFLOW_KIND_KEY);
  return entry?.value.kind === "text" && entry.value.value === WORKFLOW_KIND_VALUE;
}

interface Fence {
  /** Start of the fence body (first character after the opening line). */
  from: number;
  /** End of the fence body (the newline before the closing line). */
  to: number;
}

/**
 * Every fence whose info string starts with `json noam-workflow`.
 *
 * A real fence scan, not a regex: a block opened with four backticks is only
 * closed by four or more, which is how a definition whose `description`
 * mentions ``` stays in one piece.
 */
function findWorkflowFences(markdown: string): Fence[] {
  const found: Fence[] = [];
  const lines = markdown.split("\n");
  let offset = 0;
  // Line start offsets, so a fence body can be sliced out of the original text.
  const starts = lines.map((line) => {
    const at = offset;
    offset += line.length + 1;
    return at;
  });

  let open: { char: string; length: number; bodyFrom: number; claimed: boolean } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) {
      if (!match) continue;
      const marker = match[1]!;
      // A backtick fence's info string may not contain a backtick (CommonMark).
      const info = match[2]!.trim();
      if (marker[0] === "`" && info.includes("`")) continue;
      open = {
        char: marker[0]!,
        length: marker.length,
        bodyFrom: starts[i]! + line.length + 1,
        claimed: info.startsWith(WORKFLOW_FENCE_INFO),
      };
      continue;
    }
    // Inside a block: only a bare run of >= the opening length closes it.
    if (match && match[1]![0] === open.char && match[1]!.length >= open.length && match[2]!.trim() === "") {
      if (open.claimed) {
        // `bodyFrom - 1` when the block is empty: the body never started.
        const to = Math.max(open.bodyFrom - 1, starts[i]! - 1);
        found.push({ from: open.bodyFrom, to });
      }
      open = null;
    }
  }
  // An unterminated fence still yields its body, so a half-typed note reports a
  // JSON problem rather than "there is no fence here".
  if (open?.claimed) found.push({ from: open.bodyFrom, to: markdown.length });
  return found;
}

/**
 * True when this file is a workflow note: the marker AND exactly one fence.
 * The vault scan calls this before parsing, so ordinary notes cost one
 * frontmatter read and nothing else.
 */
export function isWorkflowNote(markdown: string): boolean {
  return hasWorkflowMarker(markdown) && findWorkflowFences(markdown).length === 1;
}

/** Read a workflow note. Never throws: every failure is an issue. */
export function parseWorkflowNote(
  path: string,
  markdown: string,
  options: ParseOptions = {},
): ParsedWorkflowFile {
  const issues: WorkflowIssue[] = [];
  const empty: ParsedWorkflowFile = {
    path,
    definition: null,
    issues,
    unknownFields: {},
    fence: null,
  };

  if (!hasWorkflowMarker(markdown)) {
    issues.push(
      error("not-a-workflow", `Needs \`${WORKFLOW_KIND_KEY}: ${WORKFLOW_KIND_VALUE}\` in its frontmatter.`, {
        field: WORKFLOW_KIND_KEY,
      }),
    );
    return empty;
  }

  const fences = findWorkflowFences(markdown);
  if (fences.length === 0) {
    issues.push(
      error("missing-fence", `Needs one \`\`\`${WORKFLOW_FENCE_INFO} block holding the definition.`),
    );
    return empty;
  }
  if (fences.length > 1) {
    issues.push(
      error(
        "duplicate-fence",
        `Has ${fences.length} \`${WORKFLOW_FENCE_INFO}\` blocks; a workflow note may have exactly one.`,
      ),
    );
    return empty;
  }

  const fence = fences[0]!;
  const body = markdown.slice(fence.from, fence.to);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (err) {
    issues.push(
      error("bad-json", `The definition is not valid JSON: ${(err as Error).message}`, { field: "json" }),
    );
    return { ...empty, fence };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push(error("bad-shape", "The definition must be a JSON object.", { field: "json" }));
    return { ...empty, fence };
  }

  const record = value as Record<string, unknown>;
  const unknownFields: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (KNOWN.has(key)) continue;
    unknownFields[key] = record[key];
    issues.push({
      severity: "warning",
      code: "unknown-field",
      message: `"${key}" is not part of workflow schema version ${WORKFLOW_SCHEMA_VERSION}; it is kept as-is.`,
      field: key,
    });
  }

  const definition = record as WorkflowDefinition;
  if (options.validate !== false) issues.push(...validateDefinition(definition));
  return { path, definition, issues, unknownFields, fence };
}

/** Emit the JSON with a stable key order, so a round trip is byte-identical. */
function orderedDefinition(definition: WorkflowDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of KNOWN_FIELDS) {
    if (definition[key] !== undefined) out[key] = definition[key];
  }
  for (const key of Object.keys(definition)) {
    if (!KNOWN.has(key) && definition[key] !== undefined) out[key] = definition[key];
  }
  return out;
}

/**
 * Render a definition as the Markdown note that holds it. Used by the package
 * importer, the QuickAdd converter and any UI that creates a workflow, so all
 * three produce the same file for the same definition.
 */
export function serializeWorkflowNote(definition: WorkflowDefinition, prose?: string): string {
  const head = `---\n${WORKFLOW_KIND_KEY}: ${WORKFLOW_KIND_VALUE}\n---\n`;
  const text = prose?.trim();
  const middle = text ? `\n${text}\n` : "";
  const json = JSON.stringify(orderedDefinition(definition), null, 2);
  return `${head}${middle}\n\`\`\`${WORKFLOW_FENCE_INFO}\n${json}\n\`\`\`\n`;
}
