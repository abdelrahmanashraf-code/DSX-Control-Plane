CREATE TABLE IF NOT EXISTS node_health_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL,
    sampled_at TEXT NOT NULL,
    cpu_percent REAL,
    memory_percent REAL,
    disk_percent REAL,
    odoo_running INTEGER,
    postgresql_running INTEGER,
    database_count INTEGER,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_node_health_samples_node_time
    ON node_health_samples (node_id, sampled_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_nodes_sample_health_after_heartbeat
AFTER UPDATE OF last_seen_at ON nodes
WHEN NEW.last_seen_at IS NOT NULL
 AND (OLD.last_seen_at IS NULL OR NEW.last_seen_at <> OLD.last_seen_at)
 AND NOT EXISTS (
     SELECT 1
       FROM node_health_samples
      WHERE node_id = NEW.id
        AND julianday(sampled_at) >= julianday(NEW.last_seen_at) - (5.0 / 1440.0)
 )
BEGIN
    INSERT INTO node_health_samples (
        node_id,
        sampled_at,
        cpu_percent,
        memory_percent,
        disk_percent,
        odoo_running,
        postgresql_running,
        database_count
    )
    VALUES (
        NEW.id,
        NEW.last_seen_at,
        CAST(json_extract(NEW.metrics, '$.cpu_percent') AS REAL),
        CAST(json_extract(NEW.metrics, '$.memory_percent') AS REAL),
        CAST(json_extract(NEW.metrics, '$.disk_percent') AS REAL),
        CAST(json_extract(NEW.metrics, '$.services.odoo.running') AS INTEGER),
        CAST(json_extract(NEW.metrics, '$.services.postgresql.running') AS INTEGER),
        CAST(json_extract(NEW.metrics, '$.runtime_inventory.database_inventory.database_count') AS INTEGER)
    );

    DELETE FROM node_health_samples
     WHERE node_id = NEW.id
       AND julianday(sampled_at) < julianday(NEW.last_seen_at) - 7.0;
END;
