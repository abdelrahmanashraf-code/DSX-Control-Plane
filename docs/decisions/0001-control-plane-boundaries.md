# ADR-0001: Control Plane responsibility boundaries

- Status: Accepted
- Date: 2026-09-01

## Context

DSX needs to operate a subscription-based Odoo product for a growing number of customers while reducing manual infrastructure, billing, trial, and renewal work. Existing management logic is split across custom Odoo modules and CloudPepper operations.

A single system owning CRM, accounting, infrastructure, tenant lifecycle, and customer runtime would create excessive coupling and make outages/migrations harder.

## Decision

Use four explicit responsibility boundaries:

1. **DSX Control Plane** is the source of truth for SaaS operational state: customer platform identity, tenant lifecycle, plan/subscription entitlement, nodes, placement, provisioning jobs, operational backups/health, and release assignment.
2. **Central Odoo** is the source of truth for CRM and financial/accounting records: opportunities, invoices, registered payments, receivables, and accounting reports.
3. **Customer Odoo** owns the customer's operational ERP/POS data and enforces only signed/cached entitlement supplied by DSX.
4. **Infrastructure providers/Node Agents** execute controlled infrastructure operations but do not own business subscription truth.

CloudPepper is treated as a transitional infrastructure provider behind a provider boundary. DSX Native infrastructure will be introduced incrementally and must pass operational gates before CloudPepper retirement.

## Consequences

### Positive

- Control Plane can evolve independently of Odoo UI/model constraints.
- Financial logic is not reimplemented.
- Customer Odoo does not become the authority over its own paid entitlement.
- Central Odoo outage does not inherently stop tenant runtime.
- Infrastructure provider can change without rewriting SaaS domain logic.
- CloudPepper migration can be gradual.

### Costs

- Requires reliable synchronization/integration contracts with Central Odoo.
- Requires signed entitlement and reconciliation design.
- More than one deployable system must be operated.
- Desired/observed state and eventual consistency must be handled explicitly.

## Guardrails

- Do not move financial accounting truth into Control Plane without a new ADR.
- Do not move tenant/subscription operational truth back into customer Odoo without a new ADR.
- Do not couple domain models directly to CloudPepper-specific identifiers or workflows.
- Do not expose arbitrary infrastructure shell execution through Control Plane or Node Agent.
