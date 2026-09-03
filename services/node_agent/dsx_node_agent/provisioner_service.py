from __future__ import annotations

import argparse
import grp
import json
import os
import pwd
import re
import shutil
import socketserver
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dsx_node_agent.backup_service import BackupEngine, parse_backup_request
from dsx_node_agent.backup_stage_service import (
    BackupArtifactStager,
    parse_backup_stage_request,
)
from dsx_node_agent.provisioner import (
    ProvisionerConfig,
    ProvisionerError,
    ProvisioningEngine,
    load_secure_config,
    parse_request,
)
from dsx_node_agent.restore_service import RestoreEngine, parse_restore_request

_MAX_REQUEST_BYTES = 16 * 1024
_MAX_RESPONSE_BYTES = 8 * 1024
_ALLOWED_PROVISION = "provision_odoo_environment"
_ALLOWED_CLEANUP = "cleanup_test_odoo_environment"
_ALLOWED_BACKUP = "backup_odoo_environment"
_ALLOWED_BACKUP_STAGE = "stage_backup_for_upload"
_ALLOWED_BACKUP_PURGE = "purge_verified_backup"
_ALLOWED_RESTORE = "restore_verified_backup"
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_DATABASE = re.compile(r"^[a-z][a-z0-9_]{2,62}$")
_DROPDB = "/usr/bin/dropdb"
_PSQL = "/usr/bin/psql"


@dataclass(frozen=True)
class CleanupRequest:
    operation_id: str
    tenant_id: str
    template_id: str
    provisioning_operation_id: str
    environment_kind: str
    database_name: str


def _string(value: Any, *, field: str, max_length: int) -> str:
    if not isinstance(value, str):
        raise ProvisionerError(f"invalid_{field}")
    result = value.strip()
    if not result or len(result) > max_length:
        raise ProvisionerError(f"invalid_{field}")
    return result


