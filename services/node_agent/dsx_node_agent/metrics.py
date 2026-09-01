from __future__ import annotations

import os
import platform
import socket
from datetime import UTC, datetime
from typing import Any

import psutil


def _service_process_running(kind: str) -> bool:
    """Best-effort, read-only process discovery without executing shell commands."""
    markers = {
        "odoo": ("odoo", "odoo-bin"),
        "postgresql": ("postgres", "postgresql"),
    }[kind]
    for process in psutil.process_iter(["name", "cmdline"]):
        try:
            name = str(process.info.get("name") or "").lower()
            cmdline = " ".join(process.info.get("cmdline") or []).lower()
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
        if any(marker in name or marker in cmdline for marker in markers):
            return True
    return False


def collect_node_metrics() -> dict[str, Any]:
    """Collect non-secret host metrics for a node heartbeat payload."""
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage("/")

    return {
        "observed_at": datetime.now(UTC).isoformat(),
        "hostname": socket.gethostname(),
        "os": platform.system(),
        "os_release": platform.release(),
        "architecture": platform.machine(),
        "cpu_count": os.cpu_count() or 1,
        "cpu_percent": psutil.cpu_percent(interval=None),
        "memory_total_bytes": memory.total,
        "memory_available_bytes": memory.available,
        "memory_percent": memory.percent,
        "disk_total_bytes": disk.total,
        "disk_free_bytes": disk.free,
        "disk_percent": disk.percent,
        "boot_time": datetime.fromtimestamp(psutil.boot_time(), tz=UTC).isoformat(),
        "services": {
            "odoo": {"running": _service_process_running("odoo")},
            "postgresql": {"running": _service_process_running("postgresql")},
        },
    }
