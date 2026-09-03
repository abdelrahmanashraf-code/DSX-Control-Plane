PRAGMA foreign_keys = ON;

ALTER TABLE tenants ADD COLUMN trial_expired_at TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_tenants_trial_expiration_scan
  ON tenants(environment_kind, trial_state, trial_expires_at)
  WHERE environment_kind = 'trial';
