import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";

/**
 * Participant registry (migration 027): one row per human or agent in a team
 * space (= a Better Auth organization).
 *
 * Human rows are created, deactivated and renamed by database triggers on
 * `member` and `"user"` — never here, except {@link ensureHumanParticipant}'s
 * self-heal for data that somehow predates the trigger. Agent rows are inert
 * until Phase 3: nothing can authenticate as one.
 */

type Queryable = Pick<pg.Pool, "query">;

/**
 * Fixed participant palette, in assignment order. Colorblind-safe, no
 * reds/oranges (red reads as an error). Violet `#7f73ff` is reserved for Noam
 * and must never appear here. Mirrored in SQL by `participant_color`.
 */
export const PALETTE = [
  "#696713",
  "#b4bf2c",
  "#789c5b",
  "#047e67",
  "#2fc5fa",
  "#2981fb",
  "#982f93",
  "#b976a0",
] as const;

export const HARNESSES = ["claude-code", "codex-cli", "gemini-cli", "custom"] as const;
export type Harness = (typeof HARNESSES)[number];

/**
 * TS mirror of SQL `participant_color`: 32-bit FNV-1a over UTF-8 bytes, mod 8.
 * Production colors are computed in SQL; this exists so tests can cross-check
 * the two (and it equals the desktop's `hashString` for ASCII ids).
 */
export function participantColor(seed: string): string {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(seed, "utf8")) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PALETTE[(h >>> 0) % PALETTE.length];
}

export interface ParticipantRow {
  id: string;
  organization_id: string;
  kind: "human" | "agent";
  user_id: string | null;
  display_name: string;
  color: string;
  harness: Harness | null;
  created_by: string | null;
  created_at: Date;
  deactivated_at: Date | null;
}

const COLUMNS = `id, organization_id, kind, user_id, display_name, color, harness,
                 created_by, created_at, deactivated_at`;

/** Live rows for one org, oldest first. */
export async function listParticipants(
  organizationId: string,
  db: Queryable = defaultPool,
): Promise<ParticipantRow[]> {
  const { rows } = await db.query<ParticipantRow>(
    `SELECT ${COLUMNS} FROM participants
      WHERE organization_id = $1 AND deactivated_at IS NULL
      ORDER BY created_at, id`,
    [organizationId],
  );
  return rows;
}

/** The user's live human row in the org, if any. */
export async function findLiveHuman(
  organizationId: string,
  userId: string,
  db: Queryable = defaultPool,
): Promise<ParticipantRow | null> {
  const { rows } = await db.query<ParticipantRow>(
    `SELECT ${COLUMNS} FROM participants
      WHERE organization_id = $1 AND user_id = $2
        AND kind = 'human' AND deactivated_at IS NULL`,
    [organizationId, userId],
  );
  return rows[0] ?? null;
}

/** One row by id, scoped to the org (live or not). */
export async function findParticipant(
  organizationId: string,
  id: string,
  db: Queryable = defaultPool,
): Promise<ParticipantRow | null> {
  const { rows } = await db.query<ParticipantRow>(
    `SELECT ${COLUMNS} FROM participants WHERE id = $1 AND organization_id = $2`,
    [id, organizationId],
  );
  return rows[0] ?? null;
}

/**
 * Self-heal for a member with NO human row at all (data that predates the
 * trigger): insert one and return it. The member trigger normally did this
 * already, in which case the insert is a no-op (ON CONFLICT on the live-human
 * unique index). Callers must have checked membership: this does not.
 *
 * A member whose row exists but is DEACTIVATED gets nothing back — the unique
 * index only covers live rows, so a plain insert would quietly mint a second,
 * live row and undo an admin's one-way deactivation (one-way until Phase 3).
 * Only the member trigger makes a new live row after a deactivation, and only
 * on a real rejoin (member DELETE + INSERT), never on a roster read.
 */
export async function ensureHumanParticipant(
  organizationId: string,
  userId: string,
  db: Queryable = defaultPool,
): Promise<ParticipantRow | null> {
  await db.query(
    `INSERT INTO participants (id, organization_id, kind, user_id, display_name, color)
     SELECT $1, $2, 'human', u.id, participant_human_name(u.name, u.email), participant_color(u.id)
       FROM "user" u
      WHERE u.id = $3
        AND NOT EXISTS (
          SELECT 1 FROM participants p
           WHERE p.organization_id = $2 AND p.user_id = $3 AND p.kind = 'human'
        )
     ON CONFLICT DO NOTHING`,
    [randomUUID(), organizationId, userId],
  );
  return findLiveHuman(organizationId, userId, db);
}

