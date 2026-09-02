from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import psutil

_VERSION_LINE_LIMIT = 160
_DATABASE_OUTPUT_LIMIT = 131_072
_DATABASE_CACHE_TTL_SECONDS = 300.0
_SAFE_TEXT = re.compile(r"[^\x20-\x7E]")
_DATABASE_SQL = """
SELECT json_build_object(
    'server_version', current_setting('server_version'),
    'databases', COALESCE(
        json_agg(
            json_build_object(
                'name', datname,
                'size_bytes', pg_database_size(datname)
            ) ORDER BY datname
        ),
        '[]'::json
    )
)
FROM (
    SELECT datname
    FROM pg_database
    WHERE datallowconn
      AND NOT datistemplate
    ORDER BY datname
    LIMIT 500
) AS visible_databases;
""".strip()
_database_inventory_cache: tuple[float, dict[str, Any]] | None = None


def _safe_env() -> dict[str, str]:
    return {
        "PATH": os.environ.get(
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin",
        ),
        "LANG": "C",
        "LC_ALL": "C",
    }


def _safe_text(value: str) -> str:
    cleaned = _SAFE_TEXT.sub(" ", value).strip()
    return cleaned[:_VERSION_LINE_LIMIT]


def _run_version(binary_names: Iterable[str]) -> str | None:
    """Run only fixed local `--version` probes; never invoke a shell."""
    for binary_name in binary_names:
        binary = shutil.which(binary_name)
        if not binary:
            continue

        version = _run_version_argv([binary])
        if version:
            return version
    return None


def _run_version_argv(argv_prefix: list[str]) -> str | None:
    """Run a bounded executable prefix with only the fixed `--version` argument."""
    if not argv_prefix or len(argv_prefix) > 2:
        return None

    try:
        result = subprocess.run(
            [*argv_prefix, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
            stdin=subprocess.DEVNULL,
            env=_safe_env(),
        )
    except (OSError, subprocess.SubprocessError):
        return None

    output = result.stdout.strip() or result.stderr.strip()
    if output:
        return _safe_text(output.splitlines()[0])
    return None


def _odoo_version_candidate(cmdline: list[str], cwd: str | None) -> list[str] | None:
    """Build a safe Odoo version probe from a running Python + odoo-bin process."""
    if len(cmdline) < 2:
        return None

    interpreter = Path(cmdline[0])
    script = Path(cmdline[1])
    if not interpreter.is_absolute() or not interpreter.name.startswith("python"):
        return None
    if script.name != "odoo-bin":
        return None

    if not script.is_absolute():
        if not cwd:
            return None
        script = Path(cwd) / script

    resolved_script = script.resolve(strict=False)
    if not resolved_script.is_absolute():
        return None

    return [str(interpreter), str(resolved_script)]


def _runtime_process_inventory() -> tuple[dict[str, int], list[list[str]]]:
    counts = {"odoo": 0, "postgresql": 0}
    odoo_version_candidates: list[list[str]] = []
    odoo_markers = ("odoo", "odoo-bin")
    postgres_markers = ("postgres", "postgresql")

    for process in psutil.process_iter(["name", "cmdline", "cwd"]):
        try:
            name = str(process.info.get("name") or "").lower()
            raw_cmdline = process.info.get("cmdline") or []
            cmdline = [str(part) for part in raw_cmdline]
            cmdline_text = " ".join(cmdline).lower()
            cwd_value = process.info.get("cwd")
            cwd = str(cwd_value) if cwd_value else None
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue

        is_odoo = any(marker in name or marker in cmdline_text for marker in odoo_markers)
        if is_odoo:
            counts["odoo"] += 1
            candidate = _odoo_version_candidate(cmdline, cwd)
            if candidate and candidate not in odoo_version_candidates and len(odoo_version_candidates) < 3:
                odoo_version_candidates.append(candidate)

        if any(marker in name or marker in cmdline_text for marker in postgres_markers):
            counts["postgresql"] += 1

    return counts, odoo_version_candidates


def _database_inventory_uncached() -> dict[str, Any]:
    psql = shutil.which("psql")
    if not psql:
        return {"collected": False, "reason": "psql_not_found"}

    command = [
        psql,
        "-X",
        "-A",
        "-t",
        "-q",
        "--no-password",
        "--dbname=postgres",
        "--command",
        _DATABASE_SQL,
    ]
    env = _safe_env()
    env["PGCONNECT_TIMEOUT"] = "3"

    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
            stdin=subprocess.DEVNULL,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return {"collected": False, "reason": "postgresql_inventory_timeout"}
    except (OSError, subprocess.SubprocessError):
        return {"collected": False, "reason": "postgresql_inventory_unavailable"}

    if result.returncode != 0:
        return {"collected": False, "reason": "postgresql_access_unavailable"}

    output = result.stdout.strip()
    if not output:
        return {"collected": False, "reason": "postgresql_inventory_empty"}
    if len(output.encode("utf-8")) > _DATABASE_OUTPUT_LIMIT:
        return {"collected": False, "reason": "postgresql_inventory_too_large"}

    try:
        payload = json.loads(output)
    except json.JSONDecodeError:
        return {"collected": False, "reason": "postgresql_inventory_invalid"}

    if not isinstance(payload, dict):
        return {"collected": False, "reason": "postgresql_inventory_invalid"}

    server_version = payload.get("server_version")
    databases = payload.get("databases")
    if not isinstance(server_version, str) or not isinstance(databases, list):
        return {"collected": False, "reason": "postgresql_inventory_invalid"}

    safe_databases: list[dict[str, Any]] = []
    for database in databases[:500]:
        if not isinstance(database, dict):
            continue
        name = database.get("name")
        size_bytes = database.get("size_bytes")
        if not isinstance(name, str) or not name or len(name) > 128:
            continue
        if not isinstance(size_bytes, int) or size_bytes < 0:
            continue
        safe_databases.append({"name": name, "size_bytes": size_bytes})

    return {
        "collected": True,
        "source": "local_psql_read_only",
        "server_version": _safe_text(server_version),
        "database_count": len(safe_databases),
        "databases": safe_databases,
    }


def collect_database_inventory(*, force: bool = False) -> dict[str, Any]:
    """Collect a cached, bounded database list without credentials or connection strings."""
    global _database_inventory_cache

    now = time.monotonic()
    if not force and _database_inventory_cache is not None:
        cached_at, cached_payload = _database_inventory_cache
        if now - cached_at < _DATABASE_CACHE_TTL_SECONDS:
            return cached_payload

    payload = _database_inventory_uncached()
    _database_inventory_cache = (now, payload)
    return payload


def collect_runtime_inventory() -> dict[str, Any]:
    """Collect bounded, non-secret local runtime inventory for Phase 2."""
    counts, odoo_version_candidates = _runtime_process_inventory()
    database_inventory = collect_database_inventory()

    odoo_version = _run_version(("odoo", "odoo-bin"))
    if odoo_version is None:
        for candidate in odoo_version_candidates:
            odoo_version = _run_version_argv(candidate)
            if odoo_version:
                break

    return {
        "collection_mode": "read_only_local",
        "odoo": {
            "running": counts["odoo"] > 0,
            "process_count": counts["odoo"],
            "version": odoo_version,
        },
        "postgresql": {
            "running": counts["postgresql"] > 0,
            "process_count": counts["postgresql"],
            "client_version": _run_version(("psql",)),
            "server_binary_version": _run_version(("postgres",)),
            "server_version": database_inventory.get("server_version"),
        },
        "database_inventory": database_inventory,
    }
