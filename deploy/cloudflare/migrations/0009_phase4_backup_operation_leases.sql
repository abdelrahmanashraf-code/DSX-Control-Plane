PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS backup_operation_leases (
  backup_job_id TEXT PRIMARY KEY REFERENCES backup_jobs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  lease_token_hash TEXT NOT NULL UNIQUE,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_operation_leases_node_expiry
  ON backup_operation_leases(node_id, lease_expires_at);
