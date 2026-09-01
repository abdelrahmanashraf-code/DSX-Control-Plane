# DSX Control Plane

DSX Control Plane is the central SaaS operations platform for managing the full lifecycle of DSX customers, tenants, subscriptions, infrastructure, provisioning, backups, releases, and customer self-service.

## Core principle

The platform is designed so normal customer lifecycle operations do not require manual SSH, PostgreSQL, CloudPepper, or per-database configuration.

### Responsibility boundaries

- **DSX Control Plane**: source of truth for customers, tenants, plans, subscriptions, entitlements, provisioning jobs, node placement, health state, releases, and SaaS operations.
- **Central Odoo**: CRM, accounting, invoices, payment registration, receivables, and financial records.
- **Customer Odoo**: runs the DSX product and enforces signed subscription entitlement through a small DSX agent.
- **DSX Provisioner / Node Agent**: executes controlled infrastructure operations on DSX nodes.

## Project goal

A day with 30 new customers should result in automated queued jobs, not 30 manual implementation projects. Human operators should work mainly on exceptions.

## Project documentation

- `docs/PROJECT_CHARTER.md` — product mission, scope, principles, and success criteria.
- `docs/ARCHITECTURE.md` — system boundaries and runtime architecture.
- `docs/DATA_MODEL.md` — initial domain model and lifecycle states.
- `docs/ROADMAP.md` — phased delivery plan and gates.
- `docs/WORKING_RULES.md` — rules that prevent scope drift and unsafe operations.
- `docs/decisions/` — Architecture Decision Records (ADRs).

## Current phase

**Phase 0 — Architecture and project foundation.**

No production customer infrastructure will be changed during Phase 0.
