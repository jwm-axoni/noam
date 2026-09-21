import { describe, expect, it } from "vitest";
import { TOOLS, parseKnowledgeArgs } from "../src/mcp/tools.js";

describe("query_knowledge MCP contract", () => {
  it("advertises a read-only bounded tool", () => {
    const tool = TOOLS.find((candidate) => candidate.name === "query_knowledge");
    expect(tool).toBeDefined();
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tool?.inputSchema).toMatchObject({
      required: ["vaultId"],
      additionalProperties: false,
    });
  });

  it("maps the flat tool input to the internal query", () => {
    expect(parseKnowledgeArgs({
      vaultId: "vault-a",
      text: "launch plan",
      where: [{ propertyId: "status", op: "eq", value: "active" }],
      traverse: {
        fromDocId: "doc-a",
        relationshipIds: ["depends_on"],
        direction: "outgoing",
        maxDepth: 2,
      },
      consistency: "allow-stale",
      limit: 20,
      cursor: "opaque",
    })).toEqual({
      vaultId: "vault-a",
      query: {
        text: "launch plan",
        where: [{ propertyId: "status", op: "eq", value: "active" }],
        traverse: {
          fromDocId: "doc-a",
          relationshipIds: ["depends_on"],
          direction: "outgoing",
          maxDepth: 2,
        },
        consistency: "allow-stale",
        page: { limit: 20, cursor: "opaque" },
      },
    });
  });

  it("rejects pathological inputs before any data read", () => {
    expect(() => parseKnowledgeArgs({ vaultId: "vault", limit: 51 })).toThrow(/limit/);
    expect(() => parseKnowledgeArgs({
      vaultId: "vault",
      where: Array.from({ length: 17 }, () => ({ propertyId: "x", op: "eq", value: "y" })),
    })).toThrow(/16/);
    expect(() => parseKnowledgeArgs({
      vaultId: "vault",
      traverse: {
        fromDocId: "doc",
        relationshipIds: Array.from({ length: 33 }, () => "related"),
        direction: "incoming",
        maxDepth: 1,
      },
    })).toThrow(/32/);
    expect(() => parseKnowledgeArgs({ vaultId: "vault", cursor: "x".repeat(8_193) }))
      .toThrow(/cursor/);
  });
});
