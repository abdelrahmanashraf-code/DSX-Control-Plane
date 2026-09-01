# DSX Control Plane — Architecture

## 1. System overview

```text
                         DSX CONTROL PLANE
                                  |
              +-------------------+-------------------+
              |                   |                   |
          Admin Web          Customer Portal        Public API
              |                   |                   |
              +-------------------+-------------------+
                                  |
                              FastAPI API
                                  |
                  +---------------+---------------+
                  |                               |
             PostgreSQL                      Job Queue
                                                  |
                                             Worker(s)
                                                  |
                                      DSX Provisioning Layer
                                                  |
                         +------------------------+------------------------+
                         |                                                 |
                  DSX Native Provider                              CloudPepper Provider
                  (target provider)                                (migration bridge)
                         |
              +----------+----------+
              |          |          |
           Node 01    Node 02    Node NN
              |          |          |
         Node Agent  Node Agent  Node Agent
              |          |          |
         Odoo/Postgres tenant databases
```

Central Odoo is an integrated business system, not the infrastructure control plane:

```text
DSX Control Plane <---- secure integration ----> Central Odoo
                                             CRM / Invoices / Accounting / Payments
```

Customer Odoo is the tenant runtime:

```text
DSX Control Plane ---> signed entitlement ---> DSX Agent ---> Customer Odoo
DSX Control Plane <--- identity / health ------- DSX Agent <--- Customer Odoo
```

## 2. Application components

### apps/web

Admin application and customer portal.

Responsibilities:
- dashboards;
- customer and tenant operations;
- subscriptions;
- provisioning job visibility;
- nodes;
- backups;
- releases;
- Needs Attention;
- customer self-service.

It never connects directly to customer PostgreSQL or Linux nodes.

### apps/api

FastAPI application and central application boundary.

Responsibilities:
- authentication/authorization;
- domain APIs;
- validation;
- state transitions;
- job submission;
- Odoo integration endpoints/webhooks;
- audit initiation;
- safe node/provider command contracts.

### apps/worker

Asynchronous job execution.

Responsibilities:
- provisioning workflows;
- backup/restore orchestration;
- health reconciliation;
- subscription scheduled rules;
- release rollout jobs;
- retries and compensation where needed.

Long-running infrastructure work must not run inside normal HTTP request handlers.

### services/node-agent

Small service installed on every DSX Native node.

The agent exposes only approved operations such as:
- health;
- capacity;
- provision database;
- restore approved template;
- backup tenant;
- restore tenant;
- restart approved runtime;
- apply approved release;
- archive/purge tenant under policy.

No generic `exec`, terminal, or arbitrary shell endpoint is allowed.

Prefer an outbound authenticated control channel/heartbeat design where practical so administrative node services do not need broad public exposure.

### Central Odoo integration

Central Odoo remains the financial and CRM engine.

Examples:
- Control Plane creates/references customer identity.
- CRM lead/opportunity is synced to Odoo.
- Billing request results in an Odoo invoice.
- Payment confirmation/webhook is reconciled in Odoo.
- Financial confirmation updates Control Plane subscription state through an idempotent integration event.

The Control Plane must not treat a temporary Odoo integration outage as permission to destroy/suspend infrastructure incorrectly.

## 3. Infrastructure model

### Shared DSX Node

Early production architecture is a cell/node model:

```text
DSX NODE
  Reverse Proxy
  Odoo Runtime
  PostgreSQL
  DSX Node Agent
  Monitoring exporters

  tenant_000001
  tenant_000002
  tenant_000003
  ...
```

Each tenant has an isolated database. Multiple small tenants may share a node/runtime for cost efficiency.

### Dedicated tenant

Large tenants may later use a dedicated node while still appearing as a normal tenant in Control Plane. The domain model must not assume all tenants are shared.

## 4. Trial and production pools

Trial and production capacity are logically separated.

```text
Trial Pool                     Production Pool
Trial Node 01                  Production Node 01
Trial Node 02                  Production Node 02
                               ...
```

Default policy:
- trials use trial infrastructure and approved demo templates;
- successful payment normally provisions a clean production tenant;
- trial promotion with data retention can be implemented as an explicit controlled workflow later.

## 5. Tenant routing

Each tenant has a stable public hostname/subdomain. Routing maps the host to the proper node and database.

