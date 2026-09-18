-- Track who created a folder, mirroring notes.created_by.
--
-- Needed for private-by-default sharing: a member sees a folder/note they
-- created even without an explicit share, so the permission resolver must know
-- the creator. (Notes already carried created_by since migration 002.)

ALTER TABLE folders
  ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES "user" (id) ON DELETE SET NULL;
