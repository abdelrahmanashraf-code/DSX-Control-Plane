# DSX Control Plane Roadmap

## Phase 0 — Architecture and project rules

Status: complete.

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

Status: COMPLETE.

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

Gate: PASSED.

## Phase 2 — Node management and inventory

Status: COMPLETE.

Implemented and validated:
- node labels/roles/pools
- capacity and placement inputs
- authenticated metadata update with audit event
- read-only Odoo/PostgreSQL process discovery
- fixed local version probes without shell execution
- read-only PostgreSQL database inventory
- bounded node health history and operational alerts
- real-node stale/offline/recovery/revocation acceptance

Gate: PASSED.

Safety boundary retained:
- no arbitrary shell endpoint
- no secret/config/environment collection
- observation-only alerts cannot trigger remote actions

## Phase 3 — Provisioning

Status: COMPLETE.

Implemented and validated:
- controlled sector templates
- tenant/database records
- capacity-aware placement
- explicit provisioning state machine
- idempotent requests and safe retries
- typed Odoo environment provisioning
- database + filestore preparation
- provisioning ownership marker
- test-only fail-closed identity checks
- safe typed cleanup for disposable test environments
- real non-production provisioning acceptance

Gate: PASSED.

## Phase 4 — Backup and restore

Status: COMPLETE.

Implemented and validated:
- PostgreSQL + filestore logical backup set
- S3-compatible object storage
- SHA-256/size manifest verification
- server-local scoped storage credentials
- verified upload/read-back
- typed deterministic restore into disposable test environments
- safe PostgreSQL ownership restoration
- module/schema/marker/filestore validation
- fail-closed identity mismatch handling
- safe cleanup after restore
- first non-production retention policy
- full disaster-recovery acceptance after destroying the source environment

Gate: PASSED.

Acceptance proved that a verified backup survives source destruction, restores into a fresh environment, loads successfully in Odoo, and can be safely cleaned up without changing the golden template.

## Phase 5 — Trial automation + Admin Control Panel

Status: CURRENT.

Goal: website/admin trial request to usable 3-day demo without routine operator terminal work, while introducing the DSX Admin UI as the normal operational control surface.

Planned capabilities:
- `apps/web` Next.js/React Admin UI
- server-only Control Plane API client; Worker admin token never exposed to browser JavaScript
- dashboard for tenants, trials, nodes, alerts, provisioning, backup and restore state
- operator views for nodes, tenants/trials and activity
- responsive RTL-ready layout
- DSX website request integration
- sector/template selection
- trial-pool placement
- automatic provisioning
- trial expiration metadata and lifecycle
- automatic expiration cleanup through the proven typed cleanup path
- conversion workflow toward production

Gate:
- operator can create a disposable 3-day trial from the Admin UI without curl/SSH
- trial provisions automatically on non-production infrastructure
- status/failures/retries are visible in UI and audit history
- trial expires and cleans up safely
- no production customer environment or golden template is modified

Tracking issue: #10 `Phase 5: Trial Automation + Admin Control Panel`.

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

CloudPepper is removed only after the native DSX stack has proven provisioning, monitoring, backup/restore, trial lifecycle and release safety.
