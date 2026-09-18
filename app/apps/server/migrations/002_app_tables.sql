-- Context by Keystone · application tables (spec 02 §5, 04 §2/§3)
-- Depends on Better Auth core tables (001): "user", organization, member.
--
-- NOTE (deviation from spec sketch): ids are TEXT, not UUID. Better Auth emits
-- TEXT ids for user/organization; keeping every id TEXT lets shares.resource_id
-- reference either a folder or a file without a type-tagged UUID cast, and lets
-- the client supply its own stable doc_ids (which are UUID *strings*). The
-- binary Yjs stores and the join-by-doc_id contract are unchanged.

-- ── Binary Yjs document store (spec 02 §5A) ────────────────────────────────
CREATE TABLE doc_updates (
  id         BIGSERIAL PRIMARY KEY,
  doc_id     TEXT NOT NULL,
  seq        BIGINT,
  update     BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX doc_updates_doc_id_idx ON doc_updates (doc_id, id);

CREATE TABLE doc_snapshots (
  doc_id       TEXT PRIMARY KEY,
  snapshot     BYTEA,
  state_vector BYTEA,
  seq          BIGINT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- attachments — BYTEA storage for MVP (S3/R2 later; storage_url reserved)
CREATE TABLE blobs (
  id           TEXT PRIMARY KEY,
  doc_id       TEXT,
  workspace_id TEXT,
  sha256       TEXT,
  size         BIGINT,
  mime         TEXT,
  data         BYTEA,
  storage_url  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Vault registry (spec 02 §5B) ───────────────────────────────────────────
CREATE TABLE vaults (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX vaults_org_idx ON vaults (organization_id);

CREATE TABLE folders (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES folders (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX folders_vault_idx ON folders (vault_id);
CREATE INDEX folders_parent_idx ON folders (parent_id);

-- notes: rich per-note registry. id == doc_id (join key to the Yjs stores).
CREATE TABLE notes (
  id         TEXT PRIMARY KEY,          -- == doc_id
  vault_id   TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  folder_id  TEXT REFERENCES folders (id) ON DELETE SET NULL,
  title      TEXT,
  rel_path   TEXT NOT NULL,             -- mirrors on-disk path (mutable)
  doc_id     TEXT NOT NULL,             -- == id; explicit per spec
  created_by TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX notes_vault_idx ON notes (vault_id);
CREATE INDEX notes_folder_idx ON notes (folder_id);

-- files: minimal vault-file <-> CRDT-doc mapping. id PK == doc_id.
CREATE TABLE files (
  id         TEXT PRIMARY KEY,          -- == doc_id
  vault_id   TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  folder_id  TEXT REFERENCES folders (id) ON DELETE SET NULL,
  path       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX files_vault_idx ON files (vault_id);
CREATE INDEX files_folder_idx ON files (folder_id);

-- ── Per-resource ACL (spec 04 §3) ──────────────────────────────────────────
CREATE TABLE shares (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  resource_type  TEXT NOT NULL CHECK (resource_type IN ('folder', 'file')),
  resource_id    TEXT NOT NULL,
  principal_type TEXT NOT NULL DEFAULT 'user' CHECK (principal_type IN ('user')),
  principal_id   TEXT NOT NULL,
  permission     TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
  created_by     TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resource_type, resource_id, principal_type, principal_id)
);
CREATE INDEX shares_principal_idx ON shares (principal_type, principal_id);
CREATE INDEX shares_resource_idx ON shares (resource_type, resource_id);
