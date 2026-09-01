# ADR-0002: Temporary Cloudflare Control Adapter

- Status: Accepted
- Date: 2026-09-01

## Context

The permanent DSX management server is not available yet. Development must continue without placing Control Plane workloads on the current customer production server and without coupling the long-term architecture to temporary hosting.

## Decision

Use a Cloudflare Worker as a temporary thin control adapter for Phase 1 node enrollment and heartbeat traffic.

The temporary runtime is:

Cloudflare Worker -> Hyperdrive -> PostgreSQL

Cloudflare is not the long-term business-logic runtime and is not the authoritative database technology choice. The stable boundary is the Node Agent HTTP API contract documented in `docs/NODE_AGENT_API_V1.md`.

When the dedicated DSX management server is available, the same contract moves behind Cloudflare to the FastAPI Control Plane without requiring Node Agent rewrites.

## Constraints

- Do not place Control Plane PostgreSQL state in a customer Odoo database.
- Do not put customer SaaS billing/provisioning business logic in the temporary Worker.
- Do not use D1 for core domain persistence merely because the temporary compute layer is Cloudflare.
- Do not expose generic remote command execution.
- Secrets remain in Cloudflare secrets / secure node state, never Git.
- Production customer infrastructure is out of scope for Phase 1.

## Consequences

Positive:

- Development continues before the management VPS exists.
- Customer production infrastructure remains isolated from the new control system.
- Node Agent transport is exercised early over the public Internet through HTTPS.
- Migration to the permanent management server is a runtime move rather than a domain rewrite.

Trade-offs:

- A temporary external PostgreSQL database is required until the management server exists.
- The Worker implements only the narrow Phase 1 transport surface, so some code will later be replaced by FastAPI handlers while preserving contracts and data semantics.
