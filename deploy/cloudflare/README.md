# Temporary Cloudflare Control Adapter

This directory hosts the temporary DSX Phase 1 control adapter. It is intentionally thin: node enrollment, authenticated heartbeats, node listing/revocation, and audit persistence only. Business billing, tenant provisioning, and arbitrary remote command execution do not belong here.

## Architecture

Cloudflare Worker -> D1

The Node Agent only makes outbound HTTPS requests to the Worker. No inbound management port is required on a node for Phase 1.

D1 is temporary development storage. The permanent target remains the dedicated DSX management server with FastAPI + PostgreSQL behind Cloudflare.

## 1. Create the D1 database

Create one Cloudflare D1 database named:

```text
dsx-control-plane-dev
```

Copy its Database ID into `wrangler.jsonc` in place of `REPLACE_WITH_D1_DATABASE_ID`.

## 2. Install dependencies

```bash
cd deploy/cloudflare
npm install
```

## 3. Configure the admin secret

Generate a long random value locally and store it only as a Cloudflare Worker secret:

```bash
npx wrangler secret put ADMIN_API_TOKEN
```

Never commit the admin token, enrollment tokens, or node agent credentials.

## 4. Validate and deploy

```bash
npm run typecheck
npm run deploy
```

`npm run deploy` automatically applies the idempotent Phase 1 D1 schema before deploying the Worker. The schema creates only:

- `node_enrollment_tokens`
- `nodes`
- `audit_events`

No customer database is touched.

Verify:

```bash
curl https://<worker-host>/healthz
```

Expected response contains:

```json
{"status":"ok","service":"dsx-control-plane-edge","storage":"d1"}
```

## 5. Create a one-time node enrollment token

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
- Agent credentials are returned once and stored only as hashes in D1.
- Revoking one node does not affect other nodes.
- Heartbeats expose operational metrics only; no passwords, configuration files, environment dumps, or database credentials are collected.
- Admin actions create audit events.

## Exit path

This Worker and D1 are temporary adapters. The HTTP contract used by Node Agents must remain stable when the main FastAPI Control Plane later moves to the dedicated DSX management server behind Cloudflare with PostgreSQL persistence.
