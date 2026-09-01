# DSX Control Plane — Working Rules

These rules exist to stop scope drift, unsafe shortcuts, and architecture erosion during implementation.

## 1. Phase discipline

Only work required by the current phase acceptance criteria belongs in the active implementation scope.

New ideas go to backlog unless they block the current phase.

## 2. No production-first development

New infrastructure logic must be proven on a non-production node/tenant before touching customer production workloads.

## 3. No manual-success definition

A workflow is not considered automated if the normal path still requires:
- SSH;
- direct PostgreSQL work;
- manual module installation;
- manual routing edits;
- manual license activation;
- undocumented server commands.

Emergency/manual recovery may exist, but it must be explicit, restricted, and documented.

## 4. No arbitrary remote shell

The platform and Node Agent must not expose a generic command-execution endpoint.

Every infrastructure operation must be a named operation with validated parameters and authorization.

## 5. Idempotency before scale

Any operation that can be retried by a user, queue, timeout, webhook, or network failure must define its idempotency behavior before release.

Examples:
- create tenant;
- payment confirmation;
- entitlement issuance;
- backup request;
- release deployment.

## 6. Desired state vs observed state

Never treat a desired configuration as proof that the runtime actually matches it.

Examples:
- desired release and observed release are separate;
- desired ACTIVE tenant and observed unhealthy runtime are separate;
- subscription state and infrastructure state are separate.

## 7. Financial truth stays in Central Odoo

Do not duplicate accounting logic in Control Plane.

Control Plane may store references and operational payment/subscription state, but invoice/payment accounting truth belongs to Central Odoo.

## 8. SaaS operational truth stays in Control Plane

Do not make a customer Odoo database or Central Odoo the sole source of truth for:
- tenant placement;
- node assignment;
- provisioning job state;
- release assignment;
- subscription entitlement;
- operational backup/health state.

## 9. A paying customer must not depend on permanent central connectivity

Signed entitlement caching/connectivity grace must be designed before broad subscription enforcement rollout.

A Control Plane outage is an operational incident, not an automatic reason to lock every customer.

## 10. Suspension is reversible; deletion is exceptional

Normal unpaid lifecycle:

```text
ACTIVE -> PAST_DUE -> GRACE -> SUSPENDED
```

Destructive lifecycle:

```text
SUSPENDED -> ARCHIVED -> PURGE_PENDING -> DELETED
```

Retention and audit rules apply before purge.

## 11. Backup means restorable

No production phase is accepted based only on successful backup jobs. Restore must be demonstrated and documented.

## 12. Releases are immutable

Do not silently mutate an already-approved release definition. Create a new release version.

## 13. Standard customer setup belongs in templates/automation

If implementation repeats the same manual configuration for multiple customers, it becomes a template/configuration/provisioning requirement.

Custom business requirements remain explicit implementation work and must not contaminate the standard template without product approval.

## 14. Secrets policy

Never commit or log:
- passwords;
- private signing keys;
- SSH private keys;
- payment secrets;
- database superuser credentials;
- object-storage secret keys;
- long-lived node enrollment secrets.

Use environment/secret management and redact sensitive outputs.

## 15. Audit sensitive actions

At minimum audit:
- node enrollment/revocation;
- tenant provision;
- suspend/reactivate;
- entitlement changes;
- backup/restore;
- release deployment;
- archive/purge;
- payment-proof approval/rejection;
- privileged configuration changes.

## 16. Keep architecture simple until evidence demands complexity

Do not add Kubernetes, Kafka, service mesh, or many microservices because they are fashionable.

Start with clear boundaries in a small number of deployable components. Split only when operational evidence requires it.

## 17. Cost awareness is a product constraint

Architecture decisions must consider DSX's low monthly subscription price. Prefer safe shared-node efficiency for small tenants while preserving database isolation.

## 18. Exception-driven UX

The main operations dashboard must prioritize `Needs Attention`, not force operators to inspect thousands of healthy tenants.

## 19. Every risky action needs a recovery story

Before releasing a destructive or high-impact action, document:
- failure states;
- retry rules;
- rollback/recovery;
- audit behavior;
- operator message.

## 20. Direction changes require an ADR

Any decision that materially changes ownership boundaries, tenant isolation, subscription truth, billing truth, provider abstraction, security model, or infrastructure topology must be recorded in `docs/decisions/` before implementation.
