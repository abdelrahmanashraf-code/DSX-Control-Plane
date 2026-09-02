import json
import socket
import threading
from pathlib import Path

from dsx_node_agent.operations import execute_operation, parse_claimed_operation


def valid_claim() -> dict:
    return {
        "operation": {
            "id": "12345678-abcd-4abc-8abc-1234567890ab",
            "type": "provision_odoo_environment",
            "lease_token": "dsx_lease_12345678901234567890",
            "lease_expires_at": "2026-09-02T18:00:00+00:00",
            "payload": {
                "tenant_id": "12345678-abcd-4abc-8abc-1234567890ab",
                "tenant_slug": "demo-restaurant",
                "sector": "restaurant",
                "environment_kind": "test",
                "template_id": "template-restaurant-v1",
                "template_version": 1,
                "odoo_major": 18,
                "database_name": "dsx_restaurant_demo_restaurant_12345678",
                "modules": ["point_of_sale", "ds_pos_delivery"],
            },
        }
    }


def run_one_response(
    listener: socket.socket,
    response: dict[str, str],
    received: list[dict],
) -> None:
    connection, _ = listener.accept()
    with connection:
        stream = connection.makefile("rb")
        raw = stream.readline(16 * 1024)
        received.append(json.loads(raw.decode("utf-8")))
        connection.sendall(json.dumps(response).encode("utf-8") + b"\n")


def test_agent_sends_only_typed_payload_over_unix_socket(tmp_path: Path) -> None:
    operation = parse_claimed_operation(valid_claim())
    assert operation is not None
    socket_path = tmp_path / "provisioner.sock"
    received: list[dict] = []

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        listener.bind(str(socket_path))
        listener.listen(1)
        thread = threading.Thread(
            target=run_one_response,
            args=(
                listener,
                {"state": "ready", "database_name": operation.payload.database_name},
                received,
            ),
        )
        thread.start()
        result = execute_operation(
            operation,
            provisioner_socket=socket_path,
            timeout_seconds=2,
        )
        thread.join(timeout=2)

    assert not thread.is_alive()
    assert result.state == "ready"
    assert result.database_name == operation.payload.database_name
    assert len(received) == 1
    assert set(received[0]) == {"operation_id", "type", "payload"}
    assert "command" not in received[0]
    assert "path" not in received[0]["payload"]
    assert received[0]["type"] == "provision_odoo_environment"


def test_agent_rejects_local_database_name_mismatch(tmp_path: Path) -> None:
    operation = parse_claimed_operation(valid_claim())
    assert operation is not None
    socket_path = tmp_path / "provisioner.sock"
    received: list[dict] = []

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        listener.bind(str(socket_path))
        listener.listen(1)
        thread = threading.Thread(
            target=run_one_response,
            args=(listener, {"state": "ready", "database_name": "other_database"}, received),
        )
        thread.start()
        result = execute_operation(
            operation,
            provisioner_socket=socket_path,
            timeout_seconds=2,
        )
        thread.join(timeout=2)

    assert result.state == "failed"
    assert result.error_code == "local_provisioner_protocol_error"


def test_agent_fails_closed_when_local_socket_is_missing(tmp_path: Path) -> None:
    operation = parse_claimed_operation(valid_claim())
    assert operation is not None

    result = execute_operation(
        operation,
        provisioner_socket=tmp_path / "missing.sock",
        timeout_seconds=0.2,
    )

    assert result.state == "failed"
    assert result.error_code == "local_provisioner_unavailable"
