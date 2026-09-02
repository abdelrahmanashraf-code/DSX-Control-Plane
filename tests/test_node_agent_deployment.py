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
    raw_sql = Path("deploy/node-agent/postgresql-readonly.sql").read_text()
    sql = raw_sql.upper()
    executable_sql = "\n".join(
        line for line in sql.splitlines() if not line.lstrip().startswith("--")
    )

    assert 'CREATE ROLE "DSX-AGENT"' in executable_sql
    assert "NOSUPERUSER" in executable_sql
    assert "NOCREATEDB" in executable_sql
    assert "NOCREATEROLE" in executable_sql
    assert "NOREPLICATION" in executable_sql
    assert 'GRANT PG_READ_ALL_STATS TO "DSX-AGENT"' in executable_sql
    assert "PASSWORD" not in executable_sql
    assert "CREATE DATABASE" not in executable_sql
    assert "DROP DATABASE" not in executable_sql
