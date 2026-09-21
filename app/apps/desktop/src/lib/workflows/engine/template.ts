/**
 * Rendering a template file.
 *
 * A template is an ORDINARY Markdown note — no marker, no special folder — so
 * rendering one is "expand the variables and hand back the text". The single
 * subtlety is frontmatter: a prompt answer with a newline or a colon in it,
 * pasted straight into a YAML value, turns a valid note into an unparseable
 * one. So the body is expanded as text, while each frontmatter VALUE is
 * expanded as a value and re-serialized through the writer the Properties panel
 * uses (`frontmatter/edit.ts`), which quotes exactly when quoting is needed.
 *
 * Why the tokens are masked first: `frontmatter/parse.ts` refuses a value
 * beginning with `{` — that is a flow mapping, which is outside the flat subset
 * — so `created: {{date}}` would read as unparseable YAML and the whole block
 * would be skipped. Swapping each `{{…}}` for a plain alphanumeric placeholder
 * makes the template parse as the note it is ABOUT to become, and the
 * placeholders are put back (expanded) on the way out. Nothing outside a value
 * is touched, so a key is never expanded: a template that computes its own
 * property names is one nobody can read, and it is the only way an expansion
 * could change a note's shape rather than its content.
 */

import { Text } from "@codemirror/state";
import { findFrontmatter } from "../../editor/frontmatter";
import { parseFrontmatter, type PropValue } from "../../frontmatter/parse";
import { planSetValue, type SpanChange } from "../../frontmatter/edit";
import type { WorkflowIssue } from "../contracts";
import { expand, type ExpansionResult, type VariableScope } from "./variables";

const TOKEN = /\{\{[^{}]*\}\}/g;
/** A placeholder the YAML subset reads as an ordinary text scalar. */
const MASK = /NoamWorkflowVar(\d+)End/g;
const maskFor = (index: number) => `NoamWorkflowVar${index}End`;

function maskTokens(text: string): { masked: string; tokens: string[] } {
  const tokens: string[] = [];
  const masked = text.replace(TOKEN, (whole) => {
    tokens.push(whole);
    return maskFor(tokens.length - 1);
  });
  return { masked, tokens };
}

function unmask(text: string, tokens: readonly string[]): string {
  return text.replace(MASK, (whole, index: string) => tokens[Number(index)] ?? whole);
}

/** Restore the tokens in one value and expand them. Values the YAML reader
 *  classified as a number, checkbox or date cannot hold a token, so they are
 *  handed back untouched and `planSetValue` writes nothing for them. */
function expandValue(
  value: PropValue,
  tokens: readonly string[],
  scope: VariableScope,
  issues: WorkflowIssue[],
): PropValue {
  const one = (text: string): string => {
    const r = expand(unmask(text, tokens), scope);
    issues.push(...r.issues);
    return r.text;
  };
  if (value.kind === "text") return { kind: "text", value: one(value.value) };
  if (value.kind === "list") return { kind: "list", value: value.value.map(one) };
  return value;
}

/**
 * Expand a template file's text. Returns the rendered Markdown plus every issue
 * the expansion hit; the caller decides whether an error-severity issue means
 * the step must not write.
 */
export function renderTemplate(markdown: string, scope: VariableScope): ExpansionResult {
  const fm = findFrontmatter(Text.of(markdown.split("\n")));
  if (!fm) return expand(markdown, scope);

  const body = expand(markdown.slice(fm.to), scope);
  const { masked, tokens } = maskTokens(markdown.slice(0, fm.to));
  const maskedDoc = Text.of(masked.split("\n"));
  const maskedFm = findFrontmatter(maskedDoc);
  const parsed = maskedFm ? parseFrontmatter(maskedDoc, maskedFm) : null;

  if (!parsed?.ok) {
    // YAML outside the subset is never rewritten — the same refusal the
    // Properties panel makes. The body still renders.
    return {
      text: markdown.slice(0, fm.to) + body.text,
      issues: [
        {
          severity: "warning",
          code: "frontmatter-unparsed",
          message: `The template's frontmatter (${parsed?.reason ?? "malformed"}) was left as-is; only its body was expanded.`,
          field: "frontmatter",
        },
        ...body.issues,
      ],
    };
  }

  const issues: WorkflowIssue[] = [];
  const changes: SpanChange[] = [];
  for (const entry of parsed.entries) {
    changes.push(...planSetValue(entry, expandValue(entry.value, tokens, scope, issues)));
  }

  // Right to left, so an earlier span's offsets are still the ones we measured.
  let head = masked;
  for (const change of changes.sort((a, b) => b.from - a.from)) {
    head = head.slice(0, change.from) + change.insert + head.slice(change.to);
  }
  // Anything still masked sat outside a value (a key, a comment); it goes back
  // exactly as it was written.
  return { text: unmask(head, tokens) + body.text, issues: [...issues, ...body.issues] };
}
