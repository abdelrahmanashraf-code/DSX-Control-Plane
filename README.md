# DSX Control Plane

DSX Control Plane is the operational SaaS platform for DSX POS. It separates customer/business workflows from infrastructure orchestration and is being built to support automated trials, provisioning, subscription operations, monitoring, backups, releases, and eventually a controlled exit from CloudPepper.

## Current architecture

- **DSX Control Plane** — SaaS operational source of truth.
- **Management Odoo** — CRM, invoices, accounting, payments and business follow-up.
- **Customer Odoo** — isolated DSX POS database per tenant.
- **DSX Node Agent** — outbound-only HTTPS agent for node telemetry and later typed operations.

Permanent target: Next.js/React + FastAPI + PostgreSQL + Redis/worker on a dedicated DSX management server behind Cloudflare.

For early development, a temporary Cloudflare Worker + D1 adapter is used so the Node Agent contract can be proven before the management VPS is introduced.

## Phase 1 status — COMPLETE

The complete non-production acceptance flow is proven on both the local test machine and a real Ubuntu 24.04 non-production server:

- Cloudflare Worker + D1 live
- admin API authentication working
- one-time enrollment working
- per-node credential stored locally
- authenticated heartbeat accepted
- CPU/RAM/disk/OS metrics visible
- Odoo/PostgreSQL running state visible
- continuous online heartbeat verified
- online -> stale -> offline detection verified
- offline -> online recovery verified
- node revocation rejects the old Agent credential with HTTP 401
- audit events verified for token creation, enrollment and revocation
- real non-production server gate passed

## Phase 2 status — COMPLETE

Node management, read-only inventory, health history and operational alerting are validated on the real non-production node.

Verified capabilities:

- node roles, pools, labels and placement capacity metadata
- authenticated node metadata update with audit logging
- read-only Odoo/PostgreSQL process discovery
- fixed local version probes without shell execution
- cached read-only PostgreSQL database inventory with database names and sizes only
- real PostgreSQL inventory validated with 13 databases on PostgreSQL 16.15
- bounded outputs and sanitized failure codes
- no passwords, DSNs, config contents, environment dumps or raw PostgreSQL stderr returned
- five-minute health-history sampling with seven-day retention
- healthy, stale and offline operational alert states validated
- offline -> online recovery validated
- final real-node credential revocation validated; old heartbeat rejected with HTTP 401
- Python/Ruff/Pytest and Cloudflare unit/typecheck/migration CI coverage green

The Phase 1 deployment gate and the Phase 2 node-management gate are closed. The test credential used for acceptance was intentionally revoked at the end of the gate.

## Current phase — Phase 3: Provisioning

The next goal is to create a new isolated customer Odoo database automatically from a controlled DSX template.

Phase 3 will introduce only bounded, typed provisioning operations. It will not introduce arbitrary remote shell access.

## Repository layout

- `apps/api/` — permanent FastAPI control service foundation
- `services/node_agent/` — DSX Node Agent
- `deploy/cloudflare/` — temporary Worker + D1 adapter
- `deploy/node-agent/` — hardened systemd deployment files
- `docs/` — architecture, data model, API contract, roadmap, project rules, decisions
- `tests/` — Python tests

## Safety boundaries

There is no arbitrary remote shell endpoint. Phase 1 and Phase 2 inventory work does not create/delete customer databases, restart Odoo, deploy updates, or return secrets from nodes.

Provisioning work must remain typed, authenticated, audited, idempotent and restricted to explicit test resources until the Phase 3 gate passes.

Secrets such as Cloudflare tokens, admin tokens, enrollment tokens, Agent credentials, passwords and connection strings must never be committed or pasted into issues/chat.

## Project direction

The implementation sequence is intentionally fixed:

1. architecture/docs — complete
2. Control Plane + first test node — complete
3. node management/inventory — complete
4. provisioning — current
5. backup/restore
6. trial automation
7. subscription/billing integration
8. customer portal
9. release management
10. gradual CloudPepper exit

See `docs/ROADMAP.md` for the phase gates, `docs/ARCHITECTURE.md` for the detailed system design, and `docs/PHASE2_NODE_INVENTORY.md` for the inventory safety contract.
