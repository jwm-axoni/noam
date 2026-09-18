-- Context by Keystone · OAuth 2.1 / OIDC provider tables for the Better Auth
-- `mcp` plugin, so AI clients (e.g. a Claude custom connector) can connect to
-- POST /api/mcp via the standard MCP OAuth flow — sign in against an EXISTING
-- account, consent, get an access token — instead of pasting an mcp_ token.
--
-- The three oauth* tables are the plugin's model names verbatim (camelCase,
-- quoted). Better Auth's Kysely adapter queries them quoted, so the casing must
-- match exactly — do NOT lowercase them. FKs mirror plugins/oidc-provider/schema.

create table "oauthApplication" (
  "id"           text        not null primary key,
  "name"         text        not null,
  "icon"         text,
  "metadata"     text,
  "clientId"     text        not null unique,
  "clientSecret" text,
  "redirectUrls" text        not null,
  "type"         text        not null,
  "disabled"     boolean     not null default false,
  "userId"       text        references "user" ("id") on delete cascade,
  "createdAt"    timestamptz not null default CURRENT_TIMESTAMP,
  "updatedAt"    timestamptz not null default CURRENT_TIMESTAMP
);

create table "oauthAccessToken" (
  "id"                    text        not null primary key,
  "accessToken"           text        not null unique,
  "refreshToken"          text        not null unique,
  "accessTokenExpiresAt"  timestamptz not null,
  "refreshTokenExpiresAt" timestamptz not null,
  "clientId"              text        not null references "oauthApplication" ("clientId") on delete cascade,
  "userId"                text        references "user" ("id") on delete cascade,
  "scopes"                text        not null,
  "createdAt"             timestamptz not null default CURRENT_TIMESTAMP,
  "updatedAt"             timestamptz not null default CURRENT_TIMESTAMP
);

create table "oauthConsent" (
  "id"           text        not null primary key,
  "clientId"     text        not null references "oauthApplication" ("clientId") on delete cascade,
  "userId"       text        not null references "user" ("id") on delete cascade,
  "scopes"       text        not null,
  "consentGiven" boolean     not null,
  "createdAt"    timestamptz not null default CURRENT_TIMESTAMP,
  "updatedAt"    timestamptz not null default CURRENT_TIMESTAMP
);

create index "oauthApplication_userId_idx"  on "oauthApplication" ("userId");
create index "oauthAccessToken_clientId_idx" on "oauthAccessToken" ("clientId");
create index "oauthAccessToken_userId_idx"   on "oauthAccessToken" ("userId");
create index "oauthConsent_clientId_idx"     on "oauthConsent" ("clientId");
create index "oauthConsent_userId_idx"       on "oauthConsent" ("userId");

-- Binds an OAuth connection to the workspace the user picked on the consent
-- screen. OAuth identifies the *user*; this row says which of their workspaces
-- the MCP tools operate within — the exact same (user, org) scope a minted
-- mcp_ token carries. Keyed per (client, user): each connector registers its
-- own client, so re-adding a connector can target a different workspace.
create table mcp_oauth_workspace (
  client_id       text        not null references "oauthApplication" ("clientId") on delete cascade,
  user_id         text        not null references "user" ("id") on delete cascade,
  organization_id text        not null references "organization" ("id") on delete cascade,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (client_id, user_id)
);
create index mcp_oauth_workspace_user_idx on mcp_oauth_workspace (user_id);
