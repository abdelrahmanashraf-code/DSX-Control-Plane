# DSX Control Plane

DSX Control Plane is the operational SaaS platform for DSX POS. It separates customer/business workflows from infrastructure orchestration and is being built to support automated trials, provisioning, subscription operations, monitoring, backups, releases, and eventually a controlled exit from CloudPepper.

## Current architecture

- **DSX Control Plane** — SaaS operational source of truth.
- **Management Odoo** — CRM, invoices, accounting, payments and business follow-up.
- **Customer Odoo** — isolated DSX POS database per tenant.
- **DSX Node Agent** — outbound-only HTTPS agent for node telemetry and later typed operations.

Permanent target: Next.js/React + FastAPI + PostgreSQL + Redis/worker on a dedicated DSX management server behind Cloudflare.

For early development, a temporary Cloudflare Worker + D1 adapter is used so the Node Agent contract can be proven before the management VPS is introduced.

## Phase 1 status

The complete local/laptop non-production acceptance flow is proven:

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

Only one Phase 1 gate item remains: repeat the safe flow on one real NON-PRODUCTION Linux server.

## Phase 2 status

Node management and read-only inventory work is in progress.

Implemented so far:

- node roles, pools, labels and placement capacity metadata
- authenticated node metadata update with audit logging
- read-only Odoo/PostgreSQL process discovery
- fixed local version probes without shell execution
- cached read-only PostgreSQL database inventory with database names and sizes only
- bounded outputs and sanitized failure codes
- no passwords, DSNs, config contents, environment dumps or raw PostgreSQL stderr returned
- Python/Ruff/Pytest and Cloudflare unit/typecheck CI coverage remains green

Remaining Phase 2 work includes deployment/validation on a real NON-PRODUCTION node, health history and operational alerts.

## Repository layout

- `apps/api/` — permanent FastAPI control service foundation
- `services/node_agent/` — DSX Node Agent
- `deploy/cloudflare/` — temporary Worker + D1 adapter
- `deploy/node-agent/` — hardened systemd deployment files
- `docs/` — architecture, data model, API contract, roadmap, project rules, decisions
- `tests/` — Python tests

## Safety boundaries

There is no arbitrary remote shell endpoint. Phase 1 and Phase 2 inventory work does not create/delete customer databases, restart Odoo, deploy updates, or return secrets from nodes.

Secrets such as Cloudflare tokens, admin tokens, enrollment tokens, Agent credentials, passwords and connection strings must never be committed or pasted into issues/chat.

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

See `docs/ROADMAP.md` for the phase gates, `docs/ARCHITECTURE.md` for the detailed system design, and `docs/PHASE2_NODE_INVENTORY.md` for the inventory safety contract.
