import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/mcp/tools.js";

/**
 * MCP tool inventory, asserted from source (CSO audit F10 + verification
 * checklist item 2). Any tool added, removed or re-annotated fails here, and so
 * does any new SQL write from `src/mcp/` into a grant/token/registry/settings
 * table. Read-only: this suite changes nothing under `src/mcp/`.
 */

const MCP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp");

type Kind = "read" | "write" | "destructive";

function classify(a: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined): Kind {
  if (a?.readOnlyHint) return "read";
  if (a?.destructiveHint) return "destructive";
  return "write";
}

describe("MCP tool inventory", () => {
  it("exposes exactly these 15 tools, classified by their annotations", () => {
    expect(Object.fromEntries(TOOLS.map((t) => [t.name, classify(t.annotations)]))).toEqual({
      list_vaults: "read",
      list_folders: "read",
      list_notes: "read",
      read_note: "read",
      search_notes: "read",
      query_knowledge: "read",
      create_note: "write",
      update_note: "write",
      append_note: "write",
      edit_note: "write",
      delete_note: "destructive",
      create_folder: "write",
      delete_folder: "destructive",
      move_note: "write",
      move_folder: "write",
    });
    expect(TOOLS).toHaveLength(15);
    // No tool claims to be both read-only and destructive.
    expect(TOOLS.filter((t) => t.annotations?.readOnlyHint && t.annotations?.destructiveHint)).toEqual(
      [],
    );
  });

  it("no src/mcp SQL writes grants, registry rows, membership, join codes or billing", () => {
    const WRITE =
      /(INSERT INTO|UPDATE|DELETE FROM)\s+"?(shares|mcp_tokens|participants|member|org_join_codes|subscriptions)\b/g;
    const matches: string[] = [];
    for (const file of readdirSync(MCP_DIR).filter((f) => f.endsWith(".ts")).sort()) {
      const src = readFileSync(join(MCP_DIR, file), "utf8");
      for (const m of src.matchAll(WRITE)) matches.push(`${file}: ${m[1]} ${m[2]}`);
    }
    // KNOWN, reported to the lead rather than changed (src/mcp is frozen):
    // `tokens.ts` writes `mcp_tokens`. None of these is reachable from a tool
    // call: create/revoke back the session-authenticated /api/mcp/tokens routes
    // (src/http/routes/mcp.ts), and the two UPDATEs are the per-request
    // last_used_at / use_count bookkeeping on the token that authenticated the
    // request. Pinned exactly, so any NEW write fails this test.
    expect(matches).toEqual([
      "tokens.ts: INSERT INTO mcp_tokens",
      "tokens.ts: DELETE FROM mcp_tokens",
      "tokens.ts: UPDATE mcp_tokens",
      "tokens.ts: UPDATE mcp_tokens",
    ]);
  });

  it("the tool dispatch path never imports the token mint/revoke functions", () => {
    for (const file of ["tools.ts", "service.ts", "protocol.ts", "doc-writer.ts"]) {
      const src = readFileSync(join(MCP_DIR, file), "utf8");
      expect(src, file).not.toMatch(/\b(createMcpToken|revokeMcpToken)\b/);
    }
  });
});
