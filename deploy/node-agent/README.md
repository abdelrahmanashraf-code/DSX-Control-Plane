# DSX Node Agent Deployment

The Node Agent is outbound-only in Phase 1. It sends HTTPS heartbeats to the DSX Control Plane and does not expose a management port.

## Install on a non-production Ubuntu test node

Install the Python venv prerequisite first. On Ubuntu 24.04 with Python 3.12:

```bash
sudo apt update
sudo apt install -y python3.12-venv
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
DSX_NODE_NAME=DSX-TEST-01
DSX_HEARTBEAT_SECONDS=30
DSX_REQUEST_TIMEOUT_SECONDS=10
DSX_AGENT_VERSION=0.1.0
```

## One-time enrollment

1. Create a short-lived enrollment token from the Control Plane admin API.
2. Run enrollment once without saving the token to `/etc/dsx-node-agent.env`:

```bash
sudo -u dsx-agent env \
  DSX_CONTROL_PLANE_URL=https://<control-plane-host> \
  DSX_NODE_NAME=DSX-TEST-01 \
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

## Local diagnostics

This command is read-only and never prints agent credentials:

```bash
/opt/dsx-control-plane/.venv/bin/dsx-node-agent diagnostics
```

## Phase 1 safety boundary

The agent currently supports metrics and authenticated heartbeat only. There is no endpoint for arbitrary shell commands, database creation, restart, backup, restore, deploy, or delete. Those actions are introduced only in later phases behind explicit typed operations and audit controls.
