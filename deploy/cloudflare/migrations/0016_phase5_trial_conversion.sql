PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS trial_conversion_requests (
  id TEXT PRIMARY KEY,
  trial_tenant_id TEXT NOT NULL REFERENCES tenants(id),
  request_key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('clean_production', 'promote_trial_data')),
  state TEXT NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'approved', 'provisioning', 'ready', 'failed', 'cancelled')),
  target_tenant_id TEXT NULL REFERENCES tenants(id),
  promotion_confirmed_at TEXT NULL,
  error_code TEXT NULL CHECK (error_code IS NULL OR length(error_code) <= 120),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_trial_conversion_trial_created
  ON trial_conversion_requests(trial_tenant_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_trial_conversion_state_created
  ON trial_conversion_requests(state, requested_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_conversion_one_active
  ON trial_conversion_requests(trial_tenant_id)
  WHERE state IN ('requested', 'approved', 'provisioning', 'ready');
