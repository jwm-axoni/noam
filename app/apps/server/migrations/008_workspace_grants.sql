-- Workspace-scoped grants (spec 04 §3 extension; powers the Access panel's
-- Open / Read-only modes).
--
-- A workspace grant is a `shares` row with resource_type = 'workspace' and
-- resource_id = the organization id. Unlike a folder/file grant it covers the
-- WHOLE workspace — including notes/files sitting at the vault root
-- (folder_id NULL), which no folder grant can ever reach.
--
--   principal_type 'org'  -> grants EVERY member (principal_id = org id).
--   principal_type 'user' -> grants one member (principal_id = user id).
--
-- Default posture is "Open": every workspace that has a vault gets an org-wide
-- edit grant, so members can read/write shared content the moment they join.
-- Owners narrow it in the Access panel (Read-only = flip to 'view'; Private =
-- delete the grant and fall back to explicit folder/file shares) or with locks
-- (a lock still caps a granted member at view; a grant never beats a lock).

ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_resource_type_check;
ALTER TABLE shares
  ADD CONSTRAINT shares_resource_type_check
  CHECK (resource_type IN ('folder', 'file', 'workspace'));

-- Backfill: every existing workspace that already has a vault becomes Open, so
-- members who joined before this migration gain access immediately.
INSERT INTO shares
  (id, workspace_id, resource_type, resource_id, principal_type, principal_id, permission, created_by)
SELECT gen_random_uuid()::text, o.id, 'workspace', o.id, 'org', o.id, 'edit', NULL
  FROM organization o
 WHERE EXISTS (SELECT 1 FROM vaults v WHERE v.organization_id = o.id)
ON CONFLICT (resource_type, resource_id, principal_type, principal_id) DO NOTHING;
