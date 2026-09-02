PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS provisioning_templates (
  id TEXT PRIMARY KEY,
  sector TEXT NOT NULL UNIQUE CHECK (sector IN ('restaurant', 'cafe', 'retail', 'supermarket')),
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  odoo_major INTEGER NOT NULL DEFAULT 18 CHECK (odoo_major >= 18 AND odoo_major <= 30),
  required_role TEXT NOT NULL DEFAULT 'odoo-postgres' CHECK (required_role IN ('odoo-postgres')),
  min_memory_mb INTEGER NOT NULL DEFAULT 1024 CHECK (min_memory_mb >= 256 AND min_memory_mb <= 1048576),
  min_disk_gb INTEGER NOT NULL DEFAULT 10 CHECK (min_disk_gb >= 1 AND min_disk_gb <= 1048576),
  database_prefix TEXT NOT NULL,
  module_manifest TEXT NOT NULL DEFAULT '[]' CHECK (length(module_manifest) <= 8192),
  settings_manifest TEXT NOT NULL DEFAULT '{}' CHECK (length(settings_manifest) <= 8192),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  sector TEXT NOT NULL CHECK (sector IN ('restaurant', 'cafe', 'retail', 'supermarket')),
  environment_kind TEXT NOT NULL DEFAULT 'test' CHECK (environment_kind IN ('test', 'trial', 'production')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'provisioning', 'ready', 'failed', 'suspended', 'decommissioned')),
  assigned_node_id TEXT NULL REFERENCES nodes(id),
  database_name TEXT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenants_node_status
  ON tenants(assigned_node_id, status);

CREATE TABLE IF NOT EXISTS provisioning_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  template_id TEXT NOT NULL REFERENCES provisioning_templates(id),
  node_id TEXT NULL REFERENCES nodes(id),
  pool TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'placed', 'dispatched', 'running', 'ready', 'failed', 'retrying')),
  idempotency_key TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt <= 100),
  error_code TEXT NULL CHECK (error_code IS NULL OR length(error_code) <= 120),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_provisioning_jobs_state_created
  ON provisioning_jobs(state, created_at);

CREATE INDEX IF NOT EXISTS idx_provisioning_jobs_node_state
  ON provisioning_jobs(node_id, state);

CREATE TABLE IF NOT EXISTS provisioning_job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES provisioning_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (length(event_type) <= 120),
  from_state TEXT NULL,
  to_state TEXT NULL,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (length(payload) <= 4096),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provisioning_job_events_job_created
  ON provisioning_job_events(job_id, created_at);

INSERT OR IGNORE INTO provisioning_templates
  (id, sector, name, version, odoo_major, required_role, min_memory_mb, min_disk_gb,
   database_prefix, module_manifest, settings_manifest, active, created_at, updated_at)
VALUES
  ('template-restaurant-v1', 'restaurant', 'DSX Restaurant', 1, 18, 'odoo-postgres', 1024, 10, 'dsx_restaurant', '[]', '{}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('template-cafe-v1', 'cafe', 'DSX Cafe', 1, 18, 'odoo-postgres', 1024, 10, 'dsx_cafe', '[]', '{}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('template-retail-v1', 'retail', 'DSX Retail', 1, 18, 'odoo-postgres', 1024, 10, 'dsx_retail', '[]', '{}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('template-supermarket-v1', 'supermarket', 'DSX Supermarket', 1, 18, 'odoo-postgres', 1024, 10, 'dsx_supermarket', '[]', '{}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
