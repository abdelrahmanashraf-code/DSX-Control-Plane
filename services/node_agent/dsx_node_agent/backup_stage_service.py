from __future__ import annotations

import grp
import hashlib
import json
import os
import re
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dsx_node_agent.provisioner import ProvisionerConfig, ProvisionerError

_STAGE_OPERATION = "stage_backup_for_upload"
_PURGE_OPERATION = "purge_verified_backup"
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_DATABASE = re.compile(r"^[a-z][a-z0-9_]{2,62}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_ARTIFACT_FILES = {
    "database_dump": "database.dump",
    "filestore_archive": "filestore.tar.gz",
    "manifest": "manifest.json",
}


@dataclass(frozen=True)
class ExpectedArtifact:
    artifact_kind: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class BackupStageRequest:
    operation_id: str
    operation_type: str
    tenant_id: str
    environment_kind: str
    template_id: str
    provisioning_operation_id: str
    database_name: str
    backup_type: str
    manifest_sha256: str
    total_size_bytes: int
    artifacts: tuple[ExpectedArtifact, ...]


def _string(value: Any, *, field: str, max_length: int) -> str:
    if not isinstance(value, str):
        raise ProvisionerError(f"invalid_{field}")
    parsed = value.strip()
    if not parsed or len(parsed) > max_length:
        raise ProvisionerError(f"invalid_{field}")
    return parsed


