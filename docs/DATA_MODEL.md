# DSX Control Plane — Initial Domain Model

## 1. Design rule

The model must separate business identity, tenant runtime, subscription entitlement, infrastructure placement, and financial records. Do not overload one record to represent all of them.

## 2. Customer

`customer`

Represents the DSX platform customer/account.

Core fields:
- id (UUID/internal stable ID)
- display_name
- legal_name (optional)
- phone
- email
- country
- status
- source / campaign metadata
- central_odoo_partner_id (integration reference, not master identity)
- created_at / updated_at

Relationships:
- one customer -> many tenants
- one customer -> many subscriptions over time
- one customer -> many payment proof submissions
- one customer -> many support/onboarding records later

## 3. Tenant

`tenant`

The most important runtime entity. Represents one isolated customer environment/database.

Core fields:
- id
- customer_id
- code
- name
- environment: trial | production | staging/internal
- lifecycle_state
- node_id
- database_name (internal, never exposed publicly where not needed)
- public_hostname
- template_id
- release_id
- size_class
- infrastructure_state
- health_state
- created_at
- ready_at
- suspended_at
- archived_at
- purge_after

Suggested lifecycle states:

```text
REQUESTED
QUEUED
PROVISIONING
READY
ACTIVE
PROVISION_FAILED
SUSPENDED
ARCHIVED
PURGE_PENDING
DELETED
```

Tenant lifecycle state must not be inferred only from subscription state.

## 4. Node

`node`

Represents one DSX-managed server/cell.

Core fields:
- id
- name
- provider
- provider_resource_id
- environment_pool: trial | production | mixed/internal
- public_ip / private address metadata
- status: registering | online | warning | offline | draining | maintenance
- agent_identity
- last_heartbeat_at
- cpu_capacity
- memory_capacity
- disk_capacity
- current capacity summaries
- tenant_count
- created_at

Placement must ignore nodes in offline/draining/maintenance states.

## 5. Plan

`plan`

Commercial product definition.

Core fields:
- id
- code
- name
- active
- base_price
- currency
- billing_period
- default_billing_grace_days
- connectivity_grace policy reference
- limits/entitlements JSON or normalized feature records

Do not hard-code 500 EGP in infrastructure or subscription logic. Pricing is configuration.

## 6. Subscription

`subscription`

Controls commercial entitlement for a customer/tenant scope.

Initial model recommendation: one subscription targets one primary tenant; design references should permit multi-tenant/customer-level packaging later without schema destruction.

Core fields:
- id
- customer_id
- tenant_id
- plan_id
- status
- starts_at
- current_period_start
- current_period_end
- billing_grace_end
- cancelled_at
- central_odoo_invoice_id / external references
- last_payment_state
- entitlement_version

Suggested effective states:

```text
DRAFT
PENDING_ACTIVATION
ACTIVE
EXPIRING
PAST_DUE
GRACE
SUSPENDED
CANCELLED
```

The platform computes access entitlement from subscription/business policy, then issues a signed entitlement to the tenant agent.

## 7. Entitlement

`entitlement_issuance`

Immutable/auditable record of what was issued to a tenant agent.

Core fields:
- id
- subscription_id
- tenant_id
- version
- issued_at
- valid_until
- connectivity_grace_until
- key/signing reference
- payload hash
- delivery status

Never persist private signing keys in ordinary application records/logs.

## 8. Template

`template`

Approved source for standard tenant provisioning.

Core fields:
- id
- code
- name
- sector: restaurant | cafe | retail | supermarket | general
- odoo_version
- DSX release compatibility
- storage reference / snapshot metadata
- status: draft | validating | approved | retired
- checksum/version

Only approved templates can provision normal tenants.

## 9. Release

`release`

Immutable product/runtime release metadata.

Core fields:
- id
- version
- status
- git/source references
- module manifest/checksums
- created_at
- approved_at
- rollout_stage

A tenant points to the release it is expected to run. Observed agent/runtime version is tracked separately so drift is visible.

## 10. Provision Job

`job`

Durable async operation record.

Core fields:
- id
- job_type
- tenant_id/node_id where applicable
- idempotency_key
- status: queued | running | retry_wait | failed | succeeded | cancelled
- attempt_count
- current_step
- requested_by
- requested_at / started_at / finished_at
- safe error category/message

`job_step`
- job_id
- step_name
- status
- attempt_count
- started_at / finished_at
- safe output metadata

No secrets in job output.

## 11. Backup

`backup`

Core fields:
- id
- tenant_id
- type: scheduled | manual | pre_upgrade | pre_restore
- status
- started_at / completed_at
- object storage reference
- database artifact checksum
- filestore artifact checksum
- retention_until
- verified_restore_at (optional)

## 12. Payment Proof

`payment_proof`

For manual payment workflows such as bank transfer / InstaPay.

Core fields:
- id
- customer_id
- subscription_id
- amount
- currency
- method
- reference
- attachment storage reference
- status: pending | approved | rejected | matched
- reviewed_by / reviewed_at
- central_odoo_payment_id

Approving a proof is a business event; infrastructure activation follows only after the platform receives/derives a valid paid state.

## 13. Audit Log

`audit_event`

Append-oriented history for sensitive operations.

Core fields:
- id
- actor_type: user | service | system
- actor_id
- action
- resource_type
- resource_id
- request/correlation ID
- safe before/after summary
- result
- timestamp
- source IP/service metadata where appropriate

Required for provisioning, suspension/reactivation, restore, release deployment, archive, purge, entitlement changes, and sensitive configuration changes.

## 14. Health / observation model

Do not overwrite desired state with observed state.

Examples:
- desired release != observed release -> drift warning
- desired tenant state ACTIVE + observed Odoo down -> health incident
- subscription ACTIVE + agent heartbeat stale -> attention item, not immediate billing suspension

This desired-vs-observed separation is mandatory for reliable operations.

## 15. Needs Attention

Prefer deriving attention items from domain conditions/events initially rather than making staff inspect every entity.

Examples:
- failed provisioning job
- node heartbeat stale
- backup failed
- disk capacity warning
- payment proof pending too long
- subscription reconciliation mismatch
- desired/observed release drift
- entitlement delivery failure

The daily operational UX is built around these exceptions.
