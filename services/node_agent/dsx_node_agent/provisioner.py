from __future__ import annotations

# ruff: noqa: I001

import argparse
import grp
import json
import os
import pwd
import re
import shutil
import socketserver
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO


_MAX_REQUEST_BYTES = 16 * 1024
_MAX_RESPONSE_BYTES = 8 * 1024
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_DATABASE = re.compile(r"^[a-z][a-z0-9_]{2,62}$")
_SAFE_MODULE = re.compile(r"^[A-Za-z0-9_]{1,120}$")
_ALLOWED_SECTORS = {"restaurant", "cafe", "retail", "supermarket"}
_ALLOWED_OPERATION = "provision_odoo_environment"
_ALLOWED_NON_PRODUCTION_ENVIRONMENTS = {"test", "trial"}
_ALLOWED_PHASES = {"test-only", "trial-enabled"}

_PG_DUMP = "/usr/bin/pg_dump"
_PG_RESTORE = "/usr/bin/pg_restore"
_CREATEDB = "/usr/bin/createdb"
_DROPDB = "/usr/bin/dropdb"
_PSQL = "/usr/bin/psql"
_RUNUSER = "/usr/sbin/runuser"


class ProvisionerError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ProvisionRequest:
    operation_id: str
    tenant_id: str
    tenant_slug: str
    sector: str
    environment_kind: str
    template_id: str
    template_version: int
    odoo_major: int
    database_name: str
    modules: tuple[str, ...]


@dataclass(frozen=True)
class ProvisionerProfile:
    template_id: str
    source_database: str
    database_prefix: str
    database_owner: str
    filestore_root: Path
    filestore_user: str
    filestore_group: str
    allowed_modules: frozenset[str]
    allow_empty_filestore: bool


@dataclass(frozen=True)
class ProvisionerConfig:
    enabled: bool
    phase: str
    postgres_os_user: str
    work_root: Path
    profiles: dict[str, ProvisionerProfile]


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str


def _string(value: Any, *, field: str, max_length: int) -> str:
    if not isinstance(value, str):
        raise ProvisionerError(f"invalid_{field}")
    result = value.strip()
    if not result or len(result) > max_length:
        raise ProvisionerError(f"invalid_{field}")
    return result


