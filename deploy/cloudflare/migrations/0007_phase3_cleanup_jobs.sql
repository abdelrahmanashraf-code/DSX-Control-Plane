PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cleanup_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id),
  provisioning_job_id TEXT NOT NULL UNIQUE REFERENCES provisioning_jobs(id),
  template_id TEXT NOT NULL REFERENCES provisioning_templates(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  database_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'dispatched', 'running', 'cleaned', 'failed')),
  error_code TEXT NULL CHECK (error_code IS NULL OR length(error_code) <= 120),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_cleanup_jobs_node_state
  ON cleanup_jobs(node_id, state, created_at);

CREATE TABLE IF NOT EXISTS cleanup_job_events (
  id TEXT PRIMARY KEY,
  cleanup_job_id TEXT NOT NULL REFERENCES cleanup_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (length(event_type) <= 120),
  from_state TEXT NULL,
  to_state TEXT NULL,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (length(payload) <= 4096),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cleanup_job_events_job_created
  ON cleanup_job_events(cleanup_job_id, created_at);

CREATE TABLE IF NOT EXISTS cleanup_operation_leases (
  cleanup_job_id TEXT PRIMARY KEY REFERENCES cleanup_jobs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  lease_token_hash TEXT NOT NULL UNIQUE,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cleanup_operation_leases_node_expiry
  ON cleanup_operation_leases(node_id, lease_expires_at);
