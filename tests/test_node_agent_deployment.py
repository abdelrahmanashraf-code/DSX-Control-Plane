from pathlib import Path


def test_node_agent_service_allows_local_postgresql_without_opening_listener() -> None:
    service = Path("deploy/node-agent/dsx-node-agent.service").read_text()

    assert "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6" in service
    assert "NoNewPrivileges=true" in service
    assert "ProtectSystem=strict" in service
    assert "User=dsx-agent" in service
    assert "ExecStart=/opt/dsx-control-plane/.venv/bin/dsx-node-agent run" in service
    assert "ExecStart=/bin/sh" not in service
    assert "ExecStart=/bin/bash" not in service


def test_postgresql_inventory_role_is_passwordless_and_read_only() -> None:
    sql = Path("deploy/node-agent/postgresql-readonly.sql").read_text().upper()

    assert 'CREATE ROLE "DSX-AGENT"' in sql
    assert "NOSUPERUSER" in sql
    assert "NOCREATEDB" in sql
    assert "NOCREATEROLE" in sql
    assert "NOREPLICATION" in sql
    assert 'GRANT PG_READ_ALL_STATS TO "DSX-AGENT"' in sql
    assert "PASSWORD" not in sql
    assert "CREATE DATABASE" not in sql
    assert "DROP DATABASE" not in sql