Control Plane owns routing metadata. Node configuration uses a safe database routing policy such as Odoo `dbfilter`; database manager/listing must not be exposed in production.

## 6. Subscription architecture

Subscription truth lives in Control Plane.

Example effective states:

```text
DRAFT
PENDING_ACTIVATION
ACTIVE
EXPIRING
PAST_DUE
GRACE
SUSPENDED
CANCELLED
ARCHIVED
```

Billing state and infrastructure state are separate concepts.

Example:

```text
subscription = SUSPENDED
infrastructure = RUNNING
```

This allows support, backups, recovery, and safe reactivation while customer business access is restricted.

### Connectivity grace

A valid paid entitlement is cached locally by the DSX Agent. If Control Plane is temporarily unreachable, the customer does not immediately lose access. Entitlements are signed, bounded, and renewed periodically.

Connectivity grace and unpaid billing grace are separate policies.

## 7. Provisioning workflow

Provisioning is a durable workflow, not one synchronous script.

Example steps:

```text
VALIDATE_REQUEST
SELECT_NODE
RESERVE_TENANT
CREATE_OR_RESTORE_DATABASE
APPLY_TEMPLATE
CONFIGURE_COMPANY
CREATE_ADMIN
APPLY_RELEASE
CONFIGURE_AGENT
CONFIGURE_ROUTE
HEALTH_CHECK
MARK_READY
```

Requirements:
- each step has status and timestamps;
- retries must not create duplicate resources;
- tenant/database identifiers are reserved before destructive/external work;
- secrets are never stored in job logs;
- failure leaves the tenant in a known state;
- manual intervention is an explicit exception action.

## 8. Placement

Initial placement does not need AI.

Inputs may include:
- node environment/pool;
- node status;
- CPU pressure;
- RAM pressure;
- disk capacity;
- tenant count;
- reserved capacity;
- tenant size class;
- maintenance/draining state.

A node can be marked `draining` to block new tenant placement without immediately affecting existing tenants.

## 9. Backup architecture

Production backup unit includes:
- PostgreSQL tenant database;
- Odoo filestore;
- metadata required to restore routing/configuration.

Backups must be stored outside the source node using S3-compatible object storage or equivalent.

Backup success is not sufficient. Restore verification is a release gate for production operation.

## 10. Monitoring and observability

Do not build monitoring internals from scratch.

Use standard tools for metrics/log collection; Control Plane consumes summarized state and exposes business-friendly status.

Control Plane records:
- node heartbeat;
- service health;
- tenant health;
- backup result;
- capacity warning;
- failed jobs;
- release status;
- subscription/payment exceptions.

These feed the `Needs Attention` queue.

## 11. Release architecture

A DSX release is immutable metadata pointing to an approved product/runtime version.

Rollout stages:

```text
INTERNAL -> TRIAL -> CANARY -> PERCENTAGE -> GENERAL
```

Rollout can be paused/stopped. Release state and tenant assigned release are tracked centrally.

## 12. Security boundaries

- No arbitrary shell from web/API.
- Node agent authentication is machine-to-machine and revocable.
- Secrets are stored outside normal logs/database fields where possible.
- Sensitive actions require explicit authorization and audit.
- Destructive operations use lifecycle guards and retention rules.
- Public customer APIs expose no internal server/database secrets.
- All cross-service state-changing calls require idempotency/replay protection where applicable.

## 13. CloudPepper migration boundary

Provider interface concept:

```text
InfrastructureProvider
  provision_tenant()
  backup_tenant()
  restore_tenant()
  get_health()
  restart_runtime()
  deploy_release()
  archive_tenant()
  purge_tenant()
```

Implementations:
- `CloudPepperProvider` during transition;
- `DSXNativeProvider` as target.

Domain services must depend on the provider contract rather than CloudPepper-specific models.

## 14. Initial technology direction

- Frontend: Next.js / React / TypeScript
- API: FastAPI / Python
- Platform DB: PostgreSQL
- Async jobs: Redis-backed worker initially
- Node Agent: Python service
- Infrastructure automation: Ansible + Terraform where appropriate
- Monitoring: Prometheus/Grafana-compatible stack
- Backup storage: S3-compatible object storage
- Customer runtime: Odoo 18 Community
- Financial/CRM runtime: Central Odoo

This stack is a starting decision and can evolve through ADRs; architecture boundaries above are more important than framework preference.
