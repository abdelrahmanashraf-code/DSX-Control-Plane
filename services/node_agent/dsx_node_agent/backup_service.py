from __future__ import annotations

import grp
import hashlib
import json
import os
import pwd
import re
import shutil
import tarfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dsx_node_agent.provisioner import (
    ProvisionerConfig,
    ProvisionerError,
    ProvisioningEngine,
)

_BACKUP_OPERATION = "backup_odoo_environment"
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_DATABASE = re.compile(r"^[a-z][a-z0-9_]{2,62}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_PG_DUMP = "/usr/bin/pg_dump"
_PSQL = "/usr/bin/psql"
_DATABASE_FILE = "database.dump"
_FILESTORE_FILE = "filestore.tar.gz"
_MANIFEST_FILE = "manifest.json"


@dataclass(frozen=True)
class BackupRequest:
    operation_id: str
    tenant_id: str
    environment_kind: str
    template_id: str
    provisioning_operation_id: str
    database_name: str
    backup_type: str


def _string(value: Any, *, field: str, max_length: int) -> str:
    if not isinstance(value, str):
        raise ProvisionerError(f"invalid_{field}")
    result = value.strip()
    if not result or len(result) > max_length:
        raise ProvisionerError(f"invalid_{field}")
    return result


def parse_backup_request(value: Any) -> BackupRequest:
    if not isinstance(value, dict) or set(value) != {"operation_id", "type", "payload"}:
        raise ProvisionerError("invalid_request_fields")

    operation_id = _string(value["operation_id"], field="operation_id", max_length=64)
    if not _SAFE_ID.fullmatch(operation_id):
        raise ProvisionerError("invalid_operation_id")
    operation_type = _string(value["type"], field="operation_type", max_length=64)
    if operation_type != _BACKUP_OPERATION:
        raise ProvisionerError("unsupported_operation_type")

    payload = value["payload"]
    expected = {
        "tenant_id",
        "environment_kind",
        "template_id",
        "provisioning_operation_id",
        "database_name",
        "backup_type",
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
        raise ProvisionerError("backup_non_test_environment_blocked")

    database_name = _string(payload["database_name"], field="database_name", max_length=63).lower()
    if not _SAFE_DATABASE.fullmatch(database_name):
        raise ProvisionerError("invalid_database_name")

    backup_type = _string(payload["backup_type"], field="backup_type", max_length=32).lower()
    if backup_type != "full":
        raise ProvisionerError("unsupported_backup_type")

    return BackupRequest(
        operation_id=operation_id,
        tenant_id=tenant_id,
        environment_kind=environment_kind,
        template_id=template_id,
        provisioning_operation_id=provisioning_operation_id,
        database_name=database_name,
        backup_type=backup_type,
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise ProvisionerError("backup_checksum_failed") from exc
    return digest.hexdigest()


def _artifact(kind: str, file_name: str, path: Path) -> dict[str, Any]:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ProvisionerError("backup_artifact_stat_failed") from exc
    return {
        "artifact_kind": kind,
        "file_name": file_name,
        "size_bytes": size,
        "sha256": _sha256_file(path),
    }


class BackupEngine:
    def __init__(self, config: ProvisionerConfig, provisioning: ProvisioningEngine) -> None:
        self.config = config
        self.provisioning = provisioning

    def _read_full_marker(self, database_name: str) -> tuple[str, str, str] | None:
        result = self.provisioning._run_postgres(
            [
                _PSQL,
                "-X",
                "-A",
                "-t",
                "-q",
                "--no-password",
                f"--dbname={database_name}",
                "--command",
                (
                    "SELECT tenant_id || E'\\t' || template_id || E'\\t' || operation_id "
                    "FROM public.dsx_provisioning_meta WHERE singleton = 1;"
                ),
            ],
            timeout=10,
            capture_stdout=True,
        )
        if result.returncode != 0:
            return None
        parts = result.stdout.strip().split("\t")
        if len(parts) != 3:
            return None
        return parts[0], parts[1], parts[2]

    def _database_owner(self, database_name: str) -> str | None:
        result = self.provisioning._run_postgres(
            [
                _PSQL,
                "-X",
                "-A",
                "-t",
                "-q",
                "--no-password",
                "--dbname=postgres",
                "--command",
                (
                    "SELECT pg_get_userbyid(datdba) FROM pg_database "
                    f"WHERE datname = '{database_name}' LIMIT 1;"
                ),
            ],
            timeout=10,
            capture_stdout=True,
        )
        if result.returncode != 0:
            raise ProvisionerError("postgres_inventory_failed")
        value = result.stdout.strip()
        return value or None

    @staticmethod
    def _validate_filestore(path: Path, user: str, group: str) -> None:
        if path.is_symlink() or not path.is_dir():
            raise ProvisionerError("backup_filestore_invalid")
        try:
            expected_uid = pwd.getpwnam(user).pw_uid
            expected_gid = grp.getgrnam(group).gr_gid
        except KeyError as exc:
            raise ProvisionerError("filestore_account_missing") from exc
        try:
            info = path.stat()
        except OSError as exc:
            raise ProvisionerError("backup_filestore_invalid") from exc
        if info.st_uid != expected_uid or info.st_gid != expected_gid:
            raise ProvisionerError("backup_filestore_owner_mismatch")
        for root, dirs, files in os.walk(path, followlinks=False):
            for name in [*dirs, *files]:
                if (Path(root) / name).is_symlink():
                    raise ProvisionerError("backup_filestore_symlink_blocked")

    def _workspace(self, operation_id: str) -> Path:
        root = self.config.work_root
        if root.exists() and root.is_symlink():
            raise ProvisionerError("backup_work_root_symlink_blocked")
        try:
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(root, 0o700)
        except OSError as exc:
            raise ProvisionerError("backup_work_root_unavailable") from exc

        backups = root / "backups"
        if backups.exists() and backups.is_symlink():
            raise ProvisionerError("backup_work_root_symlink_blocked")
        try:
            backups.mkdir(parents=False, exist_ok=True, mode=0o700)
            os.chmod(backups, 0o700)
        except OSError as exc:
            raise ProvisionerError("backup_work_root_unavailable") from exc
        return backups / operation_id

    @staticmethod
    def _tar_filter(member: tarfile.TarInfo) -> tarfile.TarInfo:
        if member.issym() or member.islnk():
            raise ProvisionerError("backup_filestore_symlink_blocked")
        member.uid = 0
        member.gid = 0
        member.uname = "root"
        member.gname = "root"
        return member

    def _archive_filestore(self, source: Path, target: Path, database_name: str) -> None:
        try:
            with tarfile.open(target, "w:gz", dereference=False) as archive:
                archive.add(
                    source,
                    arcname=database_name,
                    recursive=True,
                    filter=self._tar_filter,
                )
            os.chmod(target, 0o600)
        except ProvisionerError:
            raise
        except (OSError, tarfile.TarError) as exc:
            raise ProvisionerError("filestore_archive_failed") from exc

    def _dump_database(self, database_name: str, target: Path) -> None:
        try:
            with target.open("wb") as handle:
                dumped = self.provisioning._run_postgres(
                    [
                        _PG_DUMP,
                        "--format=custom",
                        "--no-owner",
                        "--no-privileges",
                        f"--dbname={database_name}",
                    ],
                    timeout=1800,
                    stdout_handle=handle,
                )
            os.chmod(target, 0o600)
        except ProvisionerError:
            raise
        except OSError as exc:
            raise ProvisionerError("database_backup_file_failed") from exc
        if dumped.returncode != 0:
            raise ProvisionerError("database_backup_failed")

    @staticmethod
    def _prepared_response(workspace: Path, request: BackupRequest) -> dict[str, Any] | None:
        manifest_path = workspace / _MANIFEST_FILE
        database_path = workspace / _DATABASE_FILE
        filestore_path = workspace / _FILESTORE_FILE
        if not all(path.is_file() and not path.is_symlink() for path in (manifest_path, database_path, filestore_path)):
            return None
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        identity = (
            manifest.get("backup_id"),
            manifest.get("tenant_id"),
            manifest.get("template_id"),
            manifest.get("provisioning_operation_id"),
            manifest.get("database_name"),
            manifest.get("backup_type"),
        )
        expected = (
            request.operation_id,
            request.tenant_id,
            request.template_id,
            request.provisioning_operation_id,
            request.database_name,
            request.backup_type,
        )
        if identity != expected:
            return None

        artifacts = [
            _artifact("database_dump", _DATABASE_FILE, database_path),
            _artifact("filestore_archive", _FILESTORE_FILE, filestore_path),
            _artifact("manifest", _MANIFEST_FILE, manifest_path),
        ]
        manifest_sha256 = artifacts[2]["sha256"]
        if not isinstance(manifest_sha256, str) or not _SHA256.fullmatch(manifest_sha256):
            return None
        return {
            "state": "prepared",
            "manifest_sha256": manifest_sha256,
            "total_size_bytes": sum(int(item["size_bytes"]) for item in artifacts),
            "artifacts": artifacts,
        }

    def backup(self, request: BackupRequest) -> dict[str, Any]:
        if not self.config.enabled:
            raise ProvisionerError("provisioner_disabled")
        if self.config.phase != "test-only" or request.environment_kind != "test":
            raise ProvisionerError("backup_non_test_environment_blocked")

        profile = self.config.profiles.get(request.template_id)
        if profile is None:
            raise ProvisionerError("local_template_profile_missing")
        if request.database_name == profile.source_database:
            raise ProvisionerError("backup_source_database_blocked")
        if not request.database_name.startswith(f"{profile.database_prefix}_"):
            raise ProvisionerError("database_prefix_mismatch")
        if not self.provisioning._database_exists(request.database_name):
            raise ProvisionerError("backup_database_missing")
        if self._database_owner(request.database_name) != profile.database_owner:
            raise ProvisionerError("backup_database_owner_mismatch")

        expected_marker = (
            request.tenant_id,
            request.template_id,
            request.provisioning_operation_id,
        )
        if self._read_full_marker(request.database_name) != expected_marker:
            raise ProvisionerError("backup_marker_mismatch")

        filestore = profile.filestore_root.resolve() / request.database_name
        self._validate_filestore(filestore, profile.filestore_user, profile.filestore_group)

        workspace = self._workspace(request.operation_id)
        if workspace.exists() or workspace.is_symlink():
            if workspace.is_symlink() or not workspace.is_dir():
                raise ProvisionerError("backup_workspace_conflict")
            existing = self._prepared_response(workspace, request)
            if existing is None:
                raise ProvisionerError("backup_workspace_conflict")
            return existing

        try:
            workspace.mkdir(mode=0o700)
            database_path = workspace / _DATABASE_FILE
            filestore_path = workspace / _FILESTORE_FILE
            manifest_path = workspace / _MANIFEST_FILE

            self._dump_database(request.database_name, database_path)
            self._archive_filestore(filestore, filestore_path, request.database_name)

            database_artifact = _artifact("database_dump", _DATABASE_FILE, database_path)
            filestore_artifact = _artifact("filestore_archive", _FILESTORE_FILE, filestore_path)
            manifest = {
                "schema_version": 1,
                "backup_id": request.operation_id,
                "tenant_id": request.tenant_id,
                "environment_kind": request.environment_kind,
                "template_id": request.template_id,
                "provisioning_operation_id": request.provisioning_operation_id,
                "database_name": request.database_name,
                "backup_type": request.backup_type,
                "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "artifacts": [database_artifact, filestore_artifact],
            }
            manifest_path.write_text(
                json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            os.chmod(manifest_path, 0o600)
            manifest_artifact = _artifact("manifest", _MANIFEST_FILE, manifest_path)
            artifacts = [database_artifact, filestore_artifact, manifest_artifact]
            return {
                "state": "prepared",
                "manifest_sha256": manifest_artifact["sha256"],
                "total_size_bytes": sum(int(item["size_bytes"]) for item in artifacts),
                "artifacts": artifacts,
            }
        except ProvisionerError:
            shutil.rmtree(workspace, ignore_errors=True)
            raise
        except OSError as exc:
            shutil.rmtree(workspace, ignore_errors=True)
            raise ProvisionerError("backup_workspace_write_failed") from exc
