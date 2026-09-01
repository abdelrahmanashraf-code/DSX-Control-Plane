# DSX Control Plane — Project Charter

## 1. Mission

Build a central SaaS control plane that manages the full DSX customer lifecycle with minimal human intervention: lead/trial onboarding, tenant provisioning, subscription entitlement, billing integration, suspension/reactivation, infrastructure health, backups, releases, and customer self-service.

The platform must be designed for growth from tens of customers to thousands without turning each customer into a manual operations project.

## 2. Primary business outcome

Normal operations should be automated. Human staff should work mainly on exceptions.

Example target for 30 new customers in one day:

- requests are accepted automatically;
- jobs are queued safely;
- tenants are placed on healthy nodes;
- databases are provisioned from approved templates;
- configuration and DSX modules are applied automatically;
- health checks run automatically;
- credentials/onboarding are delivered automatically;
- staff only handle failed jobs, payment exceptions, or custom implementation requests.

## 3. Source-of-truth boundaries

### DSX Control Plane owns

- Customer platform identity
- Tenant lifecycle
- Trial vs production environment
- Plans and subscription state
- Entitlements and service access
- Node/server registry
- Tenant placement
- Provisioning jobs
- Backup/restore operational state
- Health state
- Release assignment and rollout state
- Audit log

### Central Odoo owns

- CRM pipeline
- Accounting
- Invoices
- Payment registration
- Receivables
- Financial reporting

### Customer Odoo owns

- Customer operational business data
- DSX POS/product data
- Local enforcement of signed entitlement
- Local health/identity information reported to the platform

## 4. Non-negotiable architecture principles

1. Each customer tenant uses an isolated Odoo database.
2. No customer provisioning through manual SSH in the normal workflow.
3. No arbitrary shell execution from the web platform.
4. Infrastructure actions must be explicit, authenticated, auditable, retryable, and idempotent where applicable.
5. Subscription enforcement must not make a paying POS customer unusable because the central platform is temporarily unavailable; a controlled connectivity grace strategy is required.
6. Billing suspension is not the same as deleting or shutting down infrastructure.
7. Delete is never the first lifecycle action; suspension, archival, retention, and purge states must exist.
8. Backups must live outside the source node and restore must be tested before production cutover.
9. Release rollout must support staged deployment and stopping a rollout.
10. CloudPepper removal is a migration outcome, not a day-one dependency removal.

## 5. Product users

### Owner / Management
Sees revenue, customers, growth, capacity, churn, and exceptions.

### Sales
Sees leads, trials, follow-up, conversion, and customer status. No server access.

### Implementation
Sees paid customers waiting for onboarding and approved configuration work. Does not manually install standard modules.

### Accounting
Sees invoices, payment proofs, receipts, overdue balances, and payment exceptions.

### Support
Sees customer, tenant health, subscription status, backup status, release version, and safe support actions.

### Technical Admin
Sees nodes, jobs, backups, deployments, releases, capacity, monitoring, and controlled infrastructure operations.

### Customer
Sees subscription, invoices/payments, system status, support, onboarding, and safe tenant self-service only.

## 6. Initial commercial reality

The system must stay cost-conscious because DSX may sell low-price monthly subscriptions. Shared infrastructure must therefore be supported while preserving per-tenant database isolation. Dedicated infrastructure can remain an option for large tenants later.

## 7. MVP definition

The first meaningful production-capable MVP is reached only when DSX can:

1. register and monitor a node;
2. provision a tenant safely from one approved template;
3. generate/route a tenant URL;
4. configure and health-check the tenant automatically;
5. back up and successfully restore that tenant;
6. manage subscription entitlement centrally;
7. integrate billing status with Central Odoo;
8. suspend/reactivate safely;
9. show failures in a clear Needs Attention queue;
10. keep a complete audit trail.

## 8. Explicitly out of scope for early phases

- Building a new accounting engine
- Building a new CRM engine
- Rebuilding Grafana/Prometheus functionality
- Kubernetes
- Kafka/event-streaming platform
- One VM/container stack per small customer
- Rebuilding the DSX POS frontend as part of this project
- Arbitrary remote shell console
- Full CloudPepper replacement before DSX Native is proven

## 9. Success metrics

- Standard trial provisioning requires zero technical human steps.
- Standard paid onboarding requires zero infrastructure human steps.
- Failed provisioning can retry safely without duplicate tenants.
- A node failure or platform outage does not incorrectly invalidate paid subscriptions.
- Every backup policy used for production has a verified restore path.
- Every sensitive action is audited.
- Daily operations are exception-driven: staff focus on a small Needs Attention list rather than browsing all tenants.

## 10. Direction-control rule

Any new feature requested during implementation must answer:

> Is this required to complete the current phase acceptance criteria?

If no, it goes to the backlog and does not change the active phase.
