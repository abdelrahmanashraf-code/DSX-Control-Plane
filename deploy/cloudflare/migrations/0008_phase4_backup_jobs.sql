PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS backup_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provisioning_job_id TEXT NOT NULL REFERENCES provisioning_jobs(id),
  template_id TEXT NOT NULL REFERENCES provisioning_templates(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  database_name TEXT NOT NULL CHECK (length(database_name) BETWEEN 3 AND 63),
  environment_kind TEXT NOT NULL CHECK (environment_kind IN ('test', 'trial', 'production')),
  backup_type TEXT NOT NULL CHECK (backup_type IN ('full')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'dispatched', 'running', 'prepared', 'uploaded', 'verified', 'failed')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  error_code TEXT NULL CHECK (error_code IS NULL OR length(error_code) <= 120),
  total_size_bytes INTEGER NULL CHECK (total_size_bytes IS NULL OR total_size_bytes >= 0),
  manifest_sha256 TEXT NULL CHECK (manifest_sha256 IS NULL OR length(manifest_sha256) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT NULL,
  prepared_at TEXT NULL,
  uploaded_at TEXT NULL,
  verified_at TEXT NULL,
  finished_at TEXT NULL,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_backup_jobs_node_state_created
  ON backup_jobs(node_id, state, created_at);

CREATE INDEX IF NOT EXISTS idx_backup_jobs_tenant_created
  ON backup_jobs(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backup_job_events (
  id TEXT PRIMARY KEY,
  backup_job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (length(event_type) <= 120),
  from_state TEXT NULL,
  to_state TEXT NULL,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (length(payload) <= 4096),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_job_events_job_created
  ON backup_job_events(backup_job_id, created_at);

CREATE TABLE IF NOT EXISTS backup_artifacts (
  id TEXT PRIMARY KEY,
  backup_job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('database_dump', 'filestore_archive', 'manifest')),
  object_key TEXT NULL CHECK (object_key IS NULL OR length(object_key) <= 1024),
  object_version TEXT NULL CHECK (object_version IS NULL OR length(object_version) <= 256),
  size_bytes INTEGER NULL CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256 TEXT NULL CHECK (sha256 IS NULL OR length(sha256) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (backup_job_id, artifact_kind)
);

CREATE INDEX IF NOT EXISTS idx_backup_artifacts_job_kind
  ON backup_artifacts(backup_job_id, artifact_kind);
