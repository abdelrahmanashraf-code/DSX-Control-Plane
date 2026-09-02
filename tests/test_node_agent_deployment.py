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


def test_phase3_provisioner_is_local_only_and_hardened() -> None:
    service = Path("deploy/node-agent/dsx-node-provisioner.service").read_text()

    assert "User=root" in service
    assert "Group=dsx-agent" in service
    assert "RestrictAddressFamilies=AF_UNIX" in service
    assert "NoNewPrivileges=true" in service
    assert "ProtectSystem=strict" in service
    assert "PrivateDevices=true" in service
    assert "CapabilityBoundingSet=" in service
    assert "CAP_SETUID" in service
    assert "CAP_SETGID" in service
    assert "ReadWritePaths=/var/lib/dsx-provisioner /var/odoo" in service
    assert "dsx-node-provisioner serve" in service
    assert "ExecStart=/bin/sh" not in service
    assert "ExecStart=/bin/bash" not in service
    assert "AF_INET" not in service


def test_phase3_provisioner_example_stays_disabled_and_test_only() -> None:
    config = Path("deploy/node-agent/dsx-provisioner.example.json").read_text()

    assert '"enabled": false' in config
    assert '"phase": "test-only"' in config
    assert '"source_database": "dsx_restaurant_demo_master"' in config
    assert "/REPLACE_AFTER_NON_PRODUCTION_SERVER_INSPECTION" in config
    assert '"allow_empty_filestore": false' in config
