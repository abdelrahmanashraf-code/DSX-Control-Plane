# ADR-0002: Temporary Cloudflare Control Adapter

- Status: Accepted
- Date: 2026-09-01

## Context

The permanent DSX management server is not available yet. Development must continue without placing Control Plane workloads on the current customer production server and without coupling the long-term architecture to temporary hosting.

The first PostgreSQL/Hyperdrive setup added unnecessary operational steps for a short-lived development environment.

## Decision

Use a Cloudflare Worker plus a dedicated Cloudflare D1 database as the temporary Phase 1 control adapter for node enrollment, heartbeat state, node listing/revocation, and audit events.

The temporary runtime is:

Cloudflare Worker -> D1

D1 is explicitly a **temporary development persistence adapter**, not the long-term Control Plane database decision. The stable boundary is the Node Agent HTTP API contract documented in `docs/NODE_AGENT_API_V1.md`.

When the dedicated DSX management server is available, the same HTTP contract moves behind Cloudflare to the FastAPI Control Plane with PostgreSQL persistence. Node Agents must not require a protocol rewrite during that move.

## Constraints

- D1 is only for the temporary Phase 1/early-development control state.
- Do not place Control Plane state in a customer Odoo database.
- Do not put customer SaaS billing/provisioning business logic in the temporary Worker.
- Do not expose generic remote command execution.
- Secrets remain in Cloudflare secrets / secure node state, never Git.
- Production customer infrastructure is out of scope for Phase 1.
- The domain model and API contracts must remain portable to PostgreSQL/FastAPI.

## Consequences

Positive:

- Development continues before the management VPS exists.
- No separate Neon/Hyperdrive/PostgreSQL setup is required for the temporary stage.
- Customer production infrastructure remains isolated from the new control system.
- Node Agent transport is exercised early over public HTTPS.
- Migration to the permanent management server preserves the external Node Agent contract.

Trade-offs:

- D1 uses SQLite semantics, so the temporary Worker is not the production persistence implementation.
- Phase 1 data must later be migrated or recreated in PostgreSQL.
- Stronger production transaction and persistence rules will be implemented in the permanent backend before production provisioning is allowed.
