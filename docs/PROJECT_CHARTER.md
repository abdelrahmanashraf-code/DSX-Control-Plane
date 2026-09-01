# DSX Control Plane — Project Charter

## Product mission

Build the operational control plane that allows DSX POS to be sold and operated as a scalable Odoo Community SaaS product without requiring manual infrastructure work for every customer.

The target operating model is exception-based: normal customer onboarding, trial provisioning, subscription lifecycle, monitoring, backups and releases should be automated; operators intervene only for exceptions.

## Business context

DSX POS is an Odoo Community-based product sold as a recurring subscription. The platform must support growth from the current customer base to thousands of isolated customer databases while preserving operational safety and predictable support effort.

## Source-of-truth boundaries

### DSX Control Plane
Owns SaaS operational state:
- customers/tenants
- plans and subscription operational state
- nodes and capacity
- databases/instances
- provisioning jobs
- health and monitoring
- backups/restores
- releases/deployments
- trial lifecycle
- audit trail for privileged SaaS operations

### Management Odoo
Owns business and financial workflows:
- CRM
- quotations/sales where used
- invoices/accounting
- payment recording and business follow-up

It integrates with the Control Plane but does not orchestrate infrastructure.

### Customer Odoo
Runs the DSX product for the customer. A small DSX Agent/subscription component consumes signed central entitlement and reports operational state, but the customer database is not the subscription source of truth.

## Core architecture rules

- One isolated Odoo database per customer/tenant.
- Multiple customer databases may share a managed node/cell.
- Heavy customers can later move to dedicated nodes.
- Placement is based on capacity and load, not a fixed number of customers per server.
- Trial and production pools are separated.
- Golden templates are maintained per target sector.
- Subscription suspension normally locks entitlement rather than stopping Odoo infrastructure.
- Connectivity grace and billing grace are separate concepts.
- A Control Plane outage must not immediately disable a paying customer's POS.
- Backups include database and filestore and are stored outside the application node.
- Releases use canary/ring rollout rather than updating all tenants simultaneously.
- Node management is outbound-only over HTTPS and uses typed operations; arbitrary remote shell is not an API feature.
- Kubernetes, Kafka, and unnecessary microservice complexity are intentionally excluded from the initial product.

## Technology direction

Permanent target:
- Web UI: Next.js / React
- API: FastAPI
- Operational database: PostgreSQL
- Queue/cache: Redis + worker
- Node Agent: Python
- Infrastructure automation: Ansible/Terraform where appropriate
- Customer product: Odoo 18 Community + DSX modules
- Monitoring: Prometheus/Grafana or equivalent
- Backups: S3-compatible object storage
- Cloudflare in front of the dedicated management service

Temporary early-development path:
- Cloudflare Worker + D1 provides the first lightweight control adapter until a dedicated DSX management VPS is ready.
- The Node Agent HTTP contract is kept stable so the temporary persistence/backend can be replaced without reinstalling the protocol on customer nodes.

## Phase discipline

Fixed sequence:
1. architecture/docs
2. Control Plane core + first safe test node
3. node management/inventory
4. provisioning
5. backup/restore
6. trial automation
7. subscription/billing integration
8. customer portal
9. release management
10. gradual CloudPepper exit

Each phase has an acceptance gate. New ideas are placed in the backlog unless they are required to pass the current gate.

## Phase 1 proof completed so far

On the non-production local node `DSX-TEST-01`, the platform has already proven:
- Cloudflare Worker + D1 health
- admin authentication
- one-time node enrollment
- persistent per-node credential
- authenticated heartbeat
- CPU/RAM/disk and OS telemetry
- Odoo/PostgreSQL running-state detection
- continuous online heartbeat
- online -> stale -> offline detection
- offline -> online recovery after Agent restart

Revocation/audit verification and one real non-production server test remain before the Phase 1 deployment gate is closed.

## CloudPepper exit principle

CloudPepper is not removed abruptly. Native DSX operations are proven first, then trials, then a small live cohort, then all new customers, and finally older customers are migrated in controlled batches.

## Definition of success

The project succeeds when DSX can onboard and operate a large customer base with automated provisioning, clear subscription state, reliable monitoring, recoverable backups, controlled releases, and minimal per-customer manual infrastructure work.
