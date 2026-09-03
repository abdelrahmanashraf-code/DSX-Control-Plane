PRAGMA foreign_keys = ON;

ALTER TABLE tenants ADD COLUMN trial_state TEXT NULL
  CHECK (trial_state IS NULL OR trial_state IN ('requested', 'provisioning', 'active', 'expired', 'cleanup_pending', 'cleaned', 'failed'));
ALTER TABLE tenants ADD COLUMN trial_request_key TEXT NULL;
ALTER TABLE tenants ADD COLUMN trial_requested_at TEXT NULL;
ALTER TABLE tenants ADD COLUMN trial_started_at TEXT NULL;
ALTER TABLE tenants ADD COLUMN trial_expires_at TEXT NULL;
ALTER TABLE tenants ADD COLUMN public_hostname TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_trial_request_key
  ON tenants(trial_request_key)
  WHERE trial_request_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tenants_trial_state_expires
  ON tenants(trial_state, trial_expires_at)
  WHERE environment_kind = 'trial';

UPDATE tenants
   SET trial_state = CASE status
       WHEN 'ready' THEN 'active'
       WHEN 'failed' THEN 'failed'
       WHEN 'decommissioned' THEN 'cleaned'
       ELSE 'provisioning'
     END,
       trial_requested_at = COALESCE(trial_requested_at, created_at),
       trial_started_at = CASE
         WHEN status = 'ready' THEN COALESCE(trial_started_at, updated_at)
         ELSE trial_started_at
       END,
       trial_expires_at = CASE
         WHEN status = 'ready' THEN COALESCE(trial_expires_at, datetime(updated_at, '+3 days'))
         ELSE trial_expires_at
       END
 WHERE environment_kind = 'trial'
   AND trial_state IS NULL;
