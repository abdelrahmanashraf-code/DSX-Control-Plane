# DSX Node Agent API v1

Status: Phase 1 contract. Keep backward compatible when the Control Plane moves from the temporary Cloudflare adapter to the dedicated management server.

## Authentication model

Two credential classes exist and must never be interchangeable:

1. **Enrollment token** — one-time, short-lived, created by an authenticated Control Plane administrator. Stored server-side only as a SHA-256 hash.
2. **Agent token** — unique per enrolled node, returned once during enrollment. Stored server-side only as a SHA-256 hash and locally on the node in a mode-0600 identity file.

Revoking a node invalidates that node's agent credential only.

## POST `/v1/admin/enrollment-tokens`

Admin-authenticated. Creates a one-time enrollment token.

Request:

```json
{
  "node_name": "DSX-TEST-01",
  "ttl_minutes": 15
}
```

Response `201`:

```json
{
  "enrollment_token": "dsx_enroll_...",
  "expires_at": "2026-09-01T19:00:00Z",
  "node_name": "DSX-TEST-01"
}
```

## POST `/v1/nodes/enroll`

Public endpoint protected by the one-time enrollment token.

Request:

```json
{
  "enrollment_token": "dsx_enroll_...",
  "name": "DSX-TEST-01",
  "hostname": "dsx-test-01",
  "agent_version": "0.1.0"
}
```

Response `201`:

```json
{
  "node_id": "uuid",
  "agent_token": "dsx_agent_..."
}
```

The same enrollment token cannot be reused.

## POST `/v1/nodes/{node_id}/heartbeat`

Authentication: `Authorization: Bearer <agent_token>`.

Request:

```json
{
  "observed_at": "2026-09-01T18:30:00Z",
  "hostname": "dsx-test-01",
  "agent_version": "0.1.0",
  "metrics": {
    "cpu_percent": 22.5,
    "memory_percent": 48.1,
    "disk_percent": 31.2,
    "services": {
      "odoo": {"running": true},
      "postgresql": {"running": true}
    }
  }
}
```

Response `200`:

```json
{
  "status": "accepted",
  "server_time": "2026-09-01T18:30:01Z"
}
```

Revoked or invalid agents receive `401`.

## GET `/v1/admin/nodes`

Admin-authenticated. Lists observed nodes with effective runtime status:

- `never_seen`
- `online`
- `stale`
- `offline`
- `revoked`

Runtime status is derived from `last_seen_at`; it is not manually edited.

## POST `/v1/admin/nodes/{node_id}/revoke`

Admin-authenticated. Revokes only the selected node and writes an audit event.

## Explicit non-goals in v1

There is no generic command execution endpoint. v1 does not create databases, restart Odoo, access PostgreSQL credentials, deploy code, read customer data, perform backups, restore data, or delete tenants.