def _integer(value: Any, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ProvisionerError(f"invalid_{field}")
    return value


def _parse_artifacts(value: Any) -> tuple[ExpectedArtifact, ...]:
    if not isinstance(value, list) or len(value) != 3:
        raise ProvisionerError("invalid_backup_stage_artifacts")
    parsed: list[ExpectedArtifact] = []
    seen: set[str] = set()
    for raw in value:
        if not isinstance(raw, dict) or set(raw) != {"artifact_kind", "size_bytes", "sha256"}:
            raise ProvisionerError("invalid_backup_stage_artifact_fields")
        kind = _string(raw["artifact_kind"], field="artifact_kind", max_length=32)
        if kind not in _ARTIFACT_FILES or kind in seen:
            raise ProvisionerError("invalid_artifact_kind")
        checksum = _string(raw["sha256"], field="artifact_sha256", max_length=64).lower()
        if not _SHA256.fullmatch(checksum):
            raise ProvisionerError("invalid_artifact_sha256")
        seen.add(kind)
        parsed.append(
            ExpectedArtifact(
                artifact_kind=kind,
                size_bytes=_integer(raw["size_bytes"], field="artifact_size_bytes"),
                sha256=checksum,
            )
        )
    if seen != set(_ARTIFACT_FILES):
        raise ProvisionerError("invalid_backup_stage_artifacts")
    return tuple(parsed)


def parse_backup_stage_request(value: Any) -> BackupStageRequest:
    if not isinstance(value, dict) or set(value) != {"operation_id", "type", "payload"}:
        raise ProvisionerError("invalid_request_fields")
    operation_id = _string(value["operation_id"], field="operation_id", max_length=64)
    if not _SAFE_ID.fullmatch(operation_id):
        raise ProvisionerError("invalid_operation_id")
    operation_type = _string(value["type"], field="operation_type", max_length=64)
    if operation_type not in {_STAGE_OPERATION, _PURGE_OPERATION}:
        raise ProvisionerError("unsupported_operation_type")
    payload = value["payload"]
    expected = {
        "tenant_id",
        "environment_kind",
        "template_id",
        "provisioning_operation_id",
        "database_name",
        "backup_type",
        "manifest_sha256",
        "total_size_bytes",
        "artifacts",
    }
    if not isinstance(payload, dict) or set(payload) != expected:
        raise ProvisionerError("invalid_payload_fields")

    tenant_id = _string(payload["tenant_id"], field="tenant_id", max_length=64)
    template_id = _string(payload["template_id"], field="template_id", max_length=96)
    provisioning_operation_id = _string(
        payload["provisioning_operation_id"], field="provisioning_operation_id", max_length=64
    )
    for field, item in (
        ("tenant_id", tenant_id),
        ("template_id", template_id),
        ("provisioning_operation_id", provisioning_operation_id),
    ):
        if not _SAFE_ID.fullmatch(item):
            raise ProvisionerError(f"invalid_{field}")
    environment_kind = _string(
        payload["environment_kind"], field="environment_kind", max_length=32
    ).lower()
    if environment_kind != "test":
        raise ProvisionerError("backup_upload_non_test_environment_blocked")
    database_name = _string(payload["database_name"], field="database_name", max_length=63).lower()
    if not _SAFE_DATABASE.fullmatch(database_name):
        raise ProvisionerError("invalid_database_name")
    backup_type = _string(payload["backup_type"], field="backup_type", max_length=32).lower()
    if backup_type != "full":
        raise ProvisionerError("unsupported_backup_type")
    manifest_sha256 = _string(
        payload["manifest_sha256"], field="manifest_sha256", max_length=64
    ).lower()
    if not _SHA256.fullmatch(manifest_sha256):
        raise ProvisionerError("invalid_manifest_sha256")
    total_size_bytes = _integer(payload["total_size_bytes"], field="total_size_bytes")
    artifacts = _parse_artifacts(payload["artifacts"])
    if sum(item.size_bytes for item in artifacts) != total_size_bytes:
        raise ProvisionerError("backup_total_size_mismatch")
    manifest = next(item for item in artifacts if item.artifact_kind == "manifest")
    if manifest.sha256 != manifest_sha256:
        raise ProvisionerError("backup_manifest_checksum_mismatch")

    return BackupStageRequest(
        operation_id=operation_id,
        operation_type=operation_type,
        tenant_id=tenant_id,
        environment_kind=environment_kind,
        template_id=template_id,
        provisioning_operation_id=provisioning_operation_id,
        database_name=database_name,
        backup_type=backup_type,
        manifest_sha256=manifest_sha256,
        total_size_bytes=total_size_bytes,
        artifacts=artifacts,
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise ProvisionerError("backup_stage_checksum_failed") from exc
    return digest.hexdigest()


class BackupArtifactStager:
    def __init__(
        self,
        config: ProvisionerConfig,
        *,
        outbox_root: Path = Path("/var/lib/dsx-backup-outbox"),
        export_group: str = "dsx-agent",
        outbox_owner_uid: int = 0,
    ) -> None:
        self.config = config
        self.outbox_root = outbox_root
        self.export_group = export_group
        self.outbox_owner_uid = outbox_owner_uid

    def _workspace_files(self, request: BackupStageRequest) -> dict[str, Path]:
        if not self.config.enabled or self.config.phase != "test-only":
            raise ProvisionerError("provisioner_disabled")
        workspace = self.config.work_root / "backups" / request.operation_id
        if workspace.is_symlink() or not workspace.is_dir():
            raise ProvisionerError("backup_workspace_missing")
        manifest_path = workspace / "manifest.json"
        if manifest_path.is_symlink() or not manifest_path.is_file():
            raise ProvisionerError("backup_manifest_missing")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ProvisionerError("backup_manifest_invalid") from exc
        identity = (
            manifest.get("backup_id"),
            manifest.get("tenant_id"),
            manifest.get("environment_kind"),
            manifest.get("template_id"),
            manifest.get("provisioning_operation_id"),
            manifest.get("database_name"),
            manifest.get("backup_type"),
        )
        expected_identity = (
            request.operation_id,
            request.tenant_id,
            request.environment_kind,
            request.template_id,
            request.provisioning_operation_id,
            request.database_name,
            request.backup_type,
        )
        if identity != expected_identity:
            raise ProvisionerError("backup_stage_identity_mismatch")

        files: dict[str, Path] = {}
        for artifact in request.artifacts:
            path = workspace / _ARTIFACT_FILES[artifact.artifact_kind]
            if path.is_symlink() or not path.is_file():
                raise ProvisionerError("backup_stage_artifact_missing")
            try:
                size = path.stat().st_size
            except OSError as exc:
                raise ProvisionerError("backup_stage_artifact_stat_failed") from exc
            if size != artifact.size_bytes or _sha256_file(path) != artifact.sha256:
                raise ProvisionerError("backup_stage_artifact_mismatch")
            files[artifact.artifact_kind] = path
        return files

    def _validated_outbox_group(self) -> int:
        try:
            gid = grp.getgrnam(self.export_group).gr_gid
        except KeyError as exc:
            raise ProvisionerError("backup_outbox_account_missing") from exc
        if self.outbox_root.is_symlink() or not self.outbox_root.is_dir():
            raise ProvisionerError("backup_outbox_unavailable")
        try:
            info = self.outbox_root.stat()
        except OSError as exc:
            raise ProvisionerError("backup_outbox_unavailable") from exc
        if info.st_uid != self.outbox_owner_uid or info.st_gid != gid:
            raise ProvisionerError("backup_outbox_owner_mismatch")
        if stat.S_IMODE(info.st_mode) & 0o022:
            raise ProvisionerError("backup_outbox_permissions_insecure")
        return gid

    def stage(self, request: BackupStageRequest) -> dict[str, str]:
        files = self._workspace_files(request)
        gid = self._validated_outbox_group()

        target = self.outbox_root / request.operation_id
        if target.is_symlink():
            raise ProvisionerError("backup_outbox_conflict")
        if target.exists():
            if not target.is_dir() or target.stat().st_uid != self.outbox_owner_uid:
                raise ProvisionerError("backup_outbox_conflict")
            shutil.rmtree(target)
        try:
            target.mkdir(mode=0o750)
            os.chown(target, self.outbox_owner_uid, gid)
            os.chmod(target, 0o750)
            for artifact in request.artifacts:
                destination = target / _ARTIFACT_FILES[artifact.artifact_kind]
                shutil.copyfile(files[artifact.artifact_kind], destination)
                os.chown(destination, self.outbox_owner_uid, gid)
                os.chmod(destination, 0o440)
        except OSError as exc:
            shutil.rmtree(target, ignore_errors=True)
            raise ProvisionerError("backup_outbox_stage_failed") from exc
        return {"state": "staged"}

    def purge(self, request: BackupStageRequest) -> dict[str, str]:
        self._workspace_files(request)
        self._validated_outbox_group()
        workspace = self.config.work_root / "backups" / request.operation_id
        target = self.outbox_root / request.operation_id
        if target.is_symlink():
            raise ProvisionerError("backup_outbox_conflict")
        try:
            shutil.rmtree(workspace)
            if target.exists():
                if not target.is_dir() or target.stat().st_uid != self.outbox_owner_uid:
                    raise ProvisionerError("backup_outbox_conflict")
                shutil.rmtree(target)
        except ProvisionerError:
            raise
        except OSError as exc:
            raise ProvisionerError("backup_local_purge_failed") from exc
        return {"state": "purged"}
