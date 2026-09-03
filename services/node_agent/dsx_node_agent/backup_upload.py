from __future__ import annotations

import hashlib
import json
import re
import socket
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import boto3
from botocore.config import Config

from dsx_node_agent.operations import OperationExecutionResult, OperationProtocolError
from dsx_node_agent.settings import AgentSettings

_UPLOAD_OPERATION = "upload_verify_backup_artifacts"
_STAGE_OPERATION = "stage_backup_for_upload"
_PURGE_OPERATION = "purge_verified_backup"
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_DATABASE = re.compile(r"^[a-z][a-z0-9_]{2,62}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MAX_LOCAL_RESPONSE_BYTES = 8 * 1024
_ARTIFACT_FILES = {
    "database_dump": "database.dump",
    "filestore_archive": "filestore.tar.gz",
    "manifest": "manifest.json",
}


@dataclass(frozen=True)
class ExpectedUploadArtifact:
    artifact_kind: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class BackupUploadPayload:
    tenant_id: str
    environment_kind: str
    template_id: str
    provisioning_operation_id: str
    database_name: str
    backup_type: str
    manifest_sha256: str
    total_size_bytes: int
    artifacts: tuple[ExpectedUploadArtifact, ...]


@dataclass(frozen=True)
class BackupUploadClaimedOperation:
    operation_id: str
    operation_type: str
    lease_token: str
    lease_expires_at: str
    payload: BackupUploadPayload


@dataclass(frozen=True)
class BackupUploadExecutionResult(OperationExecutionResult):
    backup_artifacts: tuple[dict[str, object], ...] | None = None


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


def _parse_artifacts(value: Any) -> tuple[ExpectedUploadArtifact, ...]:
    if not isinstance(value, list) or len(value) != 3:
        raise OperationProtocolError("invalid_backup_upload_artifacts")
    parsed: list[ExpectedUploadArtifact] = []
    seen: set[str] = set()
    for raw in value:
        if not isinstance(raw, dict):
            raise OperationProtocolError("invalid_backup_upload_artifact")
        _exact(raw, {"artifact_kind", "size_bytes", "sha256"}, field="backup_upload_artifact")
        kind = _string(raw["artifact_kind"], field="artifact_kind", max_length=32)
        if kind not in _ARTIFACT_FILES or kind in seen:
            raise OperationProtocolError("invalid_artifact_kind")
        checksum = _string(raw["sha256"], field="artifact_sha256", max_length=64).lower()
        if not _SHA256.fullmatch(checksum):
            raise OperationProtocolError("invalid_artifact_sha256")
        seen.add(kind)
        parsed.append(
            ExpectedUploadArtifact(
                artifact_kind=kind,
                size_bytes=_integer(raw["size_bytes"], field="artifact_size_bytes"),
                sha256=checksum,
            )
        )
    if seen != set(_ARTIFACT_FILES):
        raise OperationProtocolError("invalid_backup_upload_artifacts")
    return tuple(parsed)


def parse_backup_upload_claimed_operation(response_payload: Any) -> BackupUploadClaimedOperation | None:
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
    if operation_type != _UPLOAD_OPERATION:
        raise OperationProtocolError("unsupported_operation_type")
    lease_token = _string(operation["lease_token"], field="lease_token", max_length=256)
    if len(lease_token) < 16:
        raise OperationProtocolError("invalid_lease_token")
    lease_expires_at = _string(
        operation["lease_expires_at"], field="lease_expires_at", max_length=64
    )
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
            "tenant_id",
            "environment_kind",
            "template_id",
            "provisioning_operation_id",
            "database_name",
            "backup_type",
            "manifest_sha256",
            "total_size_bytes",
            "artifacts",
        },
        field="operation_payload",
    )

    tenant_id = _string(payload["tenant_id"], field="tenant_id", max_length=64)
    template_id = _string(payload["template_id"], field="template_id", max_length=96)
    provisioning_operation_id = _string(
        payload["provisioning_operation_id"], field="provisioning_operation_id", max_length=64
    )
    for field, value in (
        ("tenant_id", tenant_id),
        ("template_id", template_id),
        ("provisioning_operation_id", provisioning_operation_id),
    ):
        if not _SAFE_ID.fullmatch(value):
            raise OperationProtocolError(f"invalid_{field}")

    environment_kind = _string(
        payload["environment_kind"], field="environment_kind", max_length=32
    ).lower()
    if environment_kind != "test":
        raise OperationProtocolError("backup_upload_non_test_environment_blocked")
    database_name = _string(payload["database_name"], field="database_name", max_length=63).lower()
    if not _SAFE_DATABASE.fullmatch(database_name):
        raise OperationProtocolError("invalid_database_name")
    backup_type = _string(payload["backup_type"], field="backup_type", max_length=32).lower()
    if backup_type != "full":
        raise OperationProtocolError("unsupported_backup_type")
    manifest_sha256 = _string(
        payload["manifest_sha256"], field="manifest_sha256", max_length=64
    ).lower()
    if not _SHA256.fullmatch(manifest_sha256):
        raise OperationProtocolError("invalid_manifest_sha256")
    total_size_bytes = _integer(payload["total_size_bytes"], field="total_size_bytes")
    artifacts = _parse_artifacts(payload["artifacts"])
    if sum(item.size_bytes for item in artifacts) != total_size_bytes:
        raise OperationProtocolError("backup_total_size_mismatch")
    manifest = next(item for item in artifacts if item.artifact_kind == "manifest")
    if manifest.sha256 != manifest_sha256:
        raise OperationProtocolError("backup_manifest_checksum_mismatch")

    return BackupUploadClaimedOperation(
        operation_id=operation_id,
        operation_type=operation_type,
        lease_token=lease_token,
        lease_expires_at=lease_expires_at,
        payload=BackupUploadPayload(
            tenant_id=tenant_id,
            environment_kind=environment_kind,
            template_id=template_id,
            provisioning_operation_id=provisioning_operation_id,
            database_name=database_name,
            backup_type=backup_type,
            manifest_sha256=manifest_sha256,
            total_size_bytes=total_size_bytes,
            artifacts=artifacts,
        ),
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _local_identity_payload(operation: BackupUploadClaimedOperation) -> dict[str, Any]:
    return {
        "tenant_id": operation.payload.tenant_id,
        "environment_kind": operation.payload.environment_kind,
        "template_id": operation.payload.template_id,
        "provisioning_operation_id": operation.payload.provisioning_operation_id,
        "database_name": operation.payload.database_name,
        "backup_type": operation.payload.backup_type,
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
    operation: BackupUploadClaimedOperation,
    *,
    operation_type: str,
    provisioner_socket: Path,
    timeout_seconds: float,
) -> dict[str, Any]:
    request = {
        "operation_id": operation.operation_id,
        "type": operation_type,
        "payload": _local_identity_payload(operation),
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


def _validate_staged_files(
    operation: BackupUploadClaimedOperation,
    outbox_root: Path,
) -> dict[str, Path]:
    job_dir = outbox_root / operation.operation_id
    if job_dir.is_symlink() or not job_dir.is_dir():
        raise OperationProtocolError("backup_upload_outbox_missing")
    files: dict[str, Path] = {}
    for artifact in operation.payload.artifacts:
        path = job_dir / _ARTIFACT_FILES[artifact.artifact_kind]
        if path.is_symlink() or not path.is_file():
            raise OperationProtocolError("backup_upload_outbox_invalid")
        info = path.stat()
        if info.st_size != artifact.size_bytes or _sha256_file(path) != artifact.sha256:
            raise OperationProtocolError("backup_upload_outbox_checksum_mismatch")
        files[artifact.artifact_kind] = path
    return files


def expected_object_key(operation: BackupUploadClaimedOperation, artifact_kind: str) -> str:
    return (
        f"test/{operation.payload.tenant_id}/{operation.operation_id}/"
        f"{_ARTIFACT_FILES[artifact_kind]}"
    )


def _storage_client(settings: AgentSettings) -> Any:
    endpoint = settings.backup_s3_endpoint_url
    bucket = settings.backup_s3_bucket
    access_key = settings.backup_s3_access_key_id
    secret_key = settings.backup_s3_secret_access_key
    if not endpoint or not bucket or access_key is None or secret_key is None:
        raise OperationProtocolError("backup_storage_not_configured")
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=settings.backup_s3_region,
        aws_access_key_id=access_key.get_secret_value(),
        aws_secret_access_key=secret_key.get_secret_value(),
        config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
    )


def _verify_remote_object(
    client: Any,
    bucket: str,
    object_key: str,
    expected: ExpectedUploadArtifact,
) -> None:
    response = client.get_object(Bucket=bucket, Key=object_key)
    if int(response.get("ContentLength", -1)) != expected.size_bytes:
        raise OperationProtocolError("backup_storage_size_mismatch")
    digest = hashlib.sha256()
    body = response["Body"]
    try:
        while True:
            chunk = body.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    finally:
        close = getattr(body, "close", None)
        if callable(close):
            close()
    if digest.hexdigest() != expected.sha256:
        raise OperationProtocolError("backup_storage_checksum_mismatch")


def execute_backup_upload_operation(
    operation: BackupUploadClaimedOperation,
    *,
    settings: AgentSettings | None,
    provisioner_socket: Path | None,
    timeout_seconds: float,
    s3_client: Any | None = None,
) -> BackupUploadExecutionResult:
    if settings is None:
        return BackupUploadExecutionResult(state="failed", error_code="backup_storage_not_configured")
    if provisioner_socket is None:
        return BackupUploadExecutionResult(state="failed", error_code="backup_upload_executor_not_ready")
    try:
        staged = _call_local_helper(
            operation,
            operation_type=_STAGE_OPERATION,
            provisioner_socket=provisioner_socket,
            timeout_seconds=timeout_seconds,
        )
        if staged != {"state": "staged"}:
            code = staged.get("error_code") if staged.get("state") == "failed" else None
            return BackupUploadExecutionResult(
                state="failed",
                error_code=str(code) if isinstance(code, str) else "backup_stage_failed",
            )

        files = _validate_staged_files(operation, settings.backup_outbox_root)
        bucket = settings.backup_s3_bucket
        if not bucket:
            return BackupUploadExecutionResult(state="failed", error_code="backup_storage_not_configured")
        client = s3_client if s3_client is not None else _storage_client(settings)
        verified: list[dict[str, object]] = []
        for artifact in operation.payload.artifacts:
            object_key = expected_object_key(operation, artifact.artifact_kind)
            with files[artifact.artifact_kind].open("rb") as handle:
                response = client.put_object(
                    Bucket=bucket,
                    Key=object_key,
                    Body=handle,
                    Metadata={"sha256": artifact.sha256},
                )
            version = response.get("VersionId")
            if not isinstance(version, str) or not version.strip():
                etag = response.get("ETag")
                if not isinstance(etag, str) or not etag.strip('"'):
                    raise OperationProtocolError("backup_storage_version_missing")
                version = f"etag:{etag.strip(chr(34))}"
            _verify_remote_object(client, bucket, object_key, artifact)
            verified.append(
                {
                    "artifact_kind": artifact.artifact_kind,
                    "size_bytes": artifact.size_bytes,
                    "sha256": artifact.sha256,
                    "object_key": object_key,
                    "object_version": version,
                }
            )

        return BackupUploadExecutionResult(state="verified", backup_artifacts=tuple(verified))
    except OperationProtocolError as exc:
        return BackupUploadExecutionResult(state="failed", error_code=str(exc))
    except Exception:  # noqa: BLE001 - storage boundary must fail closed without leaking credentials.
        return BackupUploadExecutionResult(state="failed", error_code="backup_storage_unavailable")


def purge_verified_backup_local(
    operation: BackupUploadClaimedOperation,
    *,
    provisioner_socket: Path | None,
    timeout_seconds: float,
) -> bool:
    if provisioner_socket is None:
        return False
    try:
        result = _call_local_helper(
            operation,
            operation_type=_PURGE_OPERATION,
            provisioner_socket=provisioner_socket,
            timeout_seconds=timeout_seconds,
        )
    except OperationProtocolError:
        return False
    return result == {"state": "purged"}