/** Thrown when a live agent in the org already has this name (case-insensitive). */
export class DuplicateAgentNameError extends Error {
  constructor() {
    super("duplicate_agent_name");
  }
}

function isAgentNameConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === "23505" && e.constraint === "participants_agent_name_uidx";
}

/**
 * Create an inert agent row. Its color is the palette entry used least among
 * the org's live rows, ties broken by palette order, so the first eight agents
 * in an otherwise empty org get eight different colors.
 *
 * Two concurrent creates may pick the same color; that is cosmetic and
 * accepted (colors are not unique, names are).
 */
export async function createAgentParticipant(
  input: { organizationId: string; displayName: string; harness: Harness; createdBy: string },
  db: Queryable = defaultPool,
): Promise<ParticipantRow> {
  const { rows: used } = await db.query<{ color: string; n: number }>(
    `SELECT color, count(*)::int AS n FROM participants
      WHERE organization_id = $1 AND deactivated_at IS NULL
      GROUP BY color`,
    [input.organizationId],
  );
  const counts = new Map(used.map((r) => [r.color, r.n]));
  let color: string = PALETTE[0];
  for (const c of PALETTE) {
    if ((counts.get(c) ?? 0) < (counts.get(color) ?? 0)) color = c;
  }
  try {
    const { rows } = await db.query<ParticipantRow>(
      `INSERT INTO participants (id, organization_id, kind, display_name, color, harness, created_by)
       VALUES ($1, $2, 'agent', $3, $4, $5, $6)
       RETURNING ${COLUMNS}`,
      [randomUUID(), input.organizationId, input.displayName, color, input.harness, input.createdBy],
    );
    return rows[0];
  } catch (err) {
    if (isAgentNameConflict(err)) throw new DuplicateAgentNameError();
    throw err;
  }
}

/** Rename a live agent. Null when no live agent row matches. */
export async function renameAgentParticipant(
  organizationId: string,
  id: string,
  displayName: string,
  db: Queryable = defaultPool,
): Promise<ParticipantRow | null> {
  try {
    const { rows } = await db.query<ParticipantRow>(
      `UPDATE participants SET display_name = $3
        WHERE id = $1 AND organization_id = $2 AND kind = 'agent' AND deactivated_at IS NULL
        RETURNING ${COLUMNS}`,
      [id, organizationId, displayName],
    );
    return rows[0] ?? null;
  } catch (err) {
    if (isAgentNameConflict(err)) throw new DuplicateAgentNameError();
    throw err;
  }
}

/**
 * Deactivate a live row (one-way in Phase 1). Never touches `member`: a
 * deactivated human stays a member of the org. Null when no live row matches.
 */
export async function deactivateParticipant(
  organizationId: string,
  id: string,
  db: Queryable = defaultPool,
): Promise<ParticipantRow | null> {
  const { rows } = await db.query<ParticipantRow>(
    `UPDATE participants SET deactivated_at = now()
      WHERE id = $1 AND organization_id = $2 AND deactivated_at IS NULL
      RETURNING ${COLUMNS}`,
    [id, organizationId],
  );
  return rows[0] ?? null;
}

export interface PresenceIdentity {
  participantId: string;
  name: string;
  color: string;
}

/**
 * The registry identity the vault channel stamps onto a user's presence frames
 * in one note collection (`vaults.id`): the user's live human row in the
 * collection's organization. Null when there is none.
 */
export async function resolvePresenceIdentity(
  userId: string,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<PresenceIdentity | null> {
  const { rows } = await db.query<{ id: string; display_name: string; color: string }>(
    `SELECT p.id, p.display_name, p.color
       FROM vaults v
       JOIN participants p ON p.organization_id = v.organization_id
      WHERE v.id = $2 AND p.user_id = $1
        AND p.kind = 'human' AND p.deactivated_at IS NULL`,
    [userId, vaultId],
  );
  const row = rows[0];
  return row ? { participantId: row.id, name: row.display_name, color: row.color } : null;
}
