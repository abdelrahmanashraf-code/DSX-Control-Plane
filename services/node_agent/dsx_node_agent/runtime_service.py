from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dsx_node_agent import provisioner_service as base_service
from dsx_node_agent.provisioner import (
    ProvisionRequest,
    ProvisionerConfig,
    ProvisionerError,
    ProvisionerProfile,
    ProvisioningEngine,
)
from dsx_node_agent.provisioner_service import CleanupEngine, CleanupRequest

_RUNTIME_ROOT = Path("/var/odoo")
_SYSTEMD_DIR = Path("/etc/systemd/system")
_NGINX_DIR = Path("/etc/nginx/conf.d")
_SYSTEMCTL = "/usr/bin/systemctl"
_NGINX = "/usr/sbin/nginx"
_SERVICE_PREFIX = "odona-"
_SAFE_HOSTNAME = re.compile(
    r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
)
_RUNTIME: RuntimeLifecycle | None = None


@dataclass(frozen=True)
class RuntimeConfig:
    enabled: bool
    trial_base_domain: str
    http_port_start: int
    http_port_end: int
    runtime_user: str
    runtime_group: str
    health_timeout_seconds: int
    tls_certificate: Path | None
    tls_certificate_key: Path | None


def _text(value: Any, field: str, limit: int = 253) -> str:
    if not isinstance(value, str):
        raise ProvisionerError(f"invalid_runtime_{field}")
    value = value.strip()
    if not value or len(value) > limit:
        raise ProvisionerError(f"invalid_runtime_{field}")
    return value


def _account(value: Any, field: str) -> str:
    value = _text(value, field, 64)
    if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,63}", value):
        raise ProvisionerError(f"invalid_runtime_{field}")
    return value


def _optional_path(value: Any, field: str) -> Path | None:
    if value is None:
        return None
    path = Path(_text(value, field, 512))
    if not path.is_absolute() or ".." in path.parts:
        raise ProvisionerError(f"invalid_runtime_{field}")
    return path


