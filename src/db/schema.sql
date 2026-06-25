-- Maps HubSpot deals to Pylon projects so both sides can reference each other.
-- A deal can have MULTIPLE accounts (properties), each its own Pylon project — so the link is
-- per (deal, account). The PRIMARY account's project is the "anchor" that drives the deal stage
-- on the reverse flow; secondary projects only leave summary notes. Legacy/contact-based rows
-- have hubspot_account_id = NULL and is_primary = TRUE.
CREATE TABLE IF NOT EXISTS deal_project_links (
  id                 SERIAL PRIMARY KEY,
  hubspot_deal_id    TEXT NOT NULL,
  hubspot_account_id TEXT,
  pylon_project_id   TEXT NOT NULL,
  is_primary         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Migrate an existing 1:1 table to the per-account shape (idempotent — safe to re-run).
ALTER TABLE deal_project_links ADD COLUMN IF NOT EXISTS hubspot_account_id TEXT;
ALTER TABLE deal_project_links ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT TRUE;
-- The old inline `hubspot_deal_id TEXT UNIQUE` made a one-project-per-deal constraint; drop it.
ALTER TABLE deal_project_links DROP CONSTRAINT IF EXISTS deal_project_links_hubspot_deal_id_key;
-- New uniqueness: one project per (deal, account). COALESCE so a deal's legacy NULL-account row
-- occupies a single slot rather than allowing unlimited NULL duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_deal_project_account
  ON deal_project_links (hubspot_deal_id, COALESCE(hubspot_account_id, ''));

-- Full audit log of every event processed — essential for debugging at volume
CREATE TABLE IF NOT EXISTS sync_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        TEXT UNIQUE,          -- idempotency key (HS eventId or Pylon event id)
  direction       TEXT NOT NULL,        -- 'hs_to_pylon' | 'pylon_to_hs'
  event_type      TEXT NOT NULL,
  hubspot_deal_id TEXT,
  pylon_project_id TEXT,
  status          TEXT NOT NULL DEFAULT 'queued',  -- queued | success | failed | dead | duplicate
  error_message   TEXT,
  retries         INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deal_project_links_deal_id    ON deal_project_links(hubspot_deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_project_links_project_id ON deal_project_links(pylon_project_id);
CREATE INDEX IF NOT EXISTS idx_sync_events_event_id          ON sync_events(event_id);
CREATE INDEX IF NOT EXISTS idx_sync_events_status            ON sync_events(status);
