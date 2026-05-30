-- Maps HubSpot deal IDs to Pylon project IDs so both sides can reference each other
CREATE TABLE IF NOT EXISTS deal_project_links (
  id              SERIAL PRIMARY KEY,
  hubspot_deal_id TEXT UNIQUE NOT NULL,
  pylon_project_id TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at  TIMESTAMPTZ DEFAULT NOW()
);

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
