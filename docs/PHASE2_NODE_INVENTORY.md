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

## Runtime inventory implementation

The Node Agent heartbeat now includes a bounded `runtime_inventory` object inside the existing metrics payload.

It reports only:

- whether Odoo/PostgreSQL processes are present and their process counts
- best-effort Odoo/PostgreSQL version strings from fixed local `--version` probes
- PostgreSQL server version when a local read-only inventory query is allowed
- visible non-template database names and sizes, capped at 500 databases

The PostgreSQL inventory uses a fixed `psql` argument list with `--no-password`, `-X`, a sanitized environment, a fixed SQL statement, output limits, a short timeout, and a five-minute cache. It never invokes a shell and never returns stderr, passwords, DSNs, config files, environment variables, or connection strings.

If PostgreSQL access is unavailable, the Agent returns only a bounded reason code such as `postgresql_access_unavailable`; it does not return the underlying authentication or connection error.
