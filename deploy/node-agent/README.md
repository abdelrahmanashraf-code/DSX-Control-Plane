# DSX Node Agent deployment

The Node Agent is an outbound-only service. It sends bounded node diagnostics and authenticated heartbeats to the DSX Control Plane. It does not expose a listener and it does not provide a generic remote shell.

## Node Agent

Install the repository under `/opt/dsx-control-plane`, create a dedicated `dsx-agent` system user/group, install the Python package into `/opt/dsx-control-plane/.venv`, and install `dsx-node-agent.service` under `/etc/systemd/system/`.

The service reads non-secret runtime settings from `/etc/dsx-node-agent.env` and stores the enrolled identity in `/var/lib/dsx-node-agent/identity.json` with restrictive permissions. Enrollment credentials and agent tokens must never be committed to Git.

The service is deliberately hardened with `NoNewPrivileges`, `ProtectSystem=strict`, private devices/tmp, kernel/control-group protections and no inbound listener. `AF_UNIX` is permitted so read-only PostgreSQL inventory can use the local Unix socket; `AF_INET`/`AF_INET6` are required only for outbound HTTPS heartbeats and operation polling.

### PostgreSQL inventory role

`postgresql-readonly.sql` creates the local PostgreSQL login role `dsx-agent` with `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, a small connection limit and `pg_read_all_stats`. It intentionally defines no password. On the verified non-production node the OS user `dsx-agent` connects over the local Unix socket using peer authentication. Do not weaken `pg_hba.conf` just to make inventory work.

## Typed local provisioner

Privileged local provisioning is separated from the unprivileged outbound Node Agent. The Agent can only claim the allow-listed `provision_odoo_environment` operation and forwards a strict JSON payload to a local Unix socket. It cannot send a command string, executable path, arbitrary SQL or shell fragment.

`dsx-node-provisioner.service` is the privileged local helper. It has no network address family except `AF_UNIX`, uses fixed PostgreSQL client binaries, and is restricted by systemd to the DSX provisioner state directory plus the verified Odoo filestore root.

The real non-production server inspection established the following restaurant golden-template baseline:

- source database: `dsx_restaurant_demo_master`
- database owner: `odoo`
- Odoo OS owner/group: `odoo:odoo`
- filestore root: `/var/lib/odoo/.local/share/Odoo/filestore`
- source filestore mode: `0700`
- source database installed-module count observed during inspection: 114

`dsx-provisioner.example.json` contains this verified node profile but deliberately stays `"enabled": false` and `"phase": "test-only"` in Git.

### Phase 5 trial execution gate

Trial execution is opt-in at the root-owned local provisioner boundary:

- `phase: "test-only"` allows disposable `test` environments only and rejects `trial` before PostgreSQL access.
- `phase: "trial-enabled"` allows `test` and `trial` environments for an explicitly approved non-production Trial node.
- `production` provisioning remains blocked by the local provisioner code and has no configuration switch in this phase.

Do not set `trial-enabled` on a production customer node. A Phase 5 Trial node must also be assigned to the Control Plane `trial` pool; the Trial API will not place a trial on another pool.

The approved restaurant validation baseline currently includes:

`ds_access_control`, `ds_backend_branding`, `ds_business_dashboard`, `ds_login_branding`, `ds_pos_branding`, `ds_pos_delivery`, `ds_restaurant_theme`, `ds_ui_core`, `pos_customer_then_kitchen_receipt`, `pos_restaurant`, `restaurant_pos_recipe`, and `wt_pos_access_right`.

These modules are not installed by arbitrary remote commands. The provisioning flow clones the controlled golden database and then validates that the approved baseline is installed before it can report `ready`.

### Safe installation sequence for a non-production node

1. Pull the reviewed repository revision on the non-production node and reinstall the editable Python package in `/opt/dsx-control-plane/.venv`.
2. Copy `deploy/node-agent/dsx-node-provisioner.service` to `/etc/systemd/system/`.
3. Copy `deploy/node-agent/dsx-provisioner.example.json` to `/etc/dsx-provisioner.json`, owned by root and not group/world writable.
4. Keep `enabled` set to `false` for the initial service-boundary test.
5. Reload systemd and start `dsx-node-provisioner`; verify the Unix socket exists and is accessible to `dsx-agent`.
6. For test-only acceptance, set `enabled: true` while keeping `phase: "test-only"`.
7. For the Phase 5 Trial gate only, after the node is confirmed non-production and assigned to the Control Plane `trial` pool, explicitly change the root-owned config to `phase: "trial-enabled"`, restart the provisioner, and verify the gate before creating a disposable trial.

Never put enrollment tokens, agent credentials, database passwords, DSNs, private keys or Cloudflare admin tokens into the provisioner JSON, repository, service unit or shell history.
