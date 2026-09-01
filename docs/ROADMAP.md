# DSX Control Plane — Delivery Roadmap

This roadmap is sequential. A phase is not complete because code exists; it is complete only when its acceptance gate passes.

## Phase 0 — Foundation and architecture

Deliverables:
- Project Charter
- Architecture
- Initial Data Model
- Working Rules
- ADRs for major architecture boundaries
- Repository skeleton and development standards
- Initial security model and environment strategy

Gate:
- scope and ownership boundaries are documented;
- lifecycle states are documented;
- destructive/sensitive operations policy is documented;
- no production infrastructure has been changed;
- next phase has explicit acceptance criteria.

## Phase 1 — Control Plane Core + first Node

Goal: the platform can securely know about and observe one non-production DSX node.

Deliverables:
- FastAPI API skeleton
- PostgreSQL persistence/migrations
- Admin authentication foundation
- Node model/API
- Node Agent skeleton
- secure node registration/identity
- heartbeat
- CPU/RAM/disk/service health summary
- node online/offline/stale detection
- basic Admin Node list/detail
- audit events for registration and sensitive node actions

Acceptance gate:
- a test node can register without manual database edits;
- heartbeats update observed state;
- an invalid/revoked agent cannot report as the node;
- node becomes stale/offline when heartbeat is lost according to policy;
- no arbitrary shell endpoint exists;
- tests cover registration, auth, replay/idempotency where relevant, and stale detection.

## Phase 2 — Jobs + controlled node operations

Goal: long-running operations are durable and observable.

Deliverables:
- Redis-backed worker
- Job and JobStep models
- idempotency keys
- retry strategy
- correlation IDs
- controlled health/restart operation
- Needs Attention foundation

Acceptance gate:
- API request can enqueue and return immediately;
- worker failure does not lose job state;
- retry cannot duplicate the operation;
- operator sees safe failure reason and retry state;
- secrets do not appear in logs/job output.

## Phase 3 — Backup and restore foundation

Goal: prove DSX Native can protect one test tenant before production provisioning.

Deliverables:
- S3-compatible backup destination
- PostgreSQL backup
- filestore backup
- retention metadata
- manual backup job
- restore job into non-production environment
- restore verification checklist/health test

Acceptance gate:
- backup artifacts are stored outside the source node;
- a backup can restore DB + filestore successfully;
- restored Odoo starts and passes health checks;
- failed backup/restore appears in Needs Attention;
- destructive restore is guarded and audited.

## Phase 4 — Trial provisioning MVP

Goal: one approved Restaurant template can create a complete trial automatically.

Deliverables:
- Customer model
- Tenant model
- Template model
- one approved Restaurant template
- node placement v1
- tenant/database name reservation
- database create/restore workflow
- standard DSX configuration
- tenant admin creation
- route/hostname setup
- DSX agent enrollment
- health check
- trial expiry state

Acceptance gate:
- create trial request results in a ready URL without SSH/manual DB work;
- retry does not create duplicate database/tenant;
- failure at each tested step leaves known recoverable state;
- tenant is visible with node/database/release/health metadata;
- expired trial can be suspended safely.

## Phase 5 — Trial intake + onboarding automation

Goal: sales/implementation workload is reduced for normal demo users.

Deliverables:
- public trial request endpoint/form integration
- deduplication/rate/abuse controls
- sector/template selection
- onboarding notification integration
- short onboarding video link per sector
- onboarding checklist/status
- trial conversion handoff to CRM

Acceptance gate:
- standard trial can be requested and delivered without staff provisioning;
- duplicate/retry submission is safe;
- sales sees lead/trial status and exceptions;
- implementation is not required for standard trial setup.

## Phase 6 — Subscription and entitlement engine

Goal: Control Plane owns customer access policy safely.

Deliverables:
- Plan
- Subscription
- billing period rules
- grace rules
- signed entitlement issuance
- DSX customer agent integration
- connectivity grace
- suspension/reactivation
- reconciliation/heartbeat

