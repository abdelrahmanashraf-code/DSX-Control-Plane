# DSX Control Plane — Working Rules

## 1. One direction, controlled phases

The project follows the approved architecture and roadmap. Do not create a new architecture for every new idea. Ideas that are not required for the current acceptance gate go to backlog.

## 2. Safety before scale

Never use a production customer node as the first test for a new infrastructure capability. Prove changes in this order:

1. local/non-production test environment
2. non-production server
3. small controlled live cohort
4. broader rollout

## 3. Explicit system boundaries

- Control Plane owns SaaS operational state.
- Management Odoo owns CRM/accounting/payment business workflows.
- Customer Odoo runs the DSX product.
- Customer databases are not the central subscription source of truth.

## 4. No arbitrary remote shell API

Node Agent communication is outbound-only HTTPS. Remote capabilities are typed, narrow operations with validation and audit history. Do not add a generic shell/command endpoint.

## 5. Secrets never enter source control

Never commit or paste into issues/chat:
- Cloudflare/API tokens
- `ADMIN_API_TOKEN`
- enrollment tokens
- Agent credentials
- SSH private keys
- database passwords/connection strings
- signing private keys

Store production secrets in the selected secret manager/runtime secret store.

## 6. One-time enrollment

Enrollment tokens are short-lived and one-use. The Agent receives a unique long-lived node credential after enrollment. The Control Plane persists only a hash of that credential.

## 7. Revocation must be enforceable

A revoked Node Agent credential must be rejected immediately by the Control Plane. Revocation is an audited lifecycle operation.

## 8. Monitoring is not destructive control

Health collection may inspect CPU, memory, disk, operating system and service state. Monitoring code must not silently restart services or mutate Odoo/PostgreSQL.

## 9. Database isolation

Default SaaS tenancy is one isolated Odoo database per customer. Do not model thousands of unrelated customers as companies in one shared customer database.

## 10. Provisioning must be idempotent

When provisioning is introduced, jobs need explicit states, retry safety, idempotency keys and auditable errors. A retry must not accidentally create duplicate tenant databases/domains/resources.

## 11. Backup before dangerous change

Before production migration, destructive schema work, tenant movement or release operations, backup/restore capability must already be tested for the affected resource type.

## 12. Release rings

Do not update every customer simultaneously. Releases progress through test/canary/rings with visible deployment state and stop conditions.

## 13. Temporary Cloudflare/D1 rule

Cloudflare Worker + D1 is temporary early-development persistence. Business-critical subscription/provisioning logic must not become permanently trapped in the Worker. The permanent target is FastAPI + PostgreSQL on the dedicated DSX management service.

The Node Agent HTTP contract should remain stable during that backend migration.

## 14. CloudPepper exit is gradual

Do not remove CloudPepper from existing production customers until native DSX provisioning, monitoring, backup/restore, and release safety have been proven. Move trials first, then small live cohorts, then new customers, then old customers.

## 15. Acceptance gates are recorded

When a phase behavior is proven, update the roadmap/issue rather than relying on chat history. Phase 1 currently has verified enrollment, heartbeat, telemetry, online/stale/offline detection, and offline-to-online recovery on `DSX-TEST-01`; revocation/audit and a non-production server repeat remain.
