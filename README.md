# DSX Control Plane

DSX Control Plane is the operational SaaS platform for DSX POS. It separates customer/business workflows from infrastructure orchestration and is being built to support automated trials, provisioning, subscription operations, monitoring, backups, releases, and eventually a controlled exit from CloudPepper.

## Current architecture

- **DSX Control Plane** — SaaS operational source of truth.
- **Management Odoo** — CRM, invoices, accounting, payments and business follow-up.
- **Customer Odoo** — isolated DSX POS database per tenant.
- **DSX Node Agent** — outbound-only HTTPS agent for node telemetry and later typed operations.

Permanent target: Next.js/React + FastAPI + PostgreSQL + Redis/worker on a dedicated DSX management server behind Cloudflare.

For early Phase 1 development, a temporary Cloudflare Worker + D1 adapter is used so the Node Agent contract can be proven before the management VPS is introduced.

## Phase 1 status

The first end-to-end non-production node test is working:

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

Remaining before the Phase 1 deployment gate closes:

- revoke the test node and prove its existing credential can no longer heartbeat
- verify audit events
- repeat the flow on one real non-production Linux server

## Repository layout

- `apps/api/` — permanent FastAPI control service foundation
- `services/node_agent/` — DSX Node Agent
- `deploy/cloudflare/` — temporary Worker + D1 adapter
- `deploy/node-agent/` — hardened systemd deployment files
- `docs/` — architecture, data model, API contract, roadmap, project rules, decisions
- `tests/` — Python tests

## Safety boundaries

Phase 1 is intentionally read-only from the node-management perspective. There is no arbitrary remote shell endpoint and no production database create/delete, restart, deploy, backup, restore, billing, or subscription enforcement operation in this gate.

Secrets such as Cloudflare tokens, admin tokens, enrollment tokens, and Agent credentials must never be committed or pasted into issues/chat.

## Project direction

The implementation sequence is intentionally fixed:

1. architecture/docs
2. Control Plane + first test node
3. node management/inventory
4. provisioning
5. backup/restore
6. trial automation
7. subscription/billing integration
8. customer portal
9. release management
10. gradual CloudPepper exit

See `docs/ROADMAP.md` for the phase gates and `docs/ARCHITECTURE.md` for the detailed system design.