def _integer(value: Any, *, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProvisionerError(f"invalid_{field}")
    if value < minimum or value > maximum:
        raise ProvisionerError(f"invalid_{field}")
    return value


def _exact_keys(data: dict[str, Any], expected: set[str], *, field: str) -> None:
    if set(data) != expected:
        raise ProvisionerError(f"invalid_{field}_fields")


def parse_request(value: Any) -> ProvisionRequest:
    if not isinstance(value, dict):
        raise ProvisionerError("invalid_request")
    _exact_keys(value, {"operation_id", "type", "payload"}, field="request")

    operation_id = _string(value["operation_id"], field="operation_id", max_length=64)
    if not _SAFE_ID.fullmatch(operation_id):
        raise ProvisionerError("invalid_operation_id")

    operation_type = _string(value["type"], field="operation_type", max_length=64)
    if operation_type != _ALLOWED_OPERATION:
        raise ProvisionerError("unsupported_operation_type")

    payload = value["payload"]
    if not isinstance(payload, dict):
        raise ProvisionerError("invalid_payload")
    _exact_keys(
        payload,
        {
            "tenant_id",
            "tenant_slug",
            "sector",
            "environment_kind",
            "template_id",
            "template_version",
            "odoo_major",
            "database_name",
            "modules",
        },
        field="payload",
    )

    tenant_id = _string(payload["tenant_id"], field="tenant_id", max_length=64)
    if not _SAFE_ID.fullmatch(tenant_id):
        raise ProvisionerError("invalid_tenant_id")
    tenant_slug = _string(payload["tenant_slug"], field="tenant_slug", max_length=64).lower()
    sector = _string(payload["sector"], field="sector", max_length=32).lower()
    if sector not in _ALLOWED_SECTORS:
        raise ProvisionerError("invalid_sector")

    environment_kind = _string(
        payload["environment_kind"], field="environment_kind", max_length=32
    ).lower()
    if environment_kind == "production":
        raise ProvisionerError("production_environment_blocked")
    if environment_kind not in _ALLOWED_NON_PRODUCTION_ENVIRONMENTS:
        raise ProvisionerError("invalid_environment_kind")

    template_id = _string(payload["template_id"], field="template_id", max_length=96)
    if not _SAFE_ID.fullmatch(template_id):
        raise ProvisionerError("invalid_template_id")

    template_version = _integer(
        payload["template_version"], field="template_version", minimum=1, maximum=10000
    )
    odoo_major = _integer(payload["odoo_major"], field="odoo_major", minimum=18, maximum=30)
    if odoo_major != 18:
        raise ProvisionerError("unsupported_odoo_major")

    database_name = _string(payload["database_name"], field="database_name", max_length=63)
    if not _SAFE_DATABASE.fullmatch(database_name):
        raise ProvisionerError("invalid_database_name")

    raw_modules = payload["modules"]
    if not isinstance(raw_modules, list) or len(raw_modules) > 100:
        raise ProvisionerError("invalid_modules")
    modules: list[str] = []
    for item in raw_modules:
        module = _string(item, field="module", max_length=120)
        if not _SAFE_MODULE.fullmatch(module):
            raise ProvisionerError("invalid_module")
        if module not in modules:
            modules.append(module)

    return ProvisionRequest(
        operation_id=operation_id,
        tenant_id=tenant_id,
        tenant_slug=tenant_slug,
        sector=sector,
        environment_kind=environment_kind,
        template_id=template_id,
        template_version=template_version,
        odoo_major=odoo_major,
        database_name=database_name,
        modules=tuple(modules),
    )


def _safe_absolute_path(value: Any, *, field: str) -> Path:
    raw = _string(value, field=field, max_length=512)
    path = Path(raw)
    if not path.is_absolute() or ".." in path.parts:
        raise ProvisionerError(f"invalid_{field}")
    return path


def _safe_database(value: Any, *, field: str) -> str:
    database = _string(value, field=field, max_length=63).lower()
    if not _SAFE_DATABASE.fullmatch(database):
        raise ProvisionerError(f"invalid_{field}")
    return database


def _safe_account(value: Any, *, field: str) -> str:
    account = _string(value, field=field, max_length=64)
    if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,63}", account):
        raise ProvisionerError(f"invalid_{field}")
    return account


def parse_config(value: Any) -> ProvisionerConfig:
    if not isinstance(value, dict):
        raise ProvisionerError("invalid_config")
    _exact_keys(
        value,
        {"enabled", "phase", "postgres_os_user", "work_root", "profiles"},
        field="config",
    )
    if not isinstance(value["enabled"], bool):
        raise ProvisionerError("invalid_enabled")
    phase = _string(value["phase"], field="phase", max_length=32)
    if phase not in _ALLOWED_PHASES:
        raise ProvisionerError("invalid_phase")
    postgres_os_user = _safe_account(value["postgres_os_user"], field="postgres_os_user")
    work_root = _safe_absolute_path(value["work_root"], field="work_root")

    raw_profiles = value["profiles"]
    if not isinstance(raw_profiles, dict) or len(raw_profiles) > 20:
        raise ProvisionerError("invalid_profiles")

    profiles: dict[str, ProvisionerProfile] = {}
    for raw_template_id, raw_profile in raw_profiles.items():
        template_id = _string(raw_template_id, field="profile_template_id", max_length=96)
        if not _SAFE_ID.fullmatch(template_id) or not isinstance(raw_profile, dict):
            raise ProvisionerError("invalid_profile")
        _exact_keys(
            raw_profile,
            {
                "source_database",
                "database_prefix",
                "database_owner",
                "filestore_root",
                "filestore_user",
                "filestore_group",
                "allowed_modules",
                "allow_empty_filestore",
            },
            field="profile",
        )
        source_database = _safe_database(raw_profile["source_database"], field="source_database")
        database_prefix = _safe_database(raw_profile["database_prefix"], field="database_prefix")
        database_owner = _safe_account(raw_profile["database_owner"], field="database_owner")
        filestore_root = _safe_absolute_path(raw_profile["filestore_root"], field="filestore_root")
        filestore_user = _safe_account(raw_profile["filestore_user"], field="filestore_user")
        filestore_group = _safe_account(raw_profile["filestore_group"], field="filestore_group")

        raw_allowed = raw_profile["allowed_modules"]
        if not isinstance(raw_allowed, list) or len(raw_allowed) > 100:
            raise ProvisionerError("invalid_allowed_modules")
        allowed: set[str] = set()
        for item in raw_allowed:
            module = _string(item, field="allowed_module", max_length=120)
            if not _SAFE_MODULE.fullmatch(module):
                raise ProvisionerError("invalid_allowed_module")
            allowed.add(module)
        if not isinstance(raw_profile["allow_empty_filestore"], bool):
            raise ProvisionerError("invalid_allow_empty_filestore")

        profiles[template_id] = ProvisionerProfile(
            template_id=template_id,
            source_database=source_database,
            database_prefix=database_prefix,
            database_owner=database_owner,
            filestore_root=filestore_root,
            filestore_user=filestore_user,
            filestore_group=filestore_group,
            allowed_modules=frozenset(allowed),
            allow_empty_filestore=raw_profile["allow_empty_filestore"],
        )

    return ProvisionerConfig(
        enabled=value["enabled"],
        phase=phase,
        postgres_os_user=postgres_os_user,
        work_root=work_root,
        profiles=profiles,
    )


