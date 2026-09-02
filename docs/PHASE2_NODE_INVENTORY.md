# Phase 2 Node Inventory Safety Contract

Phase 2 extends node visibility without allowing arbitrary remote administration.

## Allowed

- node role, pool, labels, and placement capacity metadata
- read-only host/runtime discovery
- read-only Odoo runtime discovery
- read-only PostgreSQL/database inventory
- health history and operational alerts
- fixed, typed Agent operations with bounded input/output
- authenticated admin actions with audit events

## Forbidden

- arbitrary shell or command execution
- returning environment variables, config file contents, passwords, tokens, or connection strings
- database creation/deletion
- Odoo restart/update/deploy
- package installation
- filesystem mutation outside the Agent's own state
- production rollout before the non-production gate passes

## Current metadata model

Each active node can carry:

- `role`: `odoo-postgres`, `odoo`, or `postgresql`
- `pool`: safe placement pool name such as `trial-egypt`
- `labels`: at most 20 bounded string labels
- `max_tenants`: optional operator capacity ceiling
- `reserved_memory_mb`: RAM reserved from placement calculations
- `reserved_disk_gb`: disk reserved from placement calculations

Metadata changes use an authenticated admin endpoint and emit `node.metadata.updated` audit events.
