PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS restore_operation_leases (
  restore_job_id TEXT PRIMARY KEY REFERENCES restore_jobs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  lease_token_hash TEXT NOT NULL CHECK (length(lease_token_hash) = 64),
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_restore_operation_leases_node_expires
  ON restore_operation_leases(node_id, lease_expires_at);