Acceptance gate:
- active paid entitlement works when Control Plane is temporarily unreachable within policy;
- expired/unpaid subscription transitions predictably;
- suspend/reactivate does not require server shutdown;
- restore of an older customer DB cannot forge a newer subscription state;
- entitlement actions are audited.

## Phase 7 — Central Odoo CRM/Billing integration

Goal: avoid rebuilding accounting while keeping SaaS truth in Control Plane.

Deliverables:
- customer mapping to Odoo partner
- lead/opportunity integration
- invoice request/reference flow
- payment confirmation integration
- manual payment proof workflow
- idempotent reconciliation
- overdue/payment exception dashboard

Acceptance gate:
- invoice financial truth remains in Odoo;
- payment confirmation updates subscription exactly once;
- duplicate webhook/sync calls are harmless;
- temporary Odoo outage does not corrupt tenant/subscription state;
- manual proof approval produces an auditable financial/subscription transition.

## Phase 8 — Production tenant provisioning

Goal: standard paid customer setup is automatic.

Deliverables:
- production node pool
- production placement policy
- production template/release controls
- clean production provisioning after payment
- credentials/onboarding delivery
- production-specific backup policy

Acceptance gate:
- paid standard customer can move from payment-confirmed to ready production tenant without infrastructure staff;
- production backups are enabled and tested;
- test/trial infrastructure is not selected by production placement;
- every production tenant has release, node, backup, subscription, and health records.

## Phase 9 — Customer Portal

Goal: reduce sales/support/accounting repetitive work.

Deliverables:
- customer authentication
- subscription status
- invoices/payment links or references
- upload payment proof
- tenant status/open system
- onboarding content
- support entry point
- safe backup/service requests where approved

Acceptance gate:
- customer cannot access another customer's resources;
- no sensitive infrastructure details are exposed;
- common subscription/payment/support tasks do not require staff to relay basic information manually.

## Phase 10 — Release management

Goal: operate product updates safely across many tenants.

Deliverables:
- immutable release records
- desired vs observed release state
- rollout stages
- canary/percentage rollout
- stop rollout
- pre-upgrade backup hook
- upgrade health checks
- drift reporting

Acceptance gate:
- release can be tested on internal/trial/canary scopes before broad rollout;
- failure can stop the rollout;
- tenant versions are observable centrally;
- release operations are auditable.

## Phase 11 — Multi-node scale and operations hardening

Goal: operate many nodes from one place.

Deliverables:
- capacity thresholds
- draining/maintenance modes
- placement improvements
- node failure playbooks
- tenant migration workflow
- rate/concurrency controls for large job bursts
- operational dashboards/SLOs

Acceptance gate:
- 30 onboarding requests can be queued concurrently without unsafe duplicate execution;
- node capacity prevents unsafe new placement;
- node maintenance can drain new placements while existing tenants remain known;
- failure simulations produce actionable Needs Attention items.

## Phase 12 — CloudPepper exit

Goal: make DSX Native the default provider only after it proves operational equivalence for DSX needs.

Migration stages:
1. DSX Native trials only.
2. Small number of new real customers.
3. Larger new-customer cohort.
4. DSX Native becomes default for all new customers.
5. Controlled migration tooling/playbook for existing customers.
6. Retire CloudPepper dependency after agreed stability period.

Exit gate:
- provisioning, backup, verified restore, monitoring, releases, suspension/reactivation, and operational support are proven on DSX Native;
- migration rollback path is documented/tested;
- no mass cutover is required.

## Definition of Done for every phase

A feature is not Done without the applicable items:
- implementation;
- automated tests;
- failure-path tests;
- authorization/security checks;
- observability/logging;
- audit coverage for sensitive changes;
- documentation;
- operational recovery/rollback instructions;
- acceptance criteria demonstrated in non-production.