def load_secure_config(path: Path) -> ProvisionerConfig:
    try:
        info = path.stat()
    except OSError as exc:
        raise ProvisionerError("config_unavailable") from exc
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
        raise ProvisionerError("config_permissions_insecure")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProvisionerError("config_invalid_json") from exc
    return parse_config(raw)


class ProvisioningEngine:
    def __init__(self, config: ProvisionerConfig) -> None:
        self.config = config

    def _run_postgres(
        self,
        argv: list[str],
        *,
        timeout: int = 600,
        capture_stdout: bool = False,
        stdin_handle: BinaryIO | None = None,
        stdout_handle: BinaryIO | None = None,
    ) -> CommandResult:
        command = [
            _RUNUSER,
            "--user",
            self.config.postgres_os_user,
            "--",
            *argv,
        ]
        stdout_target: Any
        if stdout_handle is not None:
            stdout_target = stdout_handle
        elif capture_stdout:
            stdout_target = subprocess.PIPE
        else:
            stdout_target = subprocess.DEVNULL
        try:
            completed = subprocess.run(
                command,
                check=False,
                stdin=stdin_handle if stdin_handle is not None else subprocess.DEVNULL,
                stdout=stdout_target,
                stderr=subprocess.DEVNULL,
                text=capture_stdout and stdout_handle is None,
                timeout=timeout,
                env={"PATH": "/usr/bin:/bin", "PGCONNECT_TIMEOUT": "5"},
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ProvisionerError("postgres_command_unavailable") from exc
        stdout = completed.stdout[:4096] if isinstance(completed.stdout, str) else ""
        return CommandResult(returncode=completed.returncode, stdout=stdout)

    def _database_exists(self, database_name: str) -> bool:
        result = self._run_postgres(
            [
                _PSQL,
                "-X",
                "-A",
                "-t",
                "-q",
                "--no-password",
                "--dbname=postgres",
                "--command",
                f"SELECT 1 FROM pg_database WHERE datname = '{database_name}' LIMIT 1;",
            ],
            timeout=10,
            capture_stdout=True,
        )
        if result.returncode != 0:
            raise ProvisionerError("postgres_inventory_failed")
        return result.stdout.strip() == "1"

    def _source_is_odoo(self, database_name: str) -> bool:
        result = self._run_postgres(
            [
                _PSQL,
                "-X",
                "-A",
                "-t",
                "-q",
                "--no-password",
                f"--dbname={database_name}",
                "--command",
                "SELECT CASE WHEN to_regclass('public.ir_module_module') IS NOT NULL THEN 1 ELSE 0 END;",
            ],
            timeout=10,
            capture_stdout=True,
        )
        return result.returncode == 0 and result.stdout.strip() == "1"

    def _read_marker(self, database_name: str) -> tuple[str, str] | None:
        result = self._run_postgres(
            [
                _PSQL,
                "-X",
                "-A",
                "-t",
                "-q",
                "--no-password",
                f"--dbname={database_name}",
                "--command",
                "SELECT tenant_id || E'\\t' || template_id FROM public.dsx_provisioning_meta WHERE singleton = 1;",
            ],
            timeout=10,
            capture_stdout=True,
        )
        if result.returncode != 0:
            return None
        parts = result.stdout.strip().split("\t")
        if len(parts) != 2:
            return None
        return parts[0], parts[1]

    def _write_marker(self, request: ProvisionRequest) -> None:
        sql = (
            "CREATE TABLE IF NOT EXISTS public.dsx_provisioning_meta ("
            "singleton smallint PRIMARY KEY CHECK (singleton = 1), "
            "tenant_id text NOT NULL, template_id text NOT NULL, operation_id text NOT NULL, "
            "created_at timestamptz NOT NULL DEFAULT now()); "
            "DELETE FROM public.dsx_provisioning_meta; "
            "INSERT INTO public.dsx_provisioning_meta "
            "(singleton, tenant_id, template_id, operation_id) "
            f"VALUES (1, '{request.tenant_id}', '{request.template_id}', '{request.operation_id}');"
        )
        result = self._run_postgres(
            [
                _PSQL,
                "-X",
                "-q",
                "--no-password",
                "--set=ON_ERROR_STOP=1",
                f"--dbname={request.database_name}",
                "--command",
                sql,
            ],
            timeout=20,
        )
        if result.returncode != 0:
            raise ProvisionerError("provisioning_marker_failed")

    def _validate_modules(self, request: ProvisionRequest) -> None:
        for module in request.modules:
            result = self._run_postgres(
                [
                    _PSQL,
                    "-X",
                    "-A",
                    "-t",
                    "-q",
                    "--no-password",
                    f"--dbname={request.database_name}",
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
                raise ProvisionerError("required_module_not_installed")

    @staticmethod
    def _chown_tree(path: Path, user: str, group: str) -> None:
        try:
            uid = pwd.getpwnam(user).pw_uid
            gid = grp.getgrnam(group).gr_gid
        except KeyError as exc:
            raise ProvisionerError("filestore_account_missing") from exc
        try:
            os.chown(path, uid, gid)
            for root, dirs, files in os.walk(path):
                for name in dirs:
                    os.chown(Path(root) / name, uid, gid)
                for name in files:
                    os.chown(Path(root) / name, uid, gid)
        except OSError as exc:
            raise ProvisionerError("filestore_ownership_failed") from exc

    def _prepare_filestore(self, request: ProvisionRequest, profile: ProvisionerProfile) -> bool:
        root = profile.filestore_root.resolve()
        source = root / profile.source_database
        target = root / request.database_name

        if target.exists():
            if not target.is_dir():
                raise ProvisionerError("filestore_name_conflict")
            return False

        try:
            if source.is_dir():
                shutil.copytree(source, target, symlinks=False)
            elif profile.allow_empty_filestore:
                target.mkdir(parents=False, mode=0o700)
            else:
                raise ProvisionerError("source_filestore_missing")
            self._chown_tree(target, profile.filestore_user, profile.filestore_group)
            return True
        except ProvisionerError:
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
            raise
        except OSError as exc:
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
            raise ProvisionerError("filestore_copy_failed") from exc

    def _drop_database(self, database_name: str) -> None:
        self._run_postgres(
            [_DROPDB, "--if-exists", "--force", database_name],
            timeout=60,
        )

    def _clone_database(self, request: ProvisionRequest, profile: ProvisionerProfile) -> None:
        self.config.work_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix="job-", dir=self.config.work_root) as raw_work:
            dump_path = Path(raw_work) / "template.dump"
            with dump_path.open("wb") as dump_handle:
                dumped = self._run_postgres(
                    [
                        _PG_DUMP,
                        "--format=custom",
                        "--no-owner",
                        "--no-privileges",
                        f"--dbname={profile.source_database}",
                    ],
                    timeout=900,
                    stdout_handle=dump_handle,
                )
            if dumped.returncode != 0:
                raise ProvisionerError("template_dump_failed")

            created = self._run_postgres(
                [
                    _CREATEDB,
                    f"--owner={profile.database_owner}",
                    "--template=template0",
                    "--encoding=UTF8",
                    request.database_name,
                ],
                timeout=60,
            )
            if created.returncode != 0:
                raise ProvisionerError("database_create_failed")

            with dump_path.open("rb") as dump_handle:
                restored = self._run_postgres(
                    [
                        _PG_RESTORE,
                        "--no-owner",
                        "--no-privileges",
                        "--exit-on-error",
                        f"--role={profile.database_owner}",
                        f"--dbname={request.database_name}",
                    ],
                    timeout=1200,
                    stdin_handle=dump_handle,
                )
            if restored.returncode != 0:
                self._drop_database(request.database_name)
                raise ProvisionerError("database_restore_failed")

    def provision(self, request: ProvisionRequest) -> dict[str, str]:
        if not self.config.enabled:
            raise ProvisionerError("provisioner_disabled")
        if request.environment_kind == "trial" and self.config.phase != "trial-enabled":
            raise ProvisionerError("trial_environment_blocked")
        if request.environment_kind not in _ALLOWED_NON_PRODUCTION_ENVIRONMENTS:
            raise ProvisionerError("environment_not_allowed")
        profile = self.config.profiles.get(request.template_id)
        if profile is None:
            raise ProvisionerError("local_template_profile_missing")
        if not request.database_name.startswith(f"{profile.database_prefix}_"):
            raise ProvisionerError("database_prefix_mismatch")
        if request.modules and not set(request.modules).issubset(profile.allowed_modules):
            raise ProvisionerError("module_not_allowed_by_local_profile")
        if request.database_name == profile.source_database:
            raise ProvisionerError("source_target_database_conflict")
        if not self._database_exists(profile.source_database):
            raise ProvisionerError("source_database_missing")
        if not self._source_is_odoo(profile.source_database):
            raise ProvisionerError("source_database_not_odoo")

        if self._database_exists(request.database_name):
            marker = self._read_marker(request.database_name)
            if marker != (request.tenant_id, request.template_id):
                raise ProvisionerError("database_name_conflict")
            self._prepare_filestore(request, profile)
            self._validate_modules(request)
            return {"state": "ready", "database_name": request.database_name}

        database_created = False
        filestore_created = False
        target_filestore = profile.filestore_root.resolve() / request.database_name
        try:
            self._clone_database(request, profile)
            database_created = True
            filestore_created = self._prepare_filestore(request, profile)
            self._write_marker(request)
            if not self._source_is_odoo(request.database_name):
                raise ProvisionerError("odoo_schema_invalid")
            self._validate_modules(request)
            return {"state": "ready", "database_name": request.database_name}
        except ProvisionerError:
            if filestore_created:
                shutil.rmtree(target_filestore, ignore_errors=True)
            if database_created:
                self._drop_database(request.database_name)
            raise


class _ProvisionRequestHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        raw = self.rfile.readline(_MAX_REQUEST_BYTES + 1)
        if len(raw) > _MAX_REQUEST_BYTES or not raw.endswith(b"\n"):
            self._write({"state": "failed", "error_code": "request_too_large"})
            return
        try:
            payload = json.loads(raw.decode("utf-8"))
            request = parse_request(payload)
            result = self.server.engine.provision(request)  # type: ignore[attr-defined]
            self._write(result)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._write({"state": "failed", "error_code": "invalid_json"})
        except ProvisionerError as exc:
            self._write({"state": "failed", "error_code": exc.code})
        except Exception:  # noqa: BLE001 - privilege boundary must never leak an exception.
            self._write({"state": "failed", "error_code": "internal_provisioner_error"})

    def _write(self, value: dict[str, str]) -> None:
        encoded = json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n"
        self.wfile.write(encoded[:_MAX_RESPONSE_BYTES])


class _UnixProvisioningServer(socketserver.UnixStreamServer):
    def __init__(self, socket_path: str, engine: ProvisioningEngine) -> None:
        self.engine = engine
        super().__init__(socket_path, _ProvisionRequestHandler)


def serve(config_path: Path, socket_path: Path) -> None:
    if os.geteuid() != 0:
        raise SystemExit("dsx-node-provisioner must run as root")
    config = load_secure_config(config_path)
    socket_path.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
    if socket_path.exists() or socket_path.is_socket():
        socket_path.unlink()

    engine = ProvisioningEngine(config)
    server = _UnixProvisioningServer(str(socket_path), engine)
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
    parser = argparse.ArgumentParser(description="DSX typed local provisioning helper")
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
