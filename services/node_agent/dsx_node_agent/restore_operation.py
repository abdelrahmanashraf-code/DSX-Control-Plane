from __future__ import annotations

import hashlib
import json
import re
import shutil
import socket
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import boto3
from botocore.config import Config

from dsx_node_agent.operations import OperationExecutionResult, OperationProtocolError
from dsx_node_agent.settings import AgentSettings

_RESTORE_OPERATION = "restore_verified_backup"
_LOCAL_RESTORE_OPERATION = "restore_verified_backup"
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_DATABASE = re.compile(r"^[a-z][a-z0-9_]{2,62}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MAX_LOCAL_RESPONSE_BYTES = 8 * 1024
_RESTORE_INBOX_ROOT = Path("/var/lib/dsx-node-agent/restores")
_ARTIFACT_FILES = {
    "database_dump": "database.dump",
    "filestore_archive": "filestore.tar.gz",
    "manifest": "manifest.json",
}


@dataclass(frozen=True)
class RestoreArtifact:
    artifact_kind: str
    object_key: str
    object_version: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class RestorePayload:
    backup_job_id: str
    source_tenant_id: str
    target_tenant_id: str
    environment_kind: str
    template_id: str
    source_provisioning_operation_id: str
    source_database_name: str
    target_database_name: str
    manifest_sha256: str
    total_size_bytes: int
    artifacts: tuple[RestoreArtifact, ...]


@dataclass(frozen=True)
class RestoreClaimedOperation:
    operation_id: str
    operation_type: str
    lease_token: str
    lease_expires_at: str
    payload: RestorePayload


@dataclass(frozen=True)
class RestoreExecutionResult(OperationExecutionResult):
    pass


def _string(value: Any, *, field: str, max_length: int) -> str:
    if not isinstance(value, str):
        raise OperationProtocolError(f"invalid_{field}")
    parsed = value.strip()
    if not parsed or len(parsed) > max_length:
        raise OperationProtocolError(f"invalid_{field}")
    return parsed


def _integer(value: Any, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise OperationProtocolError(f"invalid_{field}")
    return value


def _exact(value: dict[str, Any], expected: set[str], *, field: str) -> None:
    if set(value) != expected:
        raise OperationProtocolError(f"invalid_{field}_fields")


def _parse_artifacts(value: Any, source_tenant_id: str, backup_job_id: str) -> tuple[RestoreArtifact, ...]:
    if not isinstance(value, list) or len(value) != 3:
        raise OperationProtocolError("invalid_restore_artifacts")
    parsed: list[RestoreArtifact] = []
    seen: set[str] = set()
    for raw in value:
        if not isinstance(raw, dict):
            raise OperationProtocolError("invalid_restore_artifact")
        _exact(
            raw,
            {"artifact_kind", "object_key", "object_version", "size_bytes", "sha256"},
            field="restore_artifact",
        )
        kind = _string(raw["artifact_kind"], field="artifact_kind", max_length=32)
        if kind not in _ARTIFACT_FILES or kind in seen:
            raise OperationProtocolError("invalid_artifact_kind")
        object_key = _string(raw["object_key"], field="object_key", max_length=512)
        expected_key = f"test/{source_tenant_id}/{backup_job_id}/{_ARTIFACT_FILES[kind]}"
        if object_key != expected_key:
            raise OperationProtocolError("restore_object_key_mismatch")
        object_version = _string(raw["object_version"], field="object_version", max_length=256)
        checksum = _string(raw["sha256"], field="artifact_sha256", max_length=64).lower()
        if not _SHA256.fullmatch(checksum):
            raise OperationProtocolError("invalid_artifact_sha256")
        parsed.append(
            RestoreArtifact(
                artifact_kind=kind,
                object_key=object_key,
                object_version=object_version,
                size_bytes=_integer(raw["size_bytes"], field="artifact_size_bytes"),
                sha256=checksum,
            )
        )
        seen.add(kind)
    if seen != set(_ARTIFACT_FILES):
        raise OperationProtocolError("invalid_restore_artifacts")
    return tuple(parsed)


def parse_restore_claimed_operation(response_payload: Any) -> RestoreClaimedOperation | None:
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

    operation_id = _string(operation["id"], field="operation_id", max_length=64)
    if not _SAFE_ID.fullmatch(operation_id):
        raise OperationProtocolError("invalid_operation_id")
    operation_type = _string(operation["type"], field="operation_type", max_length=64)
    if operation_type != _RESTORE_OPERATION:
        raise OperationProtocolError("unsupported_operation_type")
    lease_token = _string(operation["lease_token"], field="lease_token", max_length=256)
    if len(lease_token) < 16:
        raise OperationProtocolError("invalid_lease_token")
    lease_expires_at = _string(operation["lease_expires_at"], field="lease_expires_at", max_length=64)
    try:
        datetime.fromisoformat(lease_expires_at)
    except ValueError as exc:
        raise OperationProtocolError("invalid_lease_expires_at") from exc

    payload = operation["payload"]
    if not isinstance(payload, dict):
        raise OperationProtocolError("invalid_operation_payload")
    _exact(
        payload,
        {
            "backup_job_id",
            "source_tenant_id",
            "target_tenant_id",
            "environment_kind",
            "template_id",
            "source_provisioning_operation_id",
            "source_database_name",
            "target_database_name",
            "manifest_sha256",
            "total_size_bytes",
            "artifacts",
        },
        field="operation_payload",
    )

    ids: dict[str, str] = {}
    for field in (
        "backup_job_id",
        "source_tenant_id",
        "target_tenant_id",
        "template_id",
        "source_provisioning_operation_id",
    ):
        item = _string(payload[field], field=field, max_length=96 if field == "template_id" else 64)
        if not _SAFE_ID.fullmatch(item):
            raise OperationProtocolError(f"invalid_{field}")
        ids[field] = item
    if ids["source_tenant_id"] == ids["target_tenant_id"]:
        raise OperationProtocolError("restore_target_must_be_disposable")

    environment_kind = _string(
        payload["environment_kind"], field="environment_kind", max_length=32
    ).lower()
    if environment_kind != "test":
        raise OperationProtocolError("restore_non_test_environment_blocked")

    source_database_name = _string(
        payload["source_database_name"], field="source_database_name", max_length=63
    ).lower()
    target_database_name = _string(
        payload["target_database_name"], field="target_database_name", max_length=63
    ).lower()
    if not _SAFE_DATABASE.fullmatch(source_database_name) or not _SAFE_DATABASE.fullmatch(target_database_name):
        raise OperationProtocolError("invalid_database_name")
    if source_database_name == target_database_name:
        raise OperationProtocolError("restore_target_database_conflict")

    manifest_sha256 = _string(
        payload["manifest_sha256"], field="manifest_sha256", max_length=64
    ).lower()
    if not _SHA256.fullmatch(manifest_sha256):
        raise OperationProtocolError("invalid_manifest_sha256")
    total_size_bytes = _integer(payload["total_size_bytes"], field="total_size_bytes")
    artifacts = _parse_artifacts(payload["artifacts"], ids["source_tenant_id"], ids["backup_job_id"])
    if sum(item.size_bytes for item in artifacts) != total_size_bytes:
        raise OperationProtocolError("restore_total_size_mismatch")
    manifest = next(item for item in artifacts if item.artifact_kind == "manifest")
    if manifest.sha256 != manifest_sha256:
        raise OperationProtocolError("restore_manifest_checksum_mismatch")

    return RestoreClaimedOperation(
        operation_id=operation_id,
        operation_type=operation_type,
        lease_token=lease_token,
        lease_expires_at=lease_expires_at,
        payload=RestorePayload(
            backup_job_id=ids["backup_job_id"],
            source_tenant_id=ids["source_tenant_id"],
            target_tenant_id=ids["target_tenant_id"],
            environment_kind=environment_kind,
            template_id=ids["template_id"],
            source_provisioning_operation_id=ids["source_provisioning_operation_id"],
            source_database_name=source_database_name,
            target_database_name=target_database_name,
            manifest_sha256=manifest_sha256,
            total_size_bytes=total_size_bytes,
            artifacts=artifacts,
        ),
    )


def _storage_client(settings: AgentSettings) -> Any:
    endpoint = settings.backup_s3_endpoint_url
    bucket = settings.backup_s3_bucket
    access_key = settings.backup_s3_access_key_id
    secret_key = settings.backup_s3_secret_access_key
    if not endpoint or not bucket or access_key is None or secret_key is None:
        raise OperationProtocolError("restore_storage_not_configured")
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=settings.backup_s3_region,
        aws_access_key_id=access_key.get_secret_value(),
        aws_secret_access_key=secret_key.get_secret_value(),
        config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
    )


def _download_artifact(client: Any, bucket: str, artifact: RestoreArtifact, target: Path) -> None:
    kwargs: dict[str, Any] = {"Bucket": bucket, "Key": artifact.object_key}
    if not artifact.object_version.startswith("etag:"):
        kwargs["VersionId"] = artifact.object_version
    response = client.get_object(**kwargs)
    if int(response.get("ContentLength", -1)) != artifact.size_bytes:
        raise OperationProtocolError("restore_storage_size_mismatch")
    digest = hashlib.sha256()
    written = 0
    body = response["Body"]
    try:
        with target.open("xb") as handle:
            while True:
                chunk = body.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > artifact.size_bytes:
                    raise OperationProtocolError("restore_storage_size_mismatch")
                digest.update(chunk)
                handle.write(chunk)
    finally:
        close = getattr(body, "close", None)
        if callable(close):
            close()
    if written != artifact.size_bytes or digest.hexdigest() != artifact.sha256:
        raise OperationProtocolError("restore_storage_checksum_mismatch")
    target.chmod(0o600)


def _validate_manifest(operation: RestoreClaimedOperation, workspace: Path) -> None:
    path = workspace / _ARTIFACT_FILES["manifest"]
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise OperationProtocolError("restore_manifest_invalid") from exc
    if not isinstance(manifest, dict):
        raise OperationProtocolError("restore_manifest_invalid")
    expected_keys = {
        "schema_version",
        "backup_id",
        "tenant_id",
        "environment_kind",
        "template_id",
        "provisioning_operation_id",
        "database_name",
        "backup_type",
        "created_at",
        "artifacts",
    }
    if set(manifest) != expected_keys:
        raise OperationProtocolError("restore_manifest_schema_mismatch")
    identity = (
        manifest.get("schema_version"),
        manifest.get("backup_id"),
        manifest.get("tenant_id"),
        manifest.get("environment_kind"),
        manifest.get("template_id"),
        manifest.get("provisioning_operation_id"),
        manifest.get("database_name"),
        manifest.get("backup_type"),
    )
    expected_identity = (
        1,
        operation.payload.backup_job_id,
        operation.payload.source_tenant_id,
        "test",
        operation.payload.template_id,
        operation.payload.source_provisioning_operation_id,
        operation.payload.source_database_name,
        "full",
    )
    if identity != expected_identity:
        raise OperationProtocolError("restore_manifest_identity_mismatch")
    if not isinstance(manifest.get("created_at"), str) or not manifest["created_at"]:
        raise OperationProtocolError("restore_manifest_schema_mismatch")

    raw_artifacts = manifest.get("artifacts")
    if not isinstance(raw_artifacts, list) or len(raw_artifacts) != 2:
        raise OperationProtocolError("restore_manifest_artifacts_mismatch")
    expected = {item.artifact_kind: item for item in operation.payload.artifacts}
    seen: set[str] = set()
    for raw in raw_artifacts:
        if not isinstance(raw, dict) or set(raw) != {"artifact_kind", "file_name", "size_bytes", "sha256"}:
            raise OperationProtocolError("restore_manifest_artifacts_mismatch")
        kind = raw.get("artifact_kind")
        if kind not in {"database_dump", "filestore_archive"} or kind in seen:
            raise OperationProtocolError("restore_manifest_artifacts_mismatch")
        artifact = expected[kind]
        if (
            raw.get("file_name") != _ARTIFACT_FILES[kind]
            or raw.get("size_bytes") != artifact.size_bytes
            or raw.get("sha256") != artifact.sha256
        ):
            raise OperationProtocolError("restore_manifest_artifacts_mismatch")
        seen.add(kind)
    if seen != {"database_dump", "filestore_archive"}:
        raise OperationProtocolError("restore_manifest_artifacts_mismatch")


def _local_payload(operation: RestoreClaimedOperation) -> dict[str, Any]:
    return {
        "backup_job_id": operation.payload.backup_job_id,
        "source_tenant_id": operation.payload.source_tenant_id,
        "target_tenant_id": operation.payload.target_tenant_id,
        "environment_kind": operation.payload.environment_kind,
        "template_id": operation.payload.template_id,
        "source_provisioning_operation_id": operation.payload.source_provisioning_operation_id,
        "source_database_name": operation.payload.source_database_name,
        "target_database_name": operation.payload.target_database_name,
        "manifest_sha256": operation.payload.manifest_sha256,
        "total_size_bytes": operation.payload.total_size_bytes,
        "artifacts": [
            {
                "artifact_kind": item.artifact_kind,
                "size_bytes": item.size_bytes,
                "sha256": item.sha256,
            }
            for item in operation.payload.artifacts
        ],
    }


def _call_local_helper(
    operation: RestoreClaimedOperation,
    *,
    provisioner_socket: Path,
    timeout_seconds: float,
) -> dict[str, Any]:
    request = {
        "operation_id": operation.operation_id,
        "type": _LOCAL_RESTORE_OPERATION,
        "payload": _local_payload(operation),
    }
    encoded = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(encoded) > 16 * 1024:
        raise OperationProtocolError("local_request_too_large")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout_seconds)
            client.connect(str(provisioner_socket))
            client.sendall(encoded)
            with client.makefile("rb") as stream:
                raw = stream.readline(_MAX_LOCAL_RESPONSE_BYTES + 1)
    except (OSError, TimeoutError) as exc:
        raise OperationProtocolError("local_provisioner_unavailable") from exc
    if len(raw) > _MAX_LOCAL_RESPONSE_BYTES or not raw.endswith(b"\n"):
        raise OperationProtocolError("local_provisioner_protocol_error")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise OperationProtocolError("local_provisioner_protocol_error") from exc
    if not isinstance(value, dict):
        raise OperationProtocolError("local_provisioner_protocol_error")
    return value


