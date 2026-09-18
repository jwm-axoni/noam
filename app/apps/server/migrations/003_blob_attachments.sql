-- Context by Keystone · attachment blob store (spec 02 §2 vault attachments/,
-- §5A blobs). The blobs table (002) already has the binary column (`data`),
-- sha256, size, mime, workspace_id and the reserved `storage_url`. Attachments
-- are addressed per *vault* and mirror an on-disk path, so we add:
--   vault_id  — the vault the attachment belongs to (dedupe scope)
--   filename  — original file name (display / download hint)
--   rel_path  — vault-relative path (e.g. "attachments/img.png") the client
--               writes the bytes back to
-- Dedupe is per vault by content hash: at most one row per (vault_id, sha256).

ALTER TABLE blobs ADD COLUMN IF NOT EXISTS vault_id TEXT REFERENCES vaults (id) ON DELETE CASCADE;
ALTER TABLE blobs ADD COLUMN IF NOT EXISTS filename TEXT;
ALTER TABLE blobs ADD COLUMN IF NOT EXISTS rel_path TEXT;

CREATE INDEX IF NOT EXISTS blobs_vault_idx ON blobs (vault_id);
-- One stored copy per identical content within a vault (dedupe key).
CREATE UNIQUE INDEX IF NOT EXISTS blobs_vault_sha_idx ON blobs (vault_id, sha256);