def parse_cleanup_request(value: Any) -> CleanupRequest:
    if not isinstance(value, dict) or set(value) != {"operation_id", "type", "payload"}:
        raise ProvisionerError("invalid_request_fields")
    operation_id = _string(value["operation_id"], field="operation_id", max_length=64)
    if not _SAFE_ID.fullmatch(operation_id):
        raise ProvisionerError("invalid_operation_id")
    operation_type = _string(value["type"], field="operation_type", max_length=64)
    if operation_type != _ALLOWED_CLEANUP:
        raise ProvisionerError("unsupported_operation_type")

    payload = value["payload"]
    expected = {
        "tenant_id",
        "environment_kind",
        "template_id",
        "provisioning_operation_id",
        "database_name",
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
        raise ProvisionerError("cleanup_non_test_environment_blocked")

    database_name = _string(payload["database_name"], field="database_name", max_length=63).lower()
    if not _SAFE_DATABASE.fullmatch(database_name):
        raise ProvisionerError("invalid_database_name")

    return CleanupRequest(
        operation_id=operation_id,
        tenant_id=tenant_id,
        template_id=template_id,
        provisioning_operation_id=provisioning_operation_id,
        environment_kind=environment_kind,
        database_name=database_name,
    )


class CleanupEngine:
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
            raise ProvisionerError("cleanup_filestore_invalid")
        try:
            expected_uid = pwd.getpwnam(user).pw_uid
            expected_gid = grp.getgrnam(group).gr_gid
        except KeyError as exc:
            raise ProvisionerError("filestore_account_missing") from exc
        info = path.stat()
        if info.st_uid != expected_uid or info.st_gid != expected_gid:
            raise ProvisionerError("cleanup_filestore_owner_mismatch")
        for root, dirs, files in os.walk(path, followlinks=False):
            for name in [*dirs, *files]:
                if (Path(root) / name).is_symlink():
                    raise ProvisionerError("cleanup_filestore_symlink_blocked")

    def cleanup(self, request: CleanupRequest) -> dict[str, str]:
        if not self.config.enabled:
            raise ProvisionerError("provisioner_disabled")
        if self.config.phase != "test-only" or request.environment_kind != "test":
            raise ProvisionerError("cleanup_non_test_environment_blocked")

        profile = self.config.profiles.get(request.template_id)
        if profile is None:
            raise ProvisionerError("local_template_profile_missing")
        if request.database_name == profile.source_database:
            raise ProvisionerError("cleanup_source_database_blocked")
        if not request.database_name.startswith(f"{profile.database_prefix}_"):
            raise ProvisionerError("database_prefix_mismatch")
        if not self.provisioning._database_exists(request.database_name):
            raise ProvisionerError("cleanup_database_missing")
        if self._database_owner(request.database_name) != profile.database_owner:
            raise ProvisionerError("cleanup_database_owner_mismatch")

        expected_marker = (
            request.tenant_id,
            request.template_id,
            request.provisioning_operation_id,
        )
        if self._read_full_marker(request.database_name) != expected_marker:
            raise ProvisionerError("cleanup_marker_mismatch")

        root = profile.filestore_root.resolve()
        target = root / request.database_name
        self._validate_filestore(target, profile.filestore_user, profile.filestore_group)

        quarantine = root / f".dsx-cleanup-{request.operation_id}"
        if quarantine.exists() or quarantine.is_symlink():
            raise ProvisionerError("cleanup_quarantine_conflict")

        try:
            target.rename(quarantine)
        except OSError as exc:
            raise ProvisionerError("cleanup_filestore_quarantine_failed") from exc

        dropped = self.provisioning._run_postgres(
            [_DROPDB, "--if-exists", "--force", request.database_name],
            timeout=60,
        )
        if dropped.returncode != 0:
            try:
                quarantine.rename(target)
            except OSError:
                pass
            raise ProvisionerError("cleanup_database_drop_failed")
        if self.provisioning._database_exists(request.database_name):
            try:
                quarantine.rename(target)
            except OSError:
                pass
            raise ProvisionerError("cleanup_database_drop_unconfirmed")

        try:
            shutil.rmtree(quarantine)
        except OSError as exc:
            raise ProvisionerError("cleanup_filestore_remove_failed") from exc
        return {"state": "cleaned"}


class _TypedRequestHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        raw = self.rfile.readline(_MAX_REQUEST_BYTES + 1)
        if len(raw) > _MAX_REQUEST_BYTES or not raw.endswith(b"\n"):
            self._write({"state": "failed", "error_code": "request_too_large"})
            return
        try:
            payload = json.loads(raw.decode("utf-8"))
            operation_type = payload.get("type") if isinstance(payload, dict) else None
            if operation_type == _ALLOWED_PROVISION:
                request = parse_request(payload)
                result = self.server.provisioning.provision(request)  # type: ignore[attr-defined]
            elif operation_type == _ALLOWED_CLEANUP:
                request = parse_cleanup_request(payload)
                result = self.server.cleanup.cleanup(request)  # type: ignore[attr-defined]
            elif operation_type == _ALLOWED_BACKUP:
                request = parse_backup_request(payload)
                result = self.server.backup.backup(request)  # type: ignore[attr-defined]
            elif operation_type in {_ALLOWED_BACKUP_STAGE, _ALLOWED_BACKUP_PURGE}:
                request = parse_backup_stage_request(payload)
                if operation_type == _ALLOWED_BACKUP_STAGE:
                    result = self.server.backup_stager.stage(request)  # type: ignore[attr-defined]
                else:
                    result = self.server.backup_stager.purge(request)  # type: ignore[attr-defined]
            elif operation_type == _ALLOWED_RESTORE:
                request = parse_restore_request(payload)
                result = self.server.restore.restore(request)  # type: ignore[attr-defined]
            else:
                raise ProvisionerError("unsupported_operation_type")
            self._write(result)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._write({"state": "failed", "error_code": "invalid_json"})
        except ProvisionerError as exc:
            self._write({"state": "failed", "error_code": exc.code})
        except Exception:  # noqa: BLE001 - privilege boundary must never leak an exception.
            self._write({"state": "failed", "error_code": "internal_provisioner_error"})

    def _write(self, value: dict[str, Any]) -> None:
        encoded = json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n"
        self.wfile.write(encoded[:_MAX_RESPONSE_BYTES])


class _TypedUnixServer(socketserver.UnixStreamServer):
    def __init__(
        self,
        socket_path: str,
        provisioning: ProvisioningEngine,
        cleanup: CleanupEngine,
        backup: BackupEngine,
        backup_stager: BackupArtifactStager,
        restore: RestoreEngine,
    ) -> None:
        self.provisioning = provisioning
        self.cleanup = cleanup
        self.backup = backup
        self.backup_stager = backup_stager
        self.restore = restore
        super().__init__(socket_path, _TypedRequestHandler)


def serve(config_path: Path, socket_path: Path) -> None:
    if os.geteuid() != 0:
        raise SystemExit("dsx-node-provisioner must run as root")
    config = load_secure_config(config_path)
    socket_path.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
    if socket_path.exists() or socket_path.is_socket():
        socket_path.unlink()

    provisioning = ProvisioningEngine(config)
    cleanup = CleanupEngine(config, provisioning)
    backup = BackupEngine(config, provisioning)
    backup_stager = BackupArtifactStager(config)
    restore = RestoreEngine(config, provisioning)
    server = _TypedUnixServer(
        str(socket_path), provisioning, cleanup, backup, backup_stager, restore
    )
    os.chmod(socket_path, 0o660)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        try:
            socket_path.unlink()
        except FileNotFoundError:
            pass


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="DSX typed local provisioning, cleanup, backup and restore helper"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    serve_parser = sub.add_parser("serve")
    serve_parser.add_argument("--config", type=Path, default=Path("/etc/dsx-provisioner.json"))
    serve_parser.add_argument(
        "--socket", type=Path, default=Path("/run/dsx-provisioner/provisioner.sock")
    )
    return parser


def main() -> None:
    args = _parser().parse_args()
    if args.command == "serve":
        serve(args.config, args.socket)


if __name__ == "__main__":
    main()
