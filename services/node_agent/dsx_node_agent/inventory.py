from __future__ import annotations

import os
import re
import shutil
import subprocess
from collections.abc import Iterable
from typing import Any

import psutil

_VERSION_LINE_LIMIT = 160
_SAFE_TEXT = re.compile(r"[^\x20-\x7E]")


def _safe_text(value: str) -> str:
    cleaned = _SAFE_TEXT.sub(" ", value).strip()
    return cleaned[:_VERSION_LINE_LIMIT]


def _run_version(binary_names: Iterable[str]) -> str | None:
    """Run only fixed local `--version` probes; never invoke a shell."""
    for binary_name in binary_names:
        binary = shutil.which(binary_name)
        if not binary:
            continue

        try:
            result = subprocess.run(
                [binary, "--version"],
                check=False,
                capture_output=True,
                text=True,
                timeout=3,
                stdin=subprocess.DEVNULL,
                env={
                    "PATH": os.environ.get("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"),
                    "LANG": "C",
                    "LC_ALL": "C",
                },
            )
        except (OSError, subprocess.SubprocessError):
            continue

        output = result.stdout.strip() or result.stderr.strip()
        if output:
            return _safe_text(output.splitlines()[0])
    return None


def _runtime_process_counts() -> dict[str, int]:
    counts = {"odoo": 0, "postgresql": 0}
    odoo_markers = ("odoo", "odoo-bin")
    postgres_markers = ("postgres", "postgresql")

    for process in psutil.process_iter(["name", "cmdline"]):
        try:
            name = str(process.info.get("name") or "").lower()
            cmdline = " ".join(process.info.get("cmdline") or []).lower()
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue

        if any(marker in name or marker in cmdline for marker in odoo_markers):
            counts["odoo"] += 1
        if any(marker in name or marker in cmdline for marker in postgres_markers):
            counts["postgresql"] += 1

    return counts


def collect_runtime_inventory() -> dict[str, Any]:
    """Collect bounded, non-secret local runtime inventory for Phase 2."""
    counts = _runtime_process_counts()

    return {
        "collection_mode": "read_only_local",
        "odoo": {
            "running": counts["odoo"] > 0,
            "process_count": counts["odoo"],
            "version": _run_version(("odoo", "odoo-bin")),
        },
        "postgresql": {
            "running": counts["postgresql"] > 0,
            "process_count": counts["postgresql"],
            "client_version": _run_version(("psql",)),
            "server_binary_version": _run_version(("postgres",)),
        },
        "database_inventory": {
            "collected": False,
            "reason": "typed_read_only_postgresql_inventory_not_enabled_yet",
        },
    }
