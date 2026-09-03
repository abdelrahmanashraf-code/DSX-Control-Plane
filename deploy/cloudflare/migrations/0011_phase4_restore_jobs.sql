PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS restore_jobs (
  id TEXT PRIMARY KEY,
  backup_job_id TEXT NOT NULL REFERENCES backup_jobs(id),
  source_tenant_id TEXT NOT NULL REFERENCES tenants(id),
  target_tenant_id TEXT NOT NULL REFERENCES tenants(id),
  template_id TEXT NOT NULL REFERENCES provisioning_templates(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  source_database_name TEXT NOT NULL CHECK (length(source_database_name) BETWEEN 3 AND 63),
  target_database_name TEXT NOT NULL UNIQUE CHECK (length(target_database_name) BETWEEN 3 AND 63),
  environment_kind TEXT NOT NULL CHECK (environment_kind IN ('test', 'trial', 'production')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'dispatched', 'running', 'restored', 'validated', 'failed')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt <= 100),
  error_code TEXT NULL CHECK (error_code IS NULL OR length(error_code) <= 120),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT NULL,
  restored_at TEXT NULL,
  validated_at TEXT NULL,
  finished_at TEXT NULL,
  UNIQUE (target_tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_restore_jobs_node_state_created
  ON restore_jobs(node_id, state, created_at);

CREATE INDEX IF NOT EXISTS idx_restore_jobs_target_created
  ON restore_jobs(target_tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS restore_job_events (
  id TEXT PRIMARY KEY,
  restore_job_id TEXT NOT NULL REFERENCES restore_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (length(event_type) <= 120),
  from_state TEXT NULL,
  to_state TEXT NULL,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (length(payload) <= 4096),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_restore_job_events_job_created
  ON restore_job_events(restore_job_id, created_at);
