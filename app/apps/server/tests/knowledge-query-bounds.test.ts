import { describe, expect, it, vi } from "vitest";
import { createKnowledgeQuery } from "../src/knowledge/query.js";

describe("knowledge query bounds", () => {
  const neverReadPermissions = vi.fn(async () => {
    throw new Error("permission lookup must not run for invalid bounds");
  });
  const query = createKnowledgeQuery(
    { actorId: "actor", vaultId: "vault" },
    { readableDocs: neverReadPermissions },
  );

  it("rejects pages above the contract limit before reading data", async () => {
    await expect(query({ page: { limit: 51 } })).rejects.toMatchObject({
      code: "limit_exceeded",
    });
    expect(neverReadPermissions).not.toHaveBeenCalled();
  });

  it("rejects traversal deeper than the contract limit before reading data", async () => {
    await expect(
      query({
        traverse: {
          fromDocId: "doc",
          relationshipIds: [],
          direction: "outgoing",
          maxDepth: 5 as 4,
        },
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(neverReadPermissions).not.toHaveBeenCalled();
  });

  it("rejects oversized filter arrays before reading data", async () => {
    await expect(query({
      where: Array.from({ length: 51 }, () => ({
        propertyId: "status",
        op: "eq" as const,
        value: "ready",
      })),
    })).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(neverReadPermissions).not.toHaveBeenCalled();
  });

  it("rejects pathological relationship filters before reading data", async () => {
    await expect(query({
      traverse: {
        fromDocId: "doc",
        relationshipIds: ["Owner"],
        direction: "outgoing",
        maxDepth: 1,
      },
    })).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(query({
      traverse: {
        fromDocId: "doc",
        relationshipIds: Array.from({ length: 51 }, () => "owner"),
        direction: "outgoing",
        maxDepth: 1,
      },
    })).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(neverReadPermissions).not.toHaveBeenCalled();
  });
});
