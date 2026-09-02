from __future__ import annotations

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
