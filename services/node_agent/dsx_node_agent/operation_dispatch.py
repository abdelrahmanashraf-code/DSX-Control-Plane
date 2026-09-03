from __future__ import annotations

import json
import re
import socket
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from dsx_node_agent.backup_operation import (
    BackupClaimedOperation,
    execute_backup_operation,
    parse_backup_claimed_operation,
)
from dsx_node_agent.operations import (
    ClaimedOperation,
    OperationExecutionResult,
    OperationProtocolError,
    execute_operation,
    parse_claimed_operation,
)

_CLEANUP_OPERATION = "cleanup_test_odoo_environment"
_PROVISION_OPERATION = "provision_odoo_environment"
_BACKUP_OPERATION = "backup_odoo_environment"
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_DATABASE = re.compile(r"^[a-z][a-z0-9_]{2,62}$")
_SAFE_CODE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,119}$")
_MAX_LOCAL_RESPONSE_BYTES = 8 * 1024


@dataclass(frozen=True)
class CleanupEnvironmentPayload:
    tenant_id: str
    environment_kind: str
    template_id: str
    provisioning_operation_id: str
    database_name: str


@dataclass(frozen=True)
class CleanupClaimedOperation:
    operation_id: str
    operation_type: str
    lease_token: str
    lease_expires_at: str
    payload: CleanupEnvironmentPayload


type AnyClaimedOperation = ClaimedOperation | CleanupClaimedOperation | BackupClaimedOperation


def _string(value: Any, *, max_length: int, field: str) -> str:
    if not isinstance(value, str):
        raise OperationProtocolError(f"invalid_{field}")
    result = value.strip()
    if not result or len(result) > max_length:
        raise OperationProtocolError(f"invalid_{field}")
    return result


def _exact(data: dict[str, Any], expected: set[str], *, field: str) -> None:
    if set(data) != expected:
        raise OperationProtocolError(f"invalid_{field}_fields")


def _parse_cleanup_claim(response_payload: Any) -> CleanupClaimedOperation | None:
    if not isinstance(response_payload, dict):
        raise OperationProtocolError("invalid_claim_response")
    _exact(response_payload, {"operation"}, field="claim_response")
    operation = response_payload["operation"]
    if operation is None:
        return None
    if not isinstance(operation, dict):
        raise OperationProtocolError("invalid_operation")
    _exact(
        operation,
        {"id", "type", "lease_token", "lease_expires_at", "payload"},
        field="operation",
    )

    operation_id = _string(operation["id"], max_length=64, field="operation_id")
    if not _SAFE_ID.fullmatch(operation_id):
        raise OperationProtocolError("invalid_operation_id")
    operation_type = _string(operation["type"], max_length=64, field="operation_type")
    if operation_type != _CLEANUP_OPERATION:
        raise OperationProtocolError("unsupported_operation_type")
    lease_token = _string(operation["lease_token"], max_length=256, field="lease_token")
    if len(lease_token) < 16:
        raise OperationProtocolError("invalid_lease_token")
    lease_expires_at = _string(
        operation["lease_expires_at"], max_length=64, field="lease_expires_at"
    )
    try:
        datetime.fromisoformat(lease_expires_at)
    except ValueError as exc:
        raise OperationProtocolError("invalid_lease_expires_at") from exc

    payload = operation["payload"]
    expected = {
        "tenant_id",
        "environment_kind",
        "template_id",
        "provisioning_operation_id",
        "database_name",
    }
    if not isinstance(payload, dict):
        raise OperationProtocolError("invalid_operation_payload")
    _exact(payload, expected, field="operation_payload")

    tenant_id = _string(payload["tenant_id"], max_length=64, field="tenant_id")
    template_id = _string(payload["template_id"], max_length=96, field="template_id")
    provisioning_operation_id = _string(
        payload["provisioning_operation_id"],
        max_length=64,
        field="provisioning_operation_id",
    )
    for field, value in (
        ("tenant_id", tenant_id),
        ("template_id", template_id),
        ("provisioning_operation_id", provisioning_operation_id),
    ):
        if not _SAFE_ID.fullmatch(value):
            raise OperationProtocolError(f"invalid_{field}")

    environment_kind = _string(
        payload["environment_kind"], max_length=32, field="environment_kind"
    ).lower()
    if environment_kind != "test":
        raise OperationProtocolError("cleanup_non_test_environment_blocked")
    database_name = _string(payload["database_name"], max_length=63, field="database_name").lower()
    if not _SAFE_DATABASE.fullmatch(database_name):
        raise OperationProtocolError("invalid_database_name")

    return CleanupClaimedOperation(
        operation_id=operation_id,
        operation_type=operation_type,
        lease_token=lease_token,
        lease_expires_at=lease_expires_at,
        payload=CleanupEnvironmentPayload(
            tenant_id=tenant_id,
            environment_kind=environment_kind,
            template_id=template_id,
            provisioning_operation_id=provisioning_operation_id,
            database_name=database_name,
        ),
    )


