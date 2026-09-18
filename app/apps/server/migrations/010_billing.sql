-- Subscription billing (per-workspace Pro plan).
--
-- OUR Postgres is the single source of truth for entitlements. The
-- `subscriptions` table is written ONLY by webhook processing (and cleared by
-- org-delete cascade) — the request path NEVER calls the payment provider to
-- answer "is this org paid". `billing_events` gives webhook idempotency.
--
-- Billing is provider-agnostic behind src/billing/provider.ts; the shipped
-- adapter is Polar (provider = 'polar'). When no provider token is configured
-- the whole feature is off and no limits are enforced (self-host = unlimited),
-- so these tables simply stay empty.

-- ── One subscription row per workspace (org). Absent row ⇒ free plan. ───────
CREATE TABLE subscriptions (
  organization_id         TEXT PRIMARY KEY REFERENCES organization (id) ON DELETE CASCADE,
  provider                TEXT NOT NULL DEFAULT 'polar',
  provider_customer_id    TEXT,
  provider_subscription_id TEXT,
  plan                    TEXT NOT NULL,
  status                  TEXT NOT NULL,
  current_period_end      TIMESTAMPTZ,
  cancel_at_period_end    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Provider event time of the write that last touched this row. Webhooks are
  -- not delivery-ordered (a retry of an earlier event can arrive after a later
  -- one), so the webhook upsert only applies when the incoming event is at
  -- least this new — a stale redelivery can't clobber newer state.
  event_ts                TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Webhook idempotency: one row per processed provider event id ────────────
CREATE TABLE billing_events (
  id           TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
