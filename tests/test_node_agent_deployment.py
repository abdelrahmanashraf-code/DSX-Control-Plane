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