def parse_runtime_config(value: Any) -> RuntimeConfig:
    expected = {
        "enabled",
        "trial_base_domain",
        "http_port_start",
        "http_port_end",
        "runtime_user",
        "runtime_group",
        "health_timeout_seconds",
        "tls_certificate",
        "tls_certificate_key",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise ProvisionerError("invalid_runtime_config_fields")
    if not isinstance(value["enabled"], bool):
        raise ProvisionerError("invalid_runtime_enabled")
    domain = _text(value["trial_base_domain"], "trial_base_domain").lower()
    if not _SAFE_HOSTNAME.fullmatch(domain):
        raise ProvisionerError("invalid_runtime_trial_base_domain")
    start, end = value["http_port_start"], value["http_port_end"]
    if (
        isinstance(start, bool)
        or isinstance(end, bool)
        or not isinstance(start, int)
        or not isinstance(end, int)
        or start < 1024
        or end > 65533
        or start % 2
        or end <= start
    ):
        raise ProvisionerError("invalid_runtime_port_range")
    timeout = value["health_timeout_seconds"]
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 10 <= timeout <= 600:
        raise ProvisionerError("invalid_runtime_health_timeout_seconds")
    cert = _optional_path(value["tls_certificate"], "tls_certificate")
    key = _optional_path(value["tls_certificate_key"], "tls_certificate_key")
    if (cert is None) != (key is None):
        raise ProvisionerError("invalid_runtime_tls_pair")
    return RuntimeConfig(
        enabled=value["enabled"],
        trial_base_domain=domain,
        http_port_start=start,
        http_port_end=end,
        runtime_user=_account(value["runtime_user"], "runtime_user"),
        runtime_group=_account(value["runtime_group"], "runtime_group"),
        health_timeout_seconds=timeout,
        tls_certificate=cert,
        tls_certificate_key=key,
    )


def load_runtime_config(path: Path) -> RuntimeConfig:
    try:
        info = path.stat()
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProvisionerError("runtime_config_unavailable") from exc
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
        raise ProvisionerError("runtime_config_permissions_insecure")
    return parse_runtime_config(raw)


class RuntimeLifecycle:
    def __init__(self, config: RuntimeConfig) -> None:
        self.config = config

    @staticmethod
    def _run(argv: list[str], timeout: int = 60) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run(
                argv,
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=timeout,
                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ProvisionerError("runtime_command_unavailable") from exc

    @staticmethod
    def _target(database_name: str) -> Path:
        target = _RUNTIME_ROOT / database_name
        if target.parent != _RUNTIME_ROOT:
            raise ProvisionerError("runtime_target_invalid")
        return target

    @staticmethod
    def _source(profile: ProvisionerProfile) -> Path:
        return _RUNTIME_ROOT / profile.source_database

    @staticmethod
    def _service_name(database_name: str) -> str:
        return f"{_SERVICE_PREFIX}{database_name}.service"

    @staticmethod
    def _service_path(database_name: str) -> Path:
        return _SYSTEMD_DIR / RuntimeLifecycle._service_name(database_name)

    @staticmethod
    def _nginx_path(database_name: str) -> Path:
        return _NGINX_DIR / f"dsx-trial-{database_name}.conf"

    def hostname(self, request: ProvisionRequest) -> str:
        hostname = f"{request.tenant_slug}.{self.config.trial_base_domain}".lower()
        if not _SAFE_HOSTNAME.fullmatch(hostname):
            raise ProvisionerError("runtime_hostname_invalid")
        return hostname

    @staticmethod
    def _marker(path: Path) -> dict[str, Any]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ProvisionerError("runtime_marker_invalid") from exc
        if not isinstance(value, dict):
            raise ProvisionerError("runtime_marker_invalid")
        return value

    @staticmethod
    def _port_available(port: int) -> bool:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False
        finally:
            probe.close()

    def allocate_ports(self) -> tuple[int, int]:
        used: set[int] = set()
        for marker_path in _RUNTIME_ROOT.glob("*/dsx-runtime.json"):
            try:
                marker = self._marker(marker_path)
                used.update((int(marker["http_port"]), int(marker["gevent_port"])))
            except (ProvisionerError, KeyError, TypeError, ValueError):
                continue
        for http in range(self.config.http_port_start, self.config.http_port_end, 2):
            gevent = http + 1
            if (
                http not in used
                and gevent not in used
                and self._port_available(http)
                and self._port_available(gevent)
            ):
                return http, gevent
        raise ProvisionerError("runtime_port_range_exhausted")

    @staticmethod
    def _set_option(text: str, key: str, value: str) -> str:
        pattern = re.compile(rf"(?m)^\s*{re.escape(key)}\s*=.*$")
        line = f"{key} = {value}"
        return pattern.sub(line, text, count=1) if pattern.search(text) else text.rstrip() + f"\n{line}\n"

    def _rewrite_odoo_config(self, target: Path, source: Path, database_name: str) -> None:
        path = target / "odoo.conf"
        try:
            text = path.read_text(encoding="utf-8").replace(str(source), str(target))
            text = self._set_option(text, "db_name", database_name)
            text = self._set_option(text, "list_db", "False")
            text = self._set_option(text, "proxy_mode", "True")
            path.write_text(text, encoding="utf-8")
        except OSError as exc:
            raise ProvisionerError("runtime_odoo_config_failed") from exc

    def _write_marker(
        self, target: Path, request: ProvisionRequest, http: int, gevent: int, hostname: str
    ) -> None:
        marker = {
            "tenant_id": request.tenant_id,
            "template_id": request.template_id,
            "operation_id": request.operation_id,
            "database_name": request.database_name,
            "hostname": hostname,
            "http_port": http,
            "gevent_port": gevent,
        }
        legacy = {
            "#": "Do not remove this autogenerated file!",
            "web_port": str(http),
            "gevent_port": str(gevent),
        }
        try:
            (target / "dsx-runtime.json").write_text(json.dumps(marker, indent=2) + "\n")
            (target / "meta.json").write_text(json.dumps(legacy, indent=2) + "\n")
        except OSError as exc:
            raise ProvisionerError("runtime_marker_write_failed") from exc

    def _service(self, request: ProvisionRequest, target: Path, http: int, gevent: int) -> str:
        return f"""[Unit]
Description=DSX Trial Odoo {request.database_name}
After=network.target postgresql.service

[Service]
Type=simple
User={self.config.runtime_user}
Group={self.config.runtime_group}
WorkingDirectory={target}
Environment=PATH={target}/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart={target}/venv/bin/python3 {target}/src/odoo-bin --config {target}/odoo.conf --http-interface=127.0.0.1 --http-port {http} --gevent-port {gevent} --logfile {target}/logs/odoo-server.log
Restart=on-failure
RestartSec=5
TimeoutStopSec=90
KillSignal=SIGINT

[Install]
WantedBy=multi-user.target
"""

    def _nginx(self, hostname: str, http: int, gevent: int) -> str:
        tls = ""
        if self.config.tls_certificate and self.config.tls_certificate_key:
            tls = (
                "  listen 443 ssl;\n"
                f"  ssl_certificate {self.config.tls_certificate};\n"
                f"  ssl_certificate_key {self.config.tls_certificate_key};\n"
                "  ssl_session_timeout 30m;\n"
            )
        return f"""server {{
  listen 80;
{tls}  server_name {hostname};
  proxy_read_timeout 720s;
  proxy_connect_timeout 720s;
  proxy_send_timeout 720s;
  client_max_body_size 0;

  location /websocket {{
    proxy_pass http://127.0.0.1:{gevent};
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
  }}

  location / {{
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_redirect off;
    proxy_pass http://127.0.0.1:{http};
  }}
}}
"""

    def _write_routes(self, request: ProvisionRequest, target: Path, http: int, gevent: int) -> None:
        try:
            service = self._service_path(request.database_name)
            nginx = self._nginx_path(request.database_name)
            service.write_text(self._service(request, target, http, gevent), encoding="utf-8")
            nginx.write_text(self._nginx(self.hostname(request), http, gevent), encoding="utf-8")
            os.chmod(service, 0o644)
            os.chmod(nginx, 0o644)
        except OSError as exc:
            raise ProvisionerError("runtime_route_write_failed") from exc

    def _reload(self) -> None:
        if self._run([_SYSTEMCTL, "daemon-reload"], 30).returncode != 0:
            raise ProvisionerError("runtime_systemd_reload_failed")
        if self._run([_NGINX, "-t"], 20).returncode != 0:
            raise ProvisionerError("runtime_nginx_config_invalid")
        if self._run([_SYSTEMCTL, "reload", "nginx"], 30).returncode != 0:
            raise ProvisionerError("runtime_nginx_reload_failed")

    def _health(self, port: int) -> None:
        deadline = time.monotonic() + self.config.health_timeout_seconds
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/web/login", timeout=3) as response:
                    if 200 <= response.status < 500:
                        return
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                pass
            time.sleep(1)
        raise ProvisionerError("runtime_odoo_healthcheck_failed")

    def ensure(self, request: ProvisionRequest, profile: ProvisionerProfile) -> None:
        source, target = self._source(profile), self._target(request.database_name)
        if target == source:
            raise ProvisionerError("runtime_source_target_conflict")
        if not source.is_dir() or not (source / "src" / "odoo-bin").is_file():
            raise ProvisionerError("runtime_source_missing")

        if target.exists():
            marker = self._marker(target / "dsx-runtime.json")
            actual = (
                marker.get("tenant_id"),
                marker.get("template_id"),
                marker.get("database_name"),
                marker.get("operation_id"),
            )
            expected = (
                request.tenant_id,
                request.template_id,
                request.database_name,
                request.operation_id,
            )
            if actual != expected:
                raise ProvisionerError("runtime_marker_mismatch")
            try:
                http, gevent = int(marker["http_port"]), int(marker["gevent_port"])
            except (KeyError, TypeError, ValueError) as exc:
                raise ProvisionerError("runtime_marker_invalid") from exc
        else:
            http, gevent = self.allocate_ports()
            try:
                shutil.copytree(source, target, symlinks=False)
                ProvisioningEngine._chown_tree(
                    target, self.config.runtime_user, self.config.runtime_group
                )
                self._rewrite_odoo_config(target, source, request.database_name)
                (target / "logs").mkdir(parents=True, exist_ok=True)
                self._write_marker(target, request, http, gevent, self.hostname(request))
            except (OSError, shutil.Error) as exc:
                shutil.rmtree(target, ignore_errors=True)
                raise ProvisionerError("runtime_materialization_failed") from exc

        try:
            self._write_routes(request, target, http, gevent)
            self._reload()
            service = self._service_name(request.database_name)
            if self._run([_SYSTEMCTL, "enable", "--now", service], 90).returncode != 0:
                raise ProvisionerError("runtime_service_start_failed")
            self._health(http)
            self._reload()
        except ProvisionerError:
            self.remove(request.database_name, profile.source_database, None)
            raise

    def remove(
        self,
        database_name: str,
        source_database: str,
        expected: tuple[str, str, str, str] | None,
    ) -> None:
        target, source = self._target(database_name), _RUNTIME_ROOT / source_database
        if target == source:
            raise ProvisionerError("runtime_cleanup_source_blocked")
        if target.is_symlink():
            raise ProvisionerError("runtime_cleanup_symlink_blocked")
        if target.exists() and expected is not None:
            marker = self._marker(target / "dsx-runtime.json")
            actual = (
                marker.get("tenant_id"),
                marker.get("template_id"),
                marker.get("database_name"),
                marker.get("operation_id"),
            )
            if actual != expected:
                raise ProvisionerError("runtime_cleanup_marker_mismatch")
        self._run([_SYSTEMCTL, "disable", "--now", self._service_name(database_name)], 60)
        try:
            self._service_path(database_name).unlink(missing_ok=True)
            self._nginx_path(database_name).unlink(missing_ok=True)
            if target.exists():
                shutil.rmtree(target)
        except OSError as exc:
            raise ProvisionerError("runtime_cleanup_remove_failed") from exc
        self._reload()


class RuntimeProvisioningEngine(ProvisioningEngine):
    def provision(self, request: ProvisionRequest) -> dict[str, str]:
        result = super().provision(request)
        if request.environment_kind != "trial":
            return result
        runtime = _runtime()
        if not runtime.config.enabled:
            raise ProvisionerError("runtime_disabled")
        profile = self.config.profiles[request.template_id]
        runtime.ensure(request, profile)
        return result


class RuntimeCleanupEngine(CleanupEngine):
    def cleanup(self, request: CleanupRequest) -> dict[str, str]:
        runtime = _runtime()
        if request.environment_kind == "trial" and runtime.config.enabled:
            profile = self.config.profiles.get(request.template_id)
            if profile is None:
                raise ProvisionerError("local_template_profile_missing")
            expected_db = (
                request.tenant_id,
                request.template_id,
                request.provisioning_operation_id,
            )
            if request.database_name == profile.source_database:
                raise ProvisionerError("cleanup_source_database_blocked")
            if not request.database_name.startswith(f"{profile.database_prefix}_"):
                raise ProvisionerError("database_prefix_mismatch")
            if not self.provisioning._database_exists(request.database_name):
                raise ProvisionerError("cleanup_database_missing")
            if self._database_owner(request.database_name) != profile.database_owner:
                raise ProvisionerError("cleanup_database_owner_mismatch")
            if self._read_full_marker(request.database_name) != expected_db:
                raise ProvisionerError("cleanup_marker_mismatch")
            runtime.remove(
                request.database_name,
                profile.source_database,
                (
                    request.tenant_id,
                    request.template_id,
                    request.database_name,
                    request.provisioning_operation_id,
                ),
            )
        return super().cleanup(request)


def _runtime() -> RuntimeLifecycle:
    if _RUNTIME is None:
        raise ProvisionerError("runtime_not_initialized")
    return _RUNTIME


def main() -> None:
    parser = argparse.ArgumentParser(description="DSX typed provisioner with Trial runtime lifecycle")
    parser.add_argument("command", choices=["serve"])
    parser.add_argument("--config", type=Path, default=Path("/etc/dsx-provisioner.json"))
    parser.add_argument("--runtime-config", type=Path, default=Path("/etc/dsx-runtime.json"))
    parser.add_argument("--socket", type=Path, default=Path("/run/dsx-provisioner/provisioner.sock"))
    args = parser.parse_args()

    global _RUNTIME
    _RUNTIME = RuntimeLifecycle(load_runtime_config(args.runtime_config))
    base_service.ProvisioningEngine = RuntimeProvisioningEngine
    base_service.CleanupEngine = RuntimeCleanupEngine
    base_service.serve(args.config, args.socket)


if __name__ == "__main__":
    main()
