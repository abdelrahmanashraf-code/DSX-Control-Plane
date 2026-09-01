from __future__ import annotations

import os
import platform
import socket
from datetime import datetime, timezone
from typing import Any

import psutil


def collect_node_metrics() -> dict[str, Any]:
    """Collect non-secret host metrics for a node heartbeat payload."""
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage("/")

    return {
        "observed_at": datetime.now(timezone.utc).isoformat(),
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
        "boot_time": datetime.fromtimestamp(psutil.boot_time(), tz=timezone.utc).isoformat(),
    }
