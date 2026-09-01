# DSX Node Agent API v1

Phase 1 exposes a deliberately small, typed HTTP contract between the DSX Control Plane and each Node Agent.

## Safety boundary

- Node Agents initiate outbound HTTPS only.
- There is no inbound management port on a node.
- No arbitrary shell execution exists in v1.
- No database create/delete, restart, deploy, backup, restore, billing, or subscription enforcement exists in this phase.

## Admin authentication

Admin endpoints require:

```http
Authorization: Bearer <ADMIN_API_TOKEN>
```

The token is stored as a Cloudflare Worker secret and must never be committed.

## Create enrollment token

`POST /v1/admin/enrollment-tokens`

Example body:

```json
{
  "node_name": "DSX-TEST-01",
  "ttl_minutes": 15
}
```

The returned enrollment token is short-lived, one-time, and shown once.

## Enroll node

`POST /v1/nodes/enroll`

The agent sends its one-time enrollment token, node name, hostname, and agent version. A successful response returns a `node_id` and long-lived `agent_token`. The raw agent token is shown once; the Control Plane stores only its SHA-256 hash.

## Heartbeat

`POST /v1/nodes/{node_id}/heartbeat`

The Agent authenticates with:

```http
Authorization: Bearer <agent_token>
```

Payload includes observed time, hostname, agent version, and read-only node metrics. The current collector reports CPU, RAM, disk, OS, boot time, and basic Odoo/PostgreSQL running state.

Effective state is derived from the last accepted heartbeat:

- `online`: within the configured stale threshold.
- `stale`: older than the stale threshold but within the offline threshold.
- `offline`: older than the offline threshold.
- `revoked`: node credential was administratively revoked.

## List nodes

`GET /v1/admin/nodes`

Returns known nodes, latest metrics, lifecycle state, timestamps, and effective online/stale/offline/revoked status.

## Revoke node

`POST /v1/admin/nodes/{node_id}/revoke`

Revocation changes the lifecycle state to `revoked`. Future heartbeats using that node credential are rejected with `401` and `invalid_or_revoked_agent`.

## Audit events

`GET /v1/admin/audit-events`

Returns the most recent Phase 1 control events, including enrollment-token creation, node enrollment, and node revocation. This endpoint exists so the deployment gate can prove that privileged lifecycle operations are auditable.
