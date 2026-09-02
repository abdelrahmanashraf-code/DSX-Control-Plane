from __future__ import annotations

import json
import subprocess
from types import SimpleNamespace

from dsx_node_agent import inventory


class FakeProcess:
    def __init__(self, name: str, cmdline: list[str]) -> None:
        self.info = {"name": name, "cmdline": cmdline}


def test_runtime_inventory_is_bounded_and_does_not_return_cmdlines(monkeypatch) -> None:
    processes = [
        FakeProcess("python3", ["python3", "/opt/odoo/odoo-bin", "-c", "/secret/odoo.conf"]),
        FakeProcess("postgres", ["postgres", "-D", "/var/lib/postgresql/18/main"]),
    ]
    monkeypatch.setattr(inventory.psutil, "process_iter", lambda _attrs: processes)
    monkeypatch.setattr(
        inventory,
        "_run_version",
        lambda names: "Odoo 18.0" if "odoo" in tuple(names) else "PostgreSQL 18.1",
    )
    monkeypatch.setattr(
        inventory,
        "collect_database_inventory",
        lambda: {"collected": False, "reason": "postgresql_access_unavailable"},
    )

    payload = inventory.collect_runtime_inventory()

    assert payload["collection_mode"] == "read_only_local"
    assert payload["odoo"]["running"] is True
    assert payload["odoo"]["process_count"] == 1
    assert payload["postgresql"]["running"] is True
    assert payload["postgresql"]["process_count"] == 1
    assert payload["database_inventory"]["collected"] is False

    serialized = repr(payload).lower()
    assert "odoo.conf" not in serialized
    assert "/var/lib/postgresql" not in serialized
    assert "cmdline" not in serialized


def test_version_probe_uses_fixed_argv_without_shell(monkeypatch) -> None:
    captured: dict[str, object] = {}

    monkeypatch.setattr(inventory.shutil, "which", lambda name: f"/usr/bin/{name}")

    def fake_run(argv, **kwargs):
        captured["argv"] = argv
        captured["kwargs"] = kwargs
        return SimpleNamespace(stdout="psql (PostgreSQL) 18.1\n", stderr="")

    monkeypatch.setattr(inventory.subprocess, "run", fake_run)

    version = inventory._run_version(("psql",))

    assert version == "psql (PostgreSQL) 18.1"
    assert captured["argv"] == ["/usr/bin/psql", "--version"]
    kwargs = captured["kwargs"]
    assert isinstance(kwargs, dict)
    assert kwargs.get("stdin") is subprocess.DEVNULL
    assert "shell" not in kwargs


def test_database_inventory_uses_no_password_fixed_query_and_sanitized_env(monkeypatch) -> None:
    captured: dict[str, object] = {}
    db_payload = {
        "server_version": "18.1",
        "databases": [
            {"name": "postgres", "size_bytes": 8_388_607},
            {"name": "tenant_demo", "size_bytes": 52_428_800},
        ],
    }

    monkeypatch.setattr(inventory.shutil, "which", lambda name: "/usr/bin/psql" if name == "psql" else None)

    def fake_run(argv, **kwargs):
        captured["argv"] = argv
        captured["kwargs"] = kwargs
        return SimpleNamespace(returncode=0, stdout=json.dumps(db_payload), stderr="secret error")

    monkeypatch.setattr(inventory.subprocess, "run", fake_run)

    payload = inventory.collect_database_inventory(force=True)

    assert payload == {
        "collected": True,
        "source": "local_psql_read_only",
        "server_version": "18.1",
        "database_count": 2,
        "databases": [
            {"name": "postgres", "size_bytes": 8_388_607},
            {"name": "tenant_demo", "size_bytes": 52_428_800},
        ],
    }

    argv = captured["argv"]
    assert isinstance(argv, list)
    assert argv[0] == "/usr/bin/psql"
    assert "--no-password" in argv
    assert "-X" in argv
    assert "--command" in argv

    kwargs = captured["kwargs"]
    assert isinstance(kwargs, dict)
    assert "shell" not in kwargs
    assert kwargs.get("stdin") is subprocess.DEVNULL
    env = kwargs.get("env")
    assert isinstance(env, dict)
    assert "PGPASSWORD" not in env
    assert "DATABASE_URL" not in env
    assert env["PGCONNECT_TIMEOUT"] == "3"
    assert "secret error" not in repr(payload)


def test_database_inventory_failure_never_returns_psql_error(monkeypatch) -> None:
    monkeypatch.setattr(inventory.shutil, "which", lambda name: "/usr/bin/psql" if name == "psql" else None)
    monkeypatch.setattr(
        inventory.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=2,
            stdout="",
            stderr="password authentication failed for user secret_user",
        ),
    )

    payload = inventory.collect_database_inventory(force=True)

    assert payload == {"collected": False, "reason": "postgresql_access_unavailable"}
    assert "secret_user" not in repr(payload)
