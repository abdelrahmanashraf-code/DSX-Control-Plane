# DSX Control Plane Roadmap

## Phase 0 — Architecture and project rules

Status: complete enough to proceed.

Deliverables:
- project charter
- system boundaries
- target architecture
- initial data model
- working rules
- architecture decision records

Gate:
- Control Plane owns SaaS operations.
- Management Odoo owns CRM/accounting/payment business processes.
- Customer Odoo remains the product runtime, not the subscription source of truth.

## Phase 1 — Control Plane core + first test node

Status: local acceptance PASS; one real non-production server repeat remains.

Deliverables:
- FastAPI foundation for the permanent management service
- temporary Cloudflare Worker + D1 adapter for early development
- admin authentication
- Node Agent enrollment
- persistent per-node identity
- authenticated heartbeat
- CPU/RAM/disk/OS metrics
- Odoo/PostgreSQL running-state detection
- online/stale/offline detection
- node revocation
- audit events
- hardened outbound-only Node Agent service definition

Verified on `DSX-TEST-01`:
- D1/Worker health
- authenticated admin node list
- one-time enrollment
- accepted and continuous heartbeat
- CPU/RAM/disk plus Odoo/PostgreSQL state
- online -> stale -> offline transition
- offline -> online recovery after Agent restart
- revocation rejects old Agent credential with HTTP 401
- audit visibility for token creation, enrollment, and revocation

Remaining gate item:
- repeat the safe enrollment/heartbeat flow on one real NON-PRODUCTION Linux server node

No production customer node is part of the Phase 1 gate.

## Phase 2 — Node management and inventory

Goal: understand and safely manage the infrastructure that hosts Odoo without creating customer databases yet.

Status: started in code while the external Phase 1 server gate is pending.

Implemented and unit-tested:
- node role (`odoo-postgres`, `odoo`, `postgresql`)
- node pool assignment
- bounded node labels
- placement capacity inputs (`max_tenants`, reserved RAM, reserved disk)
- authenticated admin metadata update endpoint
- audit event for node metadata changes
- D1 migration tracking for Phase 2 schema

Next capabilities:
- validate metadata on a real non-production server
- discover Odoo runtime information
- discover PostgreSQL/database inventory using read-only typed operations
- track node health history
- surface failures and operational alerts

Gate:
- inventory is reliable on a non-production server
- no arbitrary shell endpoint
- all typed privileged operations are authenticated and audited

## Phase 3 — Provisioning

Goal: create a new isolated customer Odoo database automatically from a controlled template.

Planned capabilities:
- sector templates (restaurant, cafe, retail, supermarket)
- tenant/database records
- placement selection
- database creation
- filestore preparation
- DSX module installation/configuration
- domain mapping
- provisioning jobs with idempotency and retry
- failure states visible to operators

Gate:
- repeated test provisioning is predictable and reversible
- no production rollout before restore capability is proven

## Phase 4 — Backup and restore

Goal: backups independent of the hosting node.

Planned capabilities:
- database + filestore backups
- S3-compatible object storage
- retention policy
- encrypted credentials
- restore workflow
- scheduled restore tests

Gate:
- a disposable customer environment can be restored successfully from backup

## Phase 5 — Trial automation

Goal: website trial request to usable 3-day demo without operator work.

Planned capabilities:
- DSX website request integration
- sector/template selection
- trial pool placement
- automatic domain/database creation
- expiration and cleanup
- conversion workflow toward production

## Phase 6 — Subscription and billing integration

Goal: connect commercial state to product entitlement without making customer POS dependent on continuous Control Plane availability.

Planned capabilities:
- central plan/subscription state
- Management Odoo CRM/invoice/payment integration
- signed entitlement for customer Agent/Odoo
- billing grace separate from connectivity grace
- suspend/reactivate workflow
- payment-proof exception handling where needed

## Phase 7 — Customer portal

Goal: simple customer self-service.

Planned capabilities:
- subscription status
- invoices/payment status
- onboarding material
- company/account details
- support/contact entry points

## Phase 8 — Release management

Goal: safe DSX product updates across many customer databases.

Planned capabilities:
- release catalog
- canary/rings
- compatibility checks
- per-tenant deployment status
- rollback/recovery policy
- no mass `git pull` against every customer simultaneously

## Phase 9 — Gradual CloudPepper exit

Migration order:
1. prove native Node Agent/control flow
2. use native flow for trials
3. migrate a small non-critical live cohort
4. provision all new customers natively
5. migrate remaining legacy customers in batches

CloudPepper is removed only after the native DSX stack has proven provisioning, monitoring, backup/restore, and release safety.
