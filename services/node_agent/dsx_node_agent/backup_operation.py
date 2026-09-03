from __future__ import annotations

import json
import re
import socket
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from dsx_node_agent.operations import OperationExecutionResult, OperationProtocolError

_BACKUP_OPERATION = "backup_odoo_environment"
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_DATABASE = re.compile(r"^[a-z][a-z0-9_]{2,62}$")
_SAFE_CODE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,119}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MAX_LOCAL_RESPONSE_BYTES = 8 * 1024
_ARTIFACT_KINDS = {"database_dump", "filestore_archive", "manifest"}


@dataclass(frozen=True)
class BackupEnvironmentPayload:
    tenant_id: str
    environment_kind: str
    template_id: str
    provisioning_operation_id: str
    database_name: str
    backup_type: str


@dataclass(frozen=True)
class BackupClaimedOperation:
    operation_id: str
    operation_type: str
    lease_token: str
    lease_expires_at: str
    payload: BackupEnvironmentPayload


@dataclass(frozen=True)
class BackupExecutionResult(OperationExecutionResult):
    backup_artifacts: tuple[dict[str, object], ...] | None = None
    manifest_sha256: str | None = None
    total_size_bytes: int | None = None


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


def parse_backup_claimed_operation(response_payload: Any) -> BackupClaimedOperation | None:
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
    if operation_type != _BACKUP_OPERATION:
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
        "backup_type",
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
        raise OperationProtocolError("backup_non_test_environment_blocked")
    database_name = _string(payload["database_name"], max_length=63, field="database_name").lower()
    if not _SAFE_DATABASE.fullmatch(database_name):
        raise OperationProtocolError("invalid_database_name")
    backup_type = _string(payload["backup_type"], max_length=32, field="backup_type").lower()
    if backup_type != "full":
        raise OperationProtocolError("unsupported_backup_type")

    return BackupClaimedOperation(
        operation_id=operation_id,
        operation_type=operation_type,
        lease_token=lease_token,
        lease_expires_at=lease_expires_at,
        payload=BackupEnvironmentPayload(
            tenant_id=tenant_id,
            environment_kind=environment_kind,
            template_id=template_id,
            provisioning_operation_id=provisioning_operation_id,
            database_name=database_name,
            backup_type=backup_type,
        ),
    )


def _local_request(operation: BackupClaimedOperation) -> dict[str, Any]:
    return {
        "operation_id": operation.operation_id,
        "type": operation.operation_type,
        "payload": {
            "tenant_id": operation.payload.tenant_id,
            "environment_kind": operation.payload.environment_kind,
            "template_id": operation.payload.template_id,
            "provisioning_operation_id": operation.payload.provisioning_operation_id,
            "database_name": operation.payload.database_name,
            "backup_type": operation.payload.backup_type,
        },
    }


def _integer(value: Any, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise OperationProtocolError(f"invalid_{field}")
    return value


def _parse_artifacts(value: Any) -> tuple[dict[str, object], ...]:
    if not isinstance(value, list) or len(value) != 3:
        raise OperationProtocolError("invalid_backup_artifacts")
    parsed: list[dict[str, object]] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            raise OperationProtocolError("invalid_backup_artifact")
        _exact(item, {"artifact_kind", "file_name", "size_bytes", "sha256"}, field="backup_artifact")
        kind = _string(item["artifact_kind"], max_length=32, field="artifact_kind")
        if kind not in _ARTIFACT_KINDS or kind in seen:
            raise OperationProtocolError("invalid_artifact_kind")
        seen.add(kind)
        file_name = _string(item["file_name"], max_length=64, field="file_name")
        expected_name = {
            "database_dump": "database.dump",
            "filestore_archive": "filestore.tar.gz",
            "manifest": "manifest.json",
        }[kind]
        if file_name != expected_name:
            raise OperationProtocolError("invalid_artifact_file_name")
        size_bytes = _integer(item["size_bytes"], field="artifact_size_bytes")
        checksum = _string(item["sha256"], max_length=64, field="artifact_sha256").lower()
        if not _SHA256.fullmatch(checksum):
            raise OperationProtocolError("invalid_artifact_sha256")
        parsed.append(
            {
                "artifact_kind": kind,
                "size_bytes": size_bytes,
                "sha256": checksum,
            }
        )
    if seen != _ARTIFACT_KINDS:
        raise OperationProtocolError("invalid_backup_artifacts")
    return tuple(parsed)


def _parse_local_result(value: Any) -> BackupExecutionResult:
    if not isinstance(value, dict):
        raise OperationProtocolError("invalid_local_provisioner_response")
    state = value.get("state")
    if state == "prepared":
        _exact(
            value,
            {"state", "manifest_sha256", "total_size_bytes", "artifacts"},
            field="local_backup_prepared_response",
        )
        manifest_sha256 = _string(
            value["manifest_sha256"], max_length=64, field="manifest_sha256"
        ).lower()
        if not _SHA256.fullmatch(manifest_sha256):
            raise OperationProtocolError("invalid_manifest_sha256")
        total_size_bytes = _integer(value["total_size_bytes"], field="total_size_bytes")
        artifacts = _parse_artifacts(value["artifacts"])
        if sum(int(item["size_bytes"]) for item in artifacts) != total_size_bytes:
            raise OperationProtocolError("backup_total_size_mismatch")
        manifest = next(item for item in artifacts if item["artifact_kind"] == "manifest")
        if manifest["sha256"] != manifest_sha256:
            raise OperationProtocolError("backup_manifest_checksum_mismatch")
        return BackupExecutionResult(
            state="prepared",
            backup_artifacts=artifacts,
            manifest_sha256=manifest_sha256,
            total_size_bytes=total_size_bytes,
        )
    if state == "failed":
        _exact(value, {"state", "error_code"}, field="local_failed_response")
        error_code = _string(value["error_code"], max_length=120, field="error_code")
        if not _SAFE_CODE.fullmatch(error_code):
            raise OperationProtocolError("invalid_local_error_code")
        return BackupExecutionResult(state="failed", error_code=error_code)
    raise OperationProtocolError("invalid_local_provisioner_state")


def execute_backup_operation(
    operation: BackupClaimedOperation,
    *,
    provisioner_socket: Path | None,
    timeout_seconds: float,
) -> BackupExecutionResult:
    if provisioner_socket is None:
        return BackupExecutionResult(state="failed", error_code="backup_executor_not_ready")
    encoded = json.dumps(_local_request(operation), separators=(",", ":")).encode("utf-8") + b"\n"
    if len(encoded) > 16 * 1024:
        return BackupExecutionResult(state="failed", error_code="local_request_too_large")

    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout_seconds)
            client.connect(str(provisioner_socket))
            client.sendall(encoded)
            with client.makefile("rb") as stream:
                raw = stream.readline(_MAX_LOCAL_RESPONSE_BYTES + 1)
    except (OSError, TimeoutError):
        return BackupExecutionResult(state="failed", error_code="local_provisioner_unavailable")

    if len(raw) > _MAX_LOCAL_RESPONSE_BYTES or not raw.endswith(b"\n"):
        return BackupExecutionResult(state="failed", error_code="local_provisioner_protocol_error")
    try:
        return _parse_local_result(json.loads(raw.decode("utf-8")))
    except (UnicodeDecodeError, json.JSONDecodeError, OperationProtocolError):
        return BackupExecutionResult(state="failed", error_code="local_provisioner_protocol_error")