def execute_restore_operation(
    operation: RestoreClaimedOperation,
    *,
    settings: AgentSettings | None,
    provisioner_socket: Path | None,
    timeout_seconds: float,
    s3_client: Any | None = None,
) -> RestoreExecutionResult:
    if settings is None:
        return RestoreExecutionResult(state="failed", error_code="restore_storage_not_configured")
    if provisioner_socket is None:
        return RestoreExecutionResult(state="failed", error_code="restore_executor_not_ready")
    workspace = _RESTORE_INBOX_ROOT / operation.operation_id
    try:
        if _RESTORE_INBOX_ROOT.exists() and _RESTORE_INBOX_ROOT.is_symlink():
            raise OperationProtocolError("restore_inbox_symlink_blocked")
        _RESTORE_INBOX_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        _RESTORE_INBOX_ROOT.chmod(0o700)
        if workspace.exists() or workspace.is_symlink():
            if workspace.is_symlink() or not workspace.is_dir():
                raise OperationProtocolError("restore_workspace_conflict")
            shutil.rmtree(workspace)
        workspace.mkdir(mode=0o700)

        bucket = settings.backup_s3_bucket
        if not bucket:
            raise OperationProtocolError("restore_storage_not_configured")
        client = s3_client if s3_client is not None else _storage_client(settings)
        for artifact in operation.payload.artifacts:
            _download_artifact(client, bucket, artifact, workspace / _ARTIFACT_FILES[artifact.artifact_kind])
        _validate_manifest(operation, workspace)

        result = _call_local_helper(
            operation,
            provisioner_socket=provisioner_socket,
            timeout_seconds=timeout_seconds,
        )
        if result == {"state": "validated", "database_name": operation.payload.target_database_name}:
            return RestoreExecutionResult(
                state="validated",
                database_name=operation.payload.target_database_name,
            )
        if result.get("state") == "failed" and isinstance(result.get("error_code"), str):
            return RestoreExecutionResult(state="failed", error_code=str(result["error_code"]))
        return RestoreExecutionResult(state="failed", error_code="restore_local_protocol_error")
    except OperationProtocolError as exc:
        return RestoreExecutionResult(state="failed", error_code=str(exc))
    except Exception:  # noqa: BLE001 - storage/local boundary must fail closed without secret leakage.
        return RestoreExecutionResult(state="failed", error_code="restore_storage_unavailable")


def purge_restore_download_local(operation: RestoreClaimedOperation) -> bool:
    workspace = _RESTORE_INBOX_ROOT / operation.operation_id
    try:
        if workspace.is_symlink():
            return False
        if workspace.exists():
            shutil.rmtree(workspace)
        return True
    except OSError:
        return False
