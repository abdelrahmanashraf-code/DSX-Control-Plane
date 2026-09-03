PRAGMA foreign_keys = ON;

ALTER TABLE provisioning_jobs
  ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (origin_kind IN ('provisioning', 'restore'));

CREATE TRIGGER IF NOT EXISTS trg_restore_materialize_cleanup_identity
AFTER UPDATE OF state ON restore_jobs
WHEN NEW.state = 'validated' AND OLD.state <> 'validated'
BEGIN
  INSERT OR IGNORE INTO provisioning_jobs
    (id, tenant_id, template_id, node_id, pool, state, idempotency_key, attempt,
     error_code, created_at, updated_at, started_at, finished_at, origin_kind)
  VALUES
    (NEW.id, NEW.target_tenant_id, NEW.template_id, NEW.node_id, 'non-production', 'ready',
     'restore:' || NEW.id, 1, NULL,
     COALESCE(NEW.started_at, NEW.created_at), NEW.updated_at,
     COALESCE(NEW.started_at, NEW.created_at), COALESCE(NEW.finished_at, NEW.updated_at),
     'restore');

  INSERT OR IGNORE INTO provisioning_job_events
    (id, job_id, event_type, from_state, to_state, payload, created_at)
  VALUES
    ('restore-materialization-event-' || NEW.id,
     NEW.id,
     'restore.materialized',
     NULL,
     'ready',
     json_object('backup_job_id', NEW.backup_job_id, 'origin_kind', 'restore'),
     COALESCE(NEW.validated_at, NEW.updated_at));
END;
