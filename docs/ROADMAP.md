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

Verified first on `DSX-TEST-01` and repeated successfully on real non-production node `DSX-TEST-SERVER-01`:
- D1/Worker health
- authenticated admin node list
- one-time enrollment
- accepted heartbeat
- continuous heartbeat
- node shown online with CPU/RAM/disk and Odoo/PostgreSQL state
- online -> stale -> offline transition
- offline -> online recovery after Agent restart
- revocation rejects the previous Agent credential with HTTP 401
- real-server acceptance completed without production customer changes

Gate: PASSED.

The credential used for the real-node acceptance test was intentionally revoked after the final 401 rejection check. A fresh enrollment must be used when that test node is brought into Phase 3.

## Phase 2 — Node management and inventory

Status: COMPLETE.

Goal: understand and safely manage the infrastructure that hosts Odoo without creating customer databases yet.

Implemented and validated:
- node labels/roles/pools
- capacity and placement inputs
- authenticated metadata update with audit event
- read-only Odoo/PostgreSQL process discovery
- fixed local version probes without shell execution
- read-only PostgreSQL database inventory using fixed SQL and `--no-password`
- bounded database names/sizes, five-minute cache, output/time limits
- sanitized failure reason codes with no stderr/credentials/connection strings
- bounded node health history sampled at most every five minutes with seven-day retention
- authenticated health-history read endpoint
- observation-only operational alerts for availability, resource pressure, and Odoo/PostgreSQL service state
- local D1 migration verification in CI
- Python/Ruff/Pytest and Cloudflare unit/typecheck/migration CI green
- real-node inventory validated with PostgreSQL 16.15 and 13 databases
- metadata update validated on the real node
- healthy alert state validated
- `node_stale` warning validated between the stale/offline thresholds
- `node_offline` critical alert validated after the offline threshold
- online recovery validated after Agent restart
- final Agent credential revocation validated; old heartbeat rejected with HTTP 401

Gate: PASSED.

Safety boundary retained:
- no arbitrary shell endpoint
- no customer database create/delete during Phase 2
- no secret/config/environment collection
- observation-only alerts cannot trigger remote actions

## Phase 3 — Provisioning

Status: CURRENT.

Goal: create a new isolated customer Odoo database automatically from a controlled template.

Planned capabilities:
- sector templates (restaurant, cafe, retail, supermarket)
- tenant/database records
- placement selection using Phase 2 node metadata/capacity
- explicit provisioning job model and state machine
- idempotency keys and safe retries
- database creation through a narrowly scoped typed operation
- filestore preparation
- DSX module installation/configuration
- domain mapping
- provisioning logs/events without secrets
- failure states visible to operators
- cleanup/rollback for failed test provisioning

Implementation rule:
- do not add a generic shell/command execution API to the Node Agent
- every privileged operation must be typed, authenticated, authorized, bounded and audited
- Phase 3 starts on non-production resources only

Gate:
- repeated test provisioning is predictable and idempotent
- failures are visible and recoverable
- no arbitrary shell endpoint exists
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
