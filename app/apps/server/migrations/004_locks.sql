-- Locks (RBAC hardening, spec 04 §3 extension).
--
-- A lock is a `shares` row with permission = 'locked'. It is a DENY overlay on
-- top of the allow-list ACL: wherever a lock matches (the file itself or any
-- ancestor folder), the effective permission is capped at 'view' — including
-- for workspace owners/admins, so a locked spec can't be edited by accident.
-- Owners/admins can still manage (unlock) via the shares API.
--
-- principal_type 'user' locks one member; 'org' locks everyone in the
-- workspace (principal_id = organization id).

ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_principal_type_check;
ALTER TABLE shares
  ADD CONSTRAINT shares_principal_type_check
  CHECK (principal_type IN ('user', 'org'));

ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_permission_check;
ALTER TABLE shares
  ADD CONSTRAINT shares_permission_check
  CHECK (permission IN ('view', 'edit', 'locked'));
