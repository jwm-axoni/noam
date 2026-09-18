import { Text } from "@codemirror/state";
import { parseFrontmatter } from "../frontmatter/parse";
import { findFrontmatter } from "./frontmatter";

export interface DocumentStats {
  words: number;
  characters: number;
  backlinks: number;
  properties: number;
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** Statistics for the exact text in the current editor buffer. */
export function documentStats(source: string, indexedBacklinks: number): DocumentStats {
  const doc = Text.of(source.split("\n"));
  const frontmatter = findFrontmatter(doc);
  const parsed = frontmatter ? parseFrontmatter(doc, frontmatter) : null;
  // Word count covers the body only: frontmatter keys and values are metadata
  // the writer didn't compose as prose, and the Properties table already
  // surfaces them. Character count stays the full buffer length.
  const body = frontmatter ? source.slice(frontmatter.to) : source;

  return {
    words: body.match(WORD)?.length ?? 0,
    // JavaScript string length counts UTF-16 code units. Iteration counts code
    // points, so one emoji is one character in the number shown to a writer.
    characters: [...source].length,
    backlinks: Math.max(0, Math.trunc(indexedBacklinks)),
    properties: parsed?.ok ? parsed.entries.length : 0,
  };
}