def parse_any_claimed_operation(response_payload: Any) -> AnyClaimedOperation | None:
    if not isinstance(response_payload, dict):
        raise OperationProtocolError("invalid_claim_response")
    operation = response_payload.get("operation")
    if operation is None:
        return parse_claimed_operation(response_payload)
    if not isinstance(operation, dict):
        raise OperationProtocolError("invalid_operation")
    operation_type = operation.get("type")
    if operation_type == _PROVISION_OPERATION:
        return parse_claimed_operation(response_payload)
    if operation_type == _CLEANUP_OPERATION:
        return _parse_cleanup_claim(response_payload)
    if operation_type == _BACKUP_OPERATION:
        return parse_backup_claimed_operation(response_payload)
    raise OperationProtocolError("unsupported_operation_type")


def _cleanup_local_request(operation: CleanupClaimedOperation) -> dict[str, Any]:
    return {
        "operation_id": operation.operation_id,
        "type": operation.operation_type,
        "payload": {
            "tenant_id": operation.payload.tenant_id,
            "environment_kind": operation.payload.environment_kind,
            "template_id": operation.payload.template_id,
            "provisioning_operation_id": operation.payload.provisioning_operation_id,
            "database_name": operation.payload.database_name,
        },
    }


def _parse_cleanup_local_result(value: Any) -> OperationExecutionResult:
    if not isinstance(value, dict):
        raise OperationProtocolError("invalid_local_provisioner_response")
    state = value.get("state")
    if state == "cleaned":
        _exact(value, {"state"}, field="local_cleaned_response")
        return OperationExecutionResult(state="cleaned")
    if state == "failed":
        _exact(value, {"state", "error_code"}, field="local_failed_response")
        error_code = _string(value["error_code"], max_length=120, field="error_code")
        if not _SAFE_CODE.fullmatch(error_code):
            raise OperationProtocolError("invalid_local_error_code")
        return OperationExecutionResult(state="failed", error_code=error_code)
    raise OperationProtocolError("invalid_local_provisioner_state")


def _execute_cleanup(
    operation: CleanupClaimedOperation,
    *,
    provisioner_socket: Path | None,
    timeout_seconds: float,
) -> OperationExecutionResult:
    if provisioner_socket is None:
        return OperationExecutionResult(state="failed", error_code="cleanup_executor_not_ready")
    encoded = json.dumps(_cleanup_local_request(operation), separators=(",", ":")).encode("utf-8") + b"\n"
    if len(encoded) > 16 * 1024:
        return OperationExecutionResult(state="failed", error_code="local_request_too_large")

    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout_seconds)
            client.connect(str(provisioner_socket))
            client.sendall(encoded)
            with client.makefile("rb") as stream:
                raw = stream.readline(_MAX_LOCAL_RESPONSE_BYTES + 1)
    except (OSError, TimeoutError):
        return OperationExecutionResult(state="failed", error_code="local_provisioner_unavailable")

    if len(raw) > _MAX_LOCAL_RESPONSE_BYTES or not raw.endswith(b"\n"):
        return OperationExecutionResult(state="failed", error_code="local_provisioner_protocol_error")
    try:
        return _parse_cleanup_local_result(json.loads(raw.decode("utf-8")))
    except (UnicodeDecodeError, json.JSONDecodeError, OperationProtocolError):
        return OperationExecutionResult(state="failed", error_code="local_provisioner_protocol_error")


def execute_any_operation(
    operation: AnyClaimedOperation,
    *,
    provisioner_socket: Path | None = None,
    timeout_seconds: float = 1800.0,
) -> OperationExecutionResult:
    if isinstance(operation, CleanupClaimedOperation):
        return _execute_cleanup(
            operation,
            provisioner_socket=provisioner_socket,
            timeout_seconds=timeout_seconds,
        )
    if isinstance(operation, BackupClaimedOperation):
        return execute_backup_operation(
            operation,
            provisioner_socket=provisioner_socket,
            timeout_seconds=timeout_seconds,
        )
    return execute_operation(
        operation,
        provisioner_socket=provisioner_socket,
        timeout_seconds=timeout_seconds,
    )
