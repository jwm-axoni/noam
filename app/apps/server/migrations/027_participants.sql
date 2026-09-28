-- Participant registry (Phase 0): one row per human or agent in a team space.
-- A team space IS the Better Auth organization; there is no new team table.
-- Human rows are live identity (presence name + color). Agent rows are inert
-- data until Phase 3: no token kind can authenticate as one.
--
-- DESIGN
--
-- * Human rows are created by a TRIGGER on `member`, not by an application
--   hook. Three paths write member rows: Better Auth accept-invitation, Better
--   Auth create-organization (the owner's member row), and POST /api/orgs/join.
--   `src/auth/auth.ts` is frozen, and Better Auth's hooks run outside its own
--   transaction, so "the participant row lands in the same transaction as the
--   membership" is only achievable in the database. The trigger makes a member
--   without a participant row impossible by construction; a rolled-back member
--   insert takes its participant row with it.
-- * A member DELETE deactivates the human row (`deactivated_at = now()`), so
--   every live human participant is a current member. Rejoining creates a new
--   live row (the unique index only covers live rows) with the same color.
-- * A user rename follows into the live human rows' `display_name`, so the
--   registry never shows a stale name. The API therefore renames agents only.
-- * Color is a deterministic function of the user id, computed here by
--   `participant_color`: 32-bit FNV-1a over the UTF-8 bytes of the seed, mod 8,
--   over a fixed palette. It matches the desktop's `hashString`
--   (`app/apps/desktop/src/lib/presence/color.ts`) for ASCII ids, which is all
--   Better Auth emits. Stored, never recomputed, never updated. The palette is
--   colorblind-safe with no reds/oranges; violet #7f73ff is reserved for Noam
--   and is not in it.
-- * Agent rows take the LEAST-USED palette color among the org's live rows
--   (ties by palette order). That choice depends on the rest of the org, so it
--   lives in TS (`src/registry/participants.ts createAgentParticipant`), not
--   here.
--
-- WHAT WAS WRONG WITH THE ORIGINAL DDL (noam-phase01-spec.md section 5)
--
-- * `user_id ... ON DELETE SET NULL` together with
--   `CHECK (kind = 'agent' OR user_id IS NOT NULL)`: deleting any user with a
--   human row would null the column, violate the CHECK, and abort the delete.
--   `user_id` is ON DELETE CASCADE here. Nothing is lost that was not already:
--   `notes.last_edited_by` is itself ON DELETE SET NULL (migration 017).
-- * The backfill used `hashtext`, which is an internal, unversioned Postgres
--   hash no client can reproduce, over the Okabe-Ito palette the product
--   decision rejected. Both replaced by `participant_color` above.
-- * The backfill copied `u.name` verbatim; a blank name now falls back to the
--   email local part.
-- * `CHECK (kind = 'human' OR harness IS NULL)` forbade a harness on AGENT
--   rows, the opposite of the column's own comment ("agent-only, NULL for
--   humans"): no agent row could ever be created. Inverted here to
--   `kind = 'agent' OR harness IS NULL`.
-- * The agent-name unique index was case-sensitive, so "Claude" and "claude"
--   could coexist; it is on lower(display_name) here.

CREATE TABLE participants (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  -- Set for humans, NULL for agents.
  user_id         TEXT REFERENCES "user" (id) ON DELETE CASCADE,
  display_name    TEXT NOT NULL,
  color           TEXT NOT NULL CHECK (color ~ '^#[0-9a-f]{6}$'),
  harness         TEXT CHECK (harness IN ('claude-code', 'codex-cli', 'gemini-cli', 'custom')),
  created_by      TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft delete, one-way in Phase 1. Deactivated rows leave presence and the
  -- listing; attribution (notes.last_edited_by) is untouched.
  deactivated_at  TIMESTAMPTZ,
  CHECK (kind = 'agent' OR user_id IS NOT NULL),
  -- harness is agent-only: a human row never carries one.
  CHECK (kind = 'agent' OR harness IS NULL)
);

CREATE INDEX participants_org_idx ON participants (organization_id);

-- One live human row per (org, user).
CREATE UNIQUE INDEX participants_human_user_uidx
  ON participants (organization_id, user_id)
  WHERE kind = 'human' AND user_id IS NOT NULL AND deactivated_at IS NULL;

-- Live agent names are unique per org, case-insensitively.
CREATE UNIQUE INDEX participants_agent_name_uidx
  ON participants (organization_id, lower(display_name))
  WHERE kind = 'agent' AND deactivated_at IS NULL;

-- 32-bit FNV-1a (offset basis 2166136261, prime 16777619) over the UTF-8 bytes
-- of `seed`, mod 8, into the fixed palette. bigint arithmetic: the hash stays
-- below 2^32 and the product below 2^57, so nothing overflows.
CREATE FUNCTION participant_color(seed text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  palette CONSTANT text[] := ARRAY[
    '#696713', '#b4bf2c', '#789c5b', '#047e67',
    '#2fc5fa', '#2981fb', '#982f93', '#b976a0'
  ];
  bytes bytea := convert_to(seed, 'UTF8');
  h bigint := 2166136261;
  i integer;
BEGIN
  FOR i IN 0 .. length(bytes) - 1 LOOP
    h := ((h # get_byte(bytes, i)) * 16777619) % 4294967296;
  END LOOP;
  RETURN palette[(h % 8) + 1];
END;
$$;

-- The display name a human row carries: the account name, else the email's
-- local part (the same fallback the join announcement uses).
CREATE FUNCTION participant_human_name(name text, email text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(NULLIF(btrim(name), ''), split_part(email, '@', 1))
$$;

-- member INSERT -> live human participant, in the member insert's transaction.
CREATE FUNCTION participants_on_member_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO participants (id, organization_id, kind, user_id, display_name, color)
  SELECT gen_random_uuid()::text, NEW."organizationId", 'human', u.id,
         participant_human_name(u.name, u.email), participant_color(u.id)
    FROM "user" u
   WHERE u.id = NEW."userId"
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER participants_member_insert
  AFTER INSERT ON member
  FOR EACH ROW EXECUTE FUNCTION participants_on_member_insert();

-- member DELETE -> deactivate that user's live human row in that org.
CREATE FUNCTION participants_on_member_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE participants
     SET deactivated_at = now()
   WHERE organization_id = OLD."organizationId"
     AND user_id = OLD."userId"
     AND kind = 'human'
     AND deactivated_at IS NULL;
  RETURN NULL;
END;
$$;

CREATE TRIGGER participants_member_delete
  AFTER DELETE ON member
  FOR EACH ROW EXECUTE FUNCTION participants_on_member_delete();

-- user rename -> live human rows follow.
CREATE FUNCTION participants_on_user_rename() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE participants
     SET display_name = participant_human_name(NEW.name, NEW.email)
   WHERE user_id = NEW.id
     AND kind = 'human'
     AND deactivated_at IS NULL;
  RETURN NULL;
END;
$$;

CREATE TRIGGER participants_user_rename
  AFTER UPDATE OF name, email ON "user"
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION participants_on_user_rename();

-- Backfill: every existing member becomes a live human participant.
INSERT INTO participants (id, organization_id, kind, user_id, display_name, color)
SELECT gen_random_uuid()::text, m."organizationId", 'human', u.id,
       participant_human_name(u.name, u.email), participant_color(u.id)
  FROM member m
  JOIN "user" u ON u.id = m."userId"
ON CONFLICT DO NOTHING;
