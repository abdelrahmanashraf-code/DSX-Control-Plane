# Temporary Cloudflare Control Adapter

This directory hosts the temporary DSX Phase 1 control adapter. It is intentionally thin: node enrollment, authenticated heartbeats, node listing/revocation, and audit persistence only. Business billing, tenant provisioning, and arbitrary remote command execution do not belong here.

## Architecture

Cloudflare Worker -> Hyperdrive -> PostgreSQL

The Node Agent only makes outbound HTTPS requests to the Worker. No inbound management port is required on a node for Phase 1.

## Prerequisites

- Cloudflare account with Workers and Hyperdrive available.
- A PostgreSQL database reachable by Cloudflare Hyperdrive.
- Node.js/npm and Wrangler on the deployment workstation.
- `psql` or another PostgreSQL client for applying migrations.

## 1. Prepare PostgreSQL

Create an empty DSX Control Plane database, then apply:

```bash
psql "$DATABASE_URL" -f migrations/0001_phase1_nodes.sql
```

Do not use a customer Odoo database for Control Plane state.

## 2. Install Worker dependencies

```bash
cd deploy/cloudflare
npm install
```

## 3. Create Hyperdrive

```bash
npx wrangler hyperdrive create dsx-control-plane \
  --connection-string="$DATABASE_URL"
```

Copy the returned Hyperdrive ID into `wrangler.jsonc` in place of `REPLACE_WITH_HYPERDRIVE_ID`.

## 4. Configure admin secret

Generate a long random value locally and store it only as a Cloudflare Worker secret:

```bash
npx wrangler secret put ADMIN_API_TOKEN
```

Never commit the admin token, database password, enrollment tokens, or node agent credentials.

## 5. Validate and deploy

```bash
npm run typecheck
npm run deploy
```

Verify:

```bash
curl https://<worker-host>/healthz
```

Expected response contains `"status":"ok"`.

## 6. Create a one-time node enrollment token

```bash
curl -X POST https://<worker-host>/v1/admin/enrollment-tokens \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"node_name":"DSX-TEST-01","ttl_minutes":15}'
```

The returned enrollment token is one-time and short-lived. Supply it to the test node through a secure channel, use it once, then remove it from the node environment.

## Security boundaries

- No generic shell/command endpoint exists.
- Enrollment tokens are stored only as SHA-256 hashes and are one-use.
- Agent credentials are returned once and stored only as hashes in PostgreSQL.
- Revoking one node does not affect other nodes.
- Heartbeats expose operational metrics only; no passwords, configuration files, environment dumps, or database credentials are collected.
- Admin actions create audit events.

## Exit path

This Worker is a temporary adapter. The HTTP contract used by Node Agents must remain stable when the main FastAPI Control Plane later moves to the dedicated DSX management server behind Cloudflare.
