from __future__ import annotations

import hashlib
import json
import re
import shutil
import tarfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from dsx_node_agent.provisioner import ProvisionerConfig, ProvisionerError, ProvisioningEngine

_RESTORE_OPERATION = "restore_verified_backup"
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_DATABASE = re.compile(r"^[a-z][a-z0-9_]{2,62}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_RESTORE_INBOX_ROOT = Path("/var/lib/dsx-node-agent/restores")
_DATABASE_FILE = "database.dump"
_FILESTORE_FILE = "filestore.tar.gz"
_MANIFEST_FILE = "manifest.json"
_CREATEDB = "/usr/bin/createdb"
_DROPDB = "/usr/bin/dropdb"
_PG_RESTORE = "/usr/bin/pg_restore"
_PSQL = "/usr/bin/psql"
_MAX_ARCHIVE_MEMBERS = 1_000_000
_MAX_EXTRACTED_BYTES = 50 * 1024 * 1024 * 1024


@dataclass(frozen=True)
class RestoreArtifactExpectation:
    artifact_kind: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class RestoreRequest:
    operation_id: str
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
    artifacts: tuple[RestoreArtifactExpectation, ...]


def _string(value: Any, *, field: str, max_length: int) -> str:
    if not isinstance(value, str):
        raise ProvisionerError(f"invalid_{field}")
    result = value.strip()
    if not result or len(result) > max_length:
        raise ProvisionerError(f"invalid_{field}")
    return result


def _integer(value: Any, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ProvisionerError(f"invalid_{field}")
    return value


def _exact(value: dict[str, Any], expected: set[str], *, field: str) -> None:
    if set(value) != expected:
        raise ProvisionerError(f"invalid_{field}_fields")


def parse_restore_request(value: Any) -> RestoreRequest:
    if not isinstance(value, dict):
        raise ProvisionerError("invalid_request")
    _exact(value, {"operation_id", "type", "payload"}, field="request")
    operation_id = _string(value["operation_id"], field="operation_id", max_length=64)
    if not _SAFE_ID.fullmatch(operation_id):
        raise ProvisionerError("invalid_operation_id")
    if _string(value["type"], field="operation_type", max_length=64) != _RESTORE_OPERATION:
        raise ProvisionerError("unsupported_operation_type")

    payload = value["payload"]
    if not isinstance(payload, dict):
        raise ProvisionerError("invalid_payload")
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
        field="payload",
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
            raise ProvisionerError(f"invalid_{field}")
        ids[field] = item
    if ids["source_tenant_id"] == ids["target_tenant_id"]:
        raise ProvisionerError("restore_target_must_be_disposable")

    environment_kind = _string(
        payload["environment_kind"], field="environment_kind", max_length=32
    ).lower()
    if environment_kind != "test":
        raise ProvisionerError("restore_non_test_environment_blocked")

    source_database_name = _string(
        payload["source_database_name"], field="source_database_name", max_length=63
    ).lower()
    target_database_name = _string(
        payload["target_database_name"], field="target_database_name", max_length=63
    ).lower()
    if not _SAFE_DATABASE.fullmatch(source_database_name) or not _SAFE_DATABASE.fullmatch(target_database_name):
        raise ProvisionerError("invalid_database_name")
    if source_database_name == target_database_name:
        raise ProvisionerError("restore_target_database_conflict")

    manifest_sha256 = _string(
        payload["manifest_sha256"], field="manifest_sha256", max_length=64
    ).lower()
    if not _SHA256.fullmatch(manifest_sha256):
        raise ProvisionerError("invalid_manifest_sha256")
    total_size_bytes = _integer(payload["total_size_bytes"], field="total_size_bytes")

    raw_artifacts = payload["artifacts"]
    if not isinstance(raw_artifacts, list) or len(raw_artifacts) != 3:
        raise ProvisionerError("invalid_restore_artifacts")
    artifacts: list[RestoreArtifactExpectation] = []
    seen: set[str] = set()
    allowed = {"database_dump", "filestore_archive", "manifest"}
    for raw in raw_artifacts:
        if not isinstance(raw, dict):
            raise ProvisionerError("invalid_restore_artifact")
        _exact(raw, {"artifact_kind", "size_bytes", "sha256"}, field="restore_artifact")
        kind = _string(raw["artifact_kind"], field="artifact_kind", max_length=32)
        if kind not in allowed or kind in seen:
            raise ProvisionerError("invalid_artifact_kind")
        checksum = _string(raw["sha256"], field="artifact_sha256", max_length=64).lower()
        if not _SHA256.fullmatch(checksum):
            raise ProvisionerError("invalid_artifact_sha256")
        artifacts.append(
            RestoreArtifactExpectation(
                artifact_kind=kind,
                size_bytes=_integer(raw["size_bytes"], field="artifact_size_bytes"),
                sha256=checksum,
            )
        )
        seen.add(kind)
    if seen != allowed or sum(item.size_bytes for item in artifacts) != total_size_bytes:
        raise ProvisionerError("restore_artifact_set_mismatch")
    manifest = next(item for item in artifacts if item.artifact_kind == "manifest")
    if manifest.sha256 != manifest_sha256:
        raise ProvisionerError("restore_manifest_checksum_mismatch")

    return RestoreRequest(
        operation_id=operation_id,
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
        artifacts=tuple(artifacts),
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise ProvisionerError("restore_checksum_failed") from exc
    return digest.hexdigest()


class RestoreEngine:
    def __init__(self, config: ProvisionerConfig, provisioning: ProvisioningEngine) -> None:
        self.config = config
        self.provisioning = provisioning

    def _workspace(self, operation_id: str) -> Path:
        if _RESTORE_INBOX_ROOT.is_symlink():
            raise ProvisionerError("restore_inbox_symlink_blocked")
        workspace = _RESTORE_INBOX_ROOT / operation_id
        if workspace.is_symlink() or not workspace.is_dir():
            raise ProvisionerError("restore_workspace_missing")
        return workspace

    @staticmethod
    def _expected_files(request: RestoreRequest) -> dict[str, tuple[Path, RestoreArtifactExpectation]]:
        workspace = _RESTORE_INBOX_ROOT / request.operation_id
        names = {
            "database_dump": _DATABASE_FILE,
            "filestore_archive": _FILESTORE_FILE,
            "manifest": _MANIFEST_FILE,
        }
        return {
            item.artifact_kind: (workspace / names[item.artifact_kind], item)
            for item in request.artifacts
        }

    def _validate_local_artifacts(self, request: RestoreRequest) -> dict[str, Path]:
        self._workspace(request.operation_id)
        files = self._expected_files(request)
        result: dict[str, Path] = {}
        for kind, (path, expected) in files.items():
            if path.is_symlink() or not path.is_file():
                raise ProvisionerError("restore_artifact_missing")
            try:
                size = path.stat().st_size
            except OSError as exc:
                raise ProvisionerError("restore_artifact_stat_failed") from exc
            if size != expected.size_bytes or _sha256_file(path) != expected.sha256:
                raise ProvisionerError("restore_artifact_checksum_mismatch")
            result[kind] = path
        return result

    @staticmethod
    def _validate_manifest(request: RestoreRequest, path: Path) -> None:
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ProvisionerError("restore_manifest_invalid") from exc
        if not isinstance(manifest, dict):
            raise ProvisionerError("restore_manifest_invalid")
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
            raise ProvisionerError("restore_manifest_schema_mismatch")
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
        if identity != (
            1,
            request.backup_job_id,
            request.source_tenant_id,
            "test",
            request.template_id,
            request.source_provisioning_operation_id,
            request.source_database_name,
            "full",
        ):
            raise ProvisionerError("restore_manifest_identity_mismatch")
        if not isinstance(manifest.get("created_at"), str) or not manifest["created_at"]:
            raise ProvisionerError("restore_manifest_schema_mismatch")
        expected = {item.artifact_kind: item for item in request.artifacts}
        raw_artifacts = manifest.get("artifacts")
        if not isinstance(raw_artifacts, list) or len(raw_artifacts) != 2:
            raise ProvisionerError("restore_manifest_artifacts_mismatch")
        names = {"database_dump": _DATABASE_FILE, "filestore_archive": _FILESTORE_FILE}
        seen: set[str] = set()
        for raw in raw_artifacts:
            if not isinstance(raw, dict) or set(raw) != {"artifact_kind", "file_name", "size_bytes", "sha256"}:
                raise ProvisionerError("restore_manifest_artifacts_mismatch")
            kind = raw.get("artifact_kind")
            if kind not in names or kind in seen:
                raise ProvisionerError("restore_manifest_artifacts_mismatch")
            expected_item = expected[kind]
            if (
                raw.get("file_name") != names[kind]
                or raw.get("size_bytes") != expected_item.size_bytes
                or raw.get("sha256") != expected_item.sha256
            ):
                raise ProvisionerError("restore_manifest_artifacts_mismatch")
            seen.add(kind)
        if seen != set(names):
            raise ProvisionerError("restore_manifest_artifacts_mismatch")

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
        return (parts[0], parts[1], parts[2]) if len(parts) == 3 else None

    def _write_target_marker(self, request: RestoreRequest) -> None:
        sql = (
            "CREATE TABLE IF NOT EXISTS public.dsx_provisioning_meta ("
            "singleton smallint PRIMARY KEY CHECK (singleton = 1), "
            "tenant_id text NOT NULL, template_id text NOT NULL, operation_id text NOT NULL, "
            "created_at timestamptz NOT NULL DEFAULT now()); "
            "DELETE FROM public.dsx_provisioning_meta; "
            "INSERT INTO public.dsx_provisioning_meta "
            "(singleton, tenant_id, template_id, operation_id) "
            f"VALUES (1, '{request.target_tenant_id}', '{request.template_id}', '{request.operation_id}');"
        )
        result = self.provisioning._run_postgres(
            [
                _PSQL,
                "-X",
                "-q",
                "--no-password",
                "--set=ON_ERROR_STOP=1",
                f"--dbname={request.target_database_name}",
                "--command",
                sql,
            ],
            timeout=20,
        )
        if result.returncode != 0:
            raise ProvisionerError("restore_marker_write_failed")

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
        return result.stdout.strip() or None

    def _validate_required_modules(
        self,
        database_name: str,
        required_modules: frozenset[str],
    ) -> None:
        for module in sorted(required_modules):
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
                        "SELECT CASE WHEN EXISTS (SELECT 1 FROM ir_module_module "
                        f"WHERE name = '{module}' AND state = 'installed') THEN 1 ELSE 0 END;"
                    ),
                ],
                timeout=10,
                capture_stdout=True,
            )
            if result.returncode != 0 or result.stdout.strip() != "1":
                raise ProvisionerError("restore_required_module_not_installed")

    def _create_and_restore_database(self, request: RestoreRequest, dump_path: Path, owner: str) -> None:
        created = self.provisioning._run_postgres(
            [
                _CREATEDB,
                f"--owner={owner}",
                "--template=template0",
                "--encoding=UTF8",
                request.target_database_name,
            ],
            timeout=60,
        )
        if created.returncode != 0:
            raise ProvisionerError("restore_database_create_failed")
        try:
            with dump_path.open("rb") as dump_handle:
                restored = self.provisioning._run_postgres(
                    [
                        _PG_RESTORE,
                        "--no-owner",
                        "--no-privileges",
                        "--exit-on-error",
                        f"--dbname={request.target_database_name}",
                    ],
                    timeout=1800,
                    stdin_handle=dump_handle,
                )
        except OSError as exc:
            raise ProvisionerError("restore_database_dump_unavailable") from exc
        if restored.returncode != 0:
            raise ProvisionerError("restore_database_restore_failed")

    @staticmethod
    def _safe_member_relative(member: tarfile.TarInfo, source_database_name: str) -> tuple[str, ...]:
        if member.issym() or member.islnk() or member.isdev() or member.isfifo():
            raise ProvisionerError("restore_filestore_unsafe_member")
        name = PurePosixPath(member.name)
        if name.is_absolute() or ".." in name.parts or not name.parts:
            raise ProvisionerError("restore_filestore_path_traversal")
        if name.parts[0] != source_database_name:
            raise ProvisionerError("restore_filestore_root_mismatch")
        return tuple(part for part in name.parts[1:] if part not in {"", "."})

    def _extract_filestore(
        self,
        archive_path: Path,
        source_database_name: str,
        staging: Path,
    ) -> None:
        count = 0
        extracted_bytes = 0
        try:
            with tarfile.open(archive_path, "r:gz") as archive:
                for member in archive:
                    count += 1
                    if count > _MAX_ARCHIVE_MEMBERS:
                        raise ProvisionerError("restore_filestore_too_many_members")
                    relative = self._safe_member_relative(member, source_database_name)
                    if not relative:
                        if not member.isdir():
                            raise ProvisionerError("restore_filestore_root_invalid")
                        continue
                    target = staging.joinpath(*relative)
                    if target.exists() or target.is_symlink():
                        if member.isdir() and target.is_dir() and not target.is_symlink():
                            continue
                        raise ProvisionerError("restore_filestore_duplicate_member")
                    if member.isdir():
                        target.mkdir(parents=True, mode=0o700)
                        continue
                    if not member.isfile():
                        raise ProvisionerError("restore_filestore_unsafe_member")
                    extracted_bytes += member.size
                    if extracted_bytes > _MAX_EXTRACTED_BYTES:
                        raise ProvisionerError("restore_filestore_too_large")
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    source = archive.extractfile(member)
                    if source is None:
                        raise ProvisionerError("restore_filestore_member_unreadable")
                    with source, target.open("xb") as output:
                        remaining = member.size
                        while remaining:
                            chunk = source.read(min(1024 * 1024, remaining))
                            if not chunk:
                                raise ProvisionerError("restore_filestore_member_truncated")
                            output.write(chunk)
                            remaining -= len(chunk)
                        if source.read(1):
                            raise ProvisionerError("restore_filestore_member_oversized")
                    target.chmod(0o600)
        except ProvisionerError:
            raise
        except (OSError, tarfile.TarError) as exc:
            raise ProvisionerError("restore_filestore_archive_invalid") from exc

    def _drop_database(self, database_name: str) -> None:
        self.provisioning._run_postgres(
            [_DROPDB, "--if-exists", "--force", database_name],
            timeout=60,
        )

    def _validated_replay(
        self,
        request: RestoreRequest,
        profile_owner: str,
        target_filestore: Path,
        required_modules: frozenset[str],
    ) -> bool:
        if not self.provisioning._database_exists(request.target_database_name):
            return False
        marker = self._read_full_marker(request.target_database_name)
        if marker != (request.target_tenant_id, request.template_id, request.operation_id):
            raise ProvisionerError("restore_database_name_conflict")
        if self._database_owner(request.target_database_name) != profile_owner:
            raise ProvisionerError("restore_database_owner_mismatch")
        if target_filestore.is_symlink() or not target_filestore.is_dir():
            raise ProvisionerError("restore_filestore_missing")
        if not self.provisioning._source_is_odoo(request.target_database_name):
            raise ProvisionerError("restore_odoo_schema_invalid")
        self._validate_required_modules(request.target_database_name, required_modules)
        return True

    def restore(self, request: RestoreRequest) -> dict[str, str]:
        if not self.config.enabled or self.config.phase != "test-only" or request.environment_kind != "test":
            raise ProvisionerError("restore_non_test_environment_blocked")
        profile = self.config.profiles.get(request.template_id)
        if profile is None:
            raise ProvisionerError("local_template_profile_missing")
        if request.target_database_name == profile.source_database:
            raise ProvisionerError("restore_golden_target_blocked")
        if not request.target_database_name.startswith(f"{profile.database_prefix}_restore_"):
            raise ProvisionerError("restore_database_prefix_mismatch")
        if request.source_database_name == profile.source_database:
            raise ProvisionerError("restore_golden_source_blocked")

        files = self._validate_local_artifacts(request)
        self._validate_manifest(request, files["manifest"])

        root = profile.filestore_root.resolve()
        target_filestore = root / request.target_database_name
        if self._validated_replay(
            request,
            profile.database_owner,
            target_filestore,
            profile.allowed_modules,
        ):
            return {"state": "validated", "database_name": request.target_database_name}
        if target_filestore.exists() or target_filestore.is_symlink():
            raise ProvisionerError("restore_filestore_name_conflict")

        staging = root / f".dsx-restore-{request.operation_id}"
        if staging.exists() or staging.is_symlink():
            raise ProvisionerError("restore_filestore_staging_conflict")

        database_created = False
        try:
            staging.mkdir(mode=0o700)
            self._extract_filestore(files["filestore_archive"], request.source_database_name, staging)
            self.provisioning._chown_tree(staging, profile.filestore_user, profile.filestore_group)

            self._create_and_restore_database(request, files["database_dump"], profile.database_owner)
            database_created = True
            if self._database_owner(request.target_database_name) != profile.database_owner:
                raise ProvisionerError("restore_database_owner_mismatch")
            if not self.provisioning._source_is_odoo(request.target_database_name):
                raise ProvisionerError("restore_odoo_schema_invalid")
            if self._read_full_marker(request.target_database_name) != (
                request.source_tenant_id,
                request.template_id,
                request.source_provisioning_operation_id,
            ):
                raise ProvisionerError("restore_source_marker_mismatch")
            self._validate_required_modules(request.target_database_name, profile.allowed_modules)

            self._write_target_marker(request)
            if self._read_full_marker(request.target_database_name) != (
                request.target_tenant_id,
                request.template_id,
                request.operation_id,
            ):
                raise ProvisionerError("restore_target_marker_mismatch")
            staging.rename(target_filestore)
            return {"state": "validated", "database_name": request.target_database_name}
        except ProvisionerError:
            if database_created or self.provisioning._database_exists(request.target_database_name):
                self._drop_database(request.target_database_name)
            shutil.rmtree(staging, ignore_errors=True)
            if target_filestore.exists() and not target_filestore.is_symlink():
                marker = None
                if self.provisioning._database_exists(request.target_database_name):
                    marker = self._read_full_marker(request.target_database_name)
                if marker != (request.target_tenant_id, request.template_id, request.operation_id):
                    shutil.rmtree(target_filestore, ignore_errors=True)
            raise
        except OSError as exc:
            if database_created or self.provisioning._database_exists(request.target_database_name):
                self._drop_database(request.target_database_name)
            shutil.rmtree(staging, ignore_errors=True)
            raise ProvisionerError("restore_filestore_finalize_failed") from exc