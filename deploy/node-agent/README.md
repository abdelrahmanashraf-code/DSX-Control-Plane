# DSX Node Agent Deployment

The Node Agent is outbound-only. It sends HTTPS heartbeats to the DSX Control Plane and does not expose a management port or arbitrary shell endpoint.

## Install on a non-production Ubuntu test node

Install the Python venv prerequisite first. On Ubuntu 24.04 with Python 3.12:

```bash
sudo apt update
sudo apt install -y python3.12-venv git
```

Then install the agent:

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin dsx-agent || true
sudo mkdir -p /opt/dsx-control-plane
sudo chown "$USER":"$USER" /opt/dsx-control-plane

git clone https://github.com/abdelrahmanashraf-code/DSX-Control-Plane.git /opt/dsx-control-plane
cd /opt/dsx-control-plane
python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install .
```

If the repository is already cloned, do not clone it again. Remove only the failed `.venv`, install `python3.12-venv`, and recreate the virtual environment.

Create `/etc/dsx-node-agent.env` owned by root and mode `0600`:

```text
DSX_CONTROL_PLANE_URL=https://<control-plane-host>
DSX_NODE_NAME=DSX-TEST-SERVER-01
DSX_HEARTBEAT_SECONDS=30
DSX_REQUEST_TIMEOUT_SECONDS=10
DSX_AGENT_VERSION=0.1.0
```

## Read-only PostgreSQL inventory

For a native Ubuntu PostgreSQL node using the normal local `peer` authentication rule, create the dedicated local inventory role:

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 -f /opt/dsx-control-plane/deploy/node-agent/postgresql-readonly.sql
```

The role is intentionally named `dsx-agent` to match the Linux service user for peer authentication. It has no password and is explicitly `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, and `NOREPLICATION`. It receives only the built-in `pg_read_all_stats` membership needed for bounded database names/sizes and PostgreSQL runtime visibility.

If the PostgreSQL host does not use compatible local peer authentication, do not weaken `pg_hba.conf` just for the Agent. Database inventory should remain unavailable until a provider-specific read-only adapter is introduced.

## One-time enrollment

1. Create a short-lived enrollment token from the Control Plane admin API.
2. Run enrollment once without saving the token to `/etc/dsx-node-agent.env`:

```bash
sudo -u dsx-agent env \
  DSX_CONTROL_PLANE_URL=https://<control-plane-host> \
  DSX_NODE_NAME=DSX-TEST-SERVER-01 \
  DSX_AGENT_STATE_FILE=/var/lib/dsx-node-agent/identity.json \
  DSX_ENROLLMENT_TOKEN='<one-time-token>' \
  /opt/dsx-control-plane/.venv/bin/dsx-node-agent enroll
```

The resulting identity file is stored with mode `0600`. The one-time enrollment token should then be discarded.

## Install service

```bash
sudo cp deploy/node-agent/dsx-node-agent.service /etc/systemd/system/
sudo chmod 600 /etc/dsx-node-agent.env
sudo systemctl daemon-reload
sudo systemctl enable --now dsx-node-agent
sudo systemctl status dsx-node-agent
```

The service permits `AF_UNIX` only so it can use the local PostgreSQL socket, plus outbound IPv4/IPv6 for HTTPS heartbeats. It still exposes no listener or management port.

## Local diagnostics

This command is read-only and never prints agent credentials:

```bash
/opt/dsx-control-plane/.venv/bin/dsx-node-agent diagnostics
```

Phase 2 diagnostics include safe runtime/database inventory when local PostgreSQL peer access is available. Raw process command lines, config contents, environment variables, passwords, tokens, DSNs, and PostgreSQL stderr are not returned.

## Safety boundary

There is no endpoint for arbitrary shell commands, database creation/deletion, restart, backup, restore, deploy, package installation, or customer data reads. Later privileged operations must be fixed/typed, authenticated, audited, and proven on non-production first.
