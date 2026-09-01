BEGIN;

CREATE TABLE IF NOT EXISTS node_enrollment_tokens (
    id UUID PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    requested_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_by TEXT NOT NULL DEFAULT 'admin-api'
);

CREATE INDEX IF NOT EXISTS idx_node_enrollment_tokens_expires_at
    ON node_enrollment_tokens (expires_at);

CREATE TABLE IF NOT EXISTS nodes (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    agent_version TEXT NOT NULL,
    agent_token_hash TEXT NOT NULL UNIQUE,
    lifecycle_state TEXT NOT NULL DEFAULT 'active'
        CHECK (lifecycle_state IN ('active', 'revoked')),
    last_seen_at TIMESTAMPTZ,
    last_observed_at TIMESTAMPTZ,
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_nodes_last_seen_at ON nodes (last_seen_at);
CREATE INDEX IF NOT EXISTS idx_nodes_lifecycle_state ON nodes (lifecycle_state);

CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY,
    event_type TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    target_type TEXT NOT NULL,
    target_id TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_target ON audit_events (target_type, target_id);

COMMIT;
