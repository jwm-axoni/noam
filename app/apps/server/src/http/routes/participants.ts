import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import {
  DuplicateAgentNameError,
  HARNESSES,
  createAgentParticipant,
  deactivateParticipant,
  ensureHumanParticipant,
  findLiveHuman,
  findParticipant,
  listParticipants,
  renameAgentParticipant,
  type Harness,
  type ParticipantRow,
} from "../../registry/participants.js";

/**
 * Participant registry routes (session-authenticated, org members only).
 *
 *  - GET   /api/orgs/:orgId/participants → the org's live roster plus `self`,
 *    the caller's own participant id. Identity, not presence.
 *  - POST  /api/orgs/:orgId/participants → owner/admin create an inert AGENT
 *    row. Human rows are created by the `member` trigger (migration 027).
 *  - PATCH /api/orgs/:orgId/participants/:id → owner/admin rename an agent
 *    and/or deactivate any row (one-way). A human's name follows their account.
 *
 * The payload never carries emails or user ids.
 */
export interface ParticipantDeps {
  /**
   * Fired for every note collection of the org after a PATCH deactivates or
   * renames a row. The vault channel re-resolves each connection's registry
   * identity on it, so a deactivated participant leaves live presence now
   * (announced `gone`) instead of at their next reconnect.
   */
  onAclChanged: (vaultId: string) => void;
}

const MAX_NAME = 64;
// C0 and C1 control characters (includes DEL).
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Trimmed, 1-64 characters, no control characters; null when invalid. */
function validDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  const len = Array.from(name).length;
  if (len < 1 || len > MAX_NAME || CONTROL.test(name)) return null;
  return name;
}

function isHarness(raw: unknown): raw is Harness {
  return typeof raw === "string" && (HARNESSES as readonly string[]).includes(raw);
}

function toJson(row: ParticipantRow) {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    color: row.color,
    harness: row.harness,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function isManager(role: string | null): boolean {
  return role === "owner" || role === "admin";
}

export function createParticipantRoutes(deps: ParticipantDeps): Hono {
  const participantRoutes = new Hono();

  participantRoutes.get("/orgs/:orgId/participants", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const orgId = c.req.param("orgId");
    if (!(await orgRole(orgId, session.userId))) return c.json({ error: "not_a_member" }, 403);

    // Self-heal a member with no live row (the trigger makes this a no-op on
    // every normal path).
    const self =
      (await findLiveHuman(orgId, session.userId)) ??
      (await ensureHumanParticipant(orgId, session.userId));
    const rows = await listParticipants(orgId);
    return c.json({ participants: rows.map(toJson), self: self?.id ?? null });
  });

  participantRoutes.post("/orgs/:orgId/participants", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const orgId = c.req.param("orgId");
    const role = await orgRole(orgId, session.userId);
    if (!role) return c.json({ error: "not_a_member" }, 403);
    if (!isManager(role)) return c.json({ error: "owner_or_admin_required" }, 403);

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "invalid_body" }, 400);
    if (body.kind === "human") return c.json({ error: "human_rows_are_created_on_join" }, 400);
    if (body.kind !== "agent") return c.json({ error: "invalid_kind" }, 400);
    const displayName = validDisplayName(body.displayName);
    if (!displayName) return c.json({ error: "invalid_display_name" }, 400);
    if (!isHarness(body.harness)) return c.json({ error: "invalid_harness" }, 400);

    try {
      const row = await createAgentParticipant({
        organizationId: orgId,
        displayName,
        harness: body.harness,
        createdBy: session.userId,
      });
      return c.json(toJson(row), 201);
    } catch (err) {
      if (err instanceof DuplicateAgentNameError) {
        return c.json({ error: "duplicate_agent_name" }, 409);
      }
      throw err;
    }
  });

  participantRoutes.patch("/orgs/:orgId/participants/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const orgId = c.req.param("orgId");
    const role = await orgRole(orgId, session.userId);
    if (!role) return c.json({ error: "not_a_member" }, 403);
    if (!isManager(role)) return c.json({ error: "owner_or_admin_required" }, 403);

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "invalid_body" }, 400);
    if ("color" in body) return c.json({ error: "color_immutable" }, 400);
    // Deactivation is one-way until Phase 3. The spec's `deactivatedAt` shape is
    // accepted only far enough to refuse its re-activation form explicitly.
    if ("deactivatedAt" in body) {
      return c.json(
        { error: body.deactivatedAt === null ? "reactivation_unsupported" : "invalid_body" },
        400,
      );
    }
    if ("deactivated" in body && body.deactivated !== true) {
      return c.json({ error: "reactivation_unsupported" }, 400);
    }
    const wantsRename = "displayName" in body;
    const wantsDeactivate = body.deactivated === true;
    if (!wantsRename && !wantsDeactivate) return c.json({ error: "invalid_body" }, 400);

    const id = c.req.param("id");
    const row = await findParticipant(orgId, id);
    // A deactivated row is gone from the registry's point of view.
    if (!row || row.deactivated_at) return c.json({ error: "participant_not_found" }, 404);

    let current = row;
    if (wantsRename) {
      if (row.kind === "human") return c.json({ error: "human_name_follows_account" }, 400);
      const displayName = validDisplayName(body.displayName);
      if (!displayName) return c.json({ error: "invalid_display_name" }, 400);
      try {
        const renamed = await renameAgentParticipant(orgId, id, displayName);
        if (!renamed) return c.json({ error: "participant_not_found" }, 404);
        current = renamed;
      } catch (err) {
        if (err instanceof DuplicateAgentNameError) {
          return c.json({ error: "duplicate_agent_name" }, 409);
        }
        throw err;
      }
    }
    if (wantsDeactivate) {
      const done = await deactivateParticipant(orgId, id);
      if (!done) return c.json({ error: "participant_not_found" }, 404);
      current = done;
    }
    // Only a HUMAN deactivation changes anything a live socket shows (their
    // presence must retract), so only that case broadcasts. `acl-changed` makes
    // every connected member re-mint their open note, which an agent rename or
    // an agent deactivation (inert rows, no presence in Phase 1) never justifies.
    // After the write, so the channel's re-resolve sees the new row state.
    if (wantsDeactivate && current.kind === "human") {
      const vaults = await pool.query<{ id: string }>(
        "SELECT id FROM vaults WHERE organization_id = $1",
        [orgId],
      );
      for (const v of vaults.rows) deps.onAclChanged(v.id);
    }
    return c.json({
      ...toJson(current),
      deactivatedAt: current.deactivated_at ? new Date(current.deactivated_at).toISOString() : null,
    });
  });

  return participantRoutes;
}
