# ADR 0001 — DSX Control Plane Boundaries

## Status
Accepted

## Context

DSX POS is an Odoo Community product that must grow from manually managed customer databases into a scalable SaaS platform. The system needs clear ownership of commercial data, SaaS operational state, customer runtime state, and infrastructure operations.

Without strict boundaries, subscription logic, CRM/accounting, provisioning, monitoring, backups and product runtime can become coupled inside customer Odoo databases or one central Odoo instance. That would make large-scale operations and a future CloudPepper exit harder and riskier.

## Decision

### DSX Control Plane is the SaaS operational source of truth

It owns:
- tenant/customer operational identity
- plans/subscription operational state
- nodes and capacity
- tenant databases/instances
- provisioning jobs
- health/monitoring state
- backup/restore state
- release/deployment state
- trial lifecycle
- privileged operational audit events

### Management Odoo is the business/financial system

It owns:
- CRM
- invoicing/accounting
- payment records
- business follow-up

It may request or consume Control Plane operations through defined APIs/events, but it does not directly orchestrate servers, PostgreSQL or customer database lifecycle.

### Customer Odoo is the product runtime

Each tenant normally receives its own isolated Odoo database. DSX modules provide POS/product behavior. A small customer-side Agent/subscription component may consume signed entitlement and report operational state, but it is not the central subscription source of truth.

### Node Agent is the controlled infrastructure boundary

The Agent initiates outbound HTTPS to the Control Plane. It exposes no inbound management port. Capabilities are typed and explicitly implemented; arbitrary remote shell execution is not part of the platform API.

## Consequences

- Customer databases remain isolated.
- The platform can migrate its permanent Control Plane backend without redesigning the node protocol.
- Management Odoo can evolve independently from infrastructure orchestration.
- A Control Plane outage does not inherently require customer POS outage; entitlement logic must include connectivity grace.
- Billing grace and infrastructure/connectivity grace are separate concerns.
- Provisioning, backup, release and destructive operations require explicit acceptance gates and audit history.

## Phase 1 validation

The boundary has been proven end-to-end on a non-production local Linux node: one-time enrollment, unique Agent identity, authenticated heartbeat, read-only telemetry, online/stale/offline detection, and recovery back to online work through the external Control Plane without inbound node management access.
