from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from dsx_node_agent.provisioner import ProvisionRequest, ProvisionerError, ProvisionerProfile
from dsx_node_agent import runtime_service
from dsx_node_agent.runtime_service import RuntimeLifecycle, parse_runtime_config


def raw_config() -> dict:
    return {
        "enabled": True,
        "trial_base_domain": "trial.dsxpos.com",
        "http_port_start": 3100,
        "http_port_end": 3110,
        "runtime_user": "root",
        "runtime_group": "root",
        "health_timeout_seconds": 20,
        "tls_certificate": None,
        "tls_certificate_key": None,
    }


def request() -> ProvisionRequest:
    return ProvisionRequest(
        operation_id="12345678-abcd-4abc-8abc-1234567890ab",
        tenant_id="12345678-abcd-4abc-8abc-1234567890ab",
        tenant_slug="burger-house",
        sector="restaurant",
        environment_kind="trial",
        template_id="template-restaurant-v1",
        template_version=1,
        odoo_major=18,
        database_name="dsx_restaurant_burger_house_12345678",
        modules=("pos_restaurant",),
    )


def patch_roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path, Path]:
    runtime_root = tmp_path / "runtime"
    systemd = tmp_path / "systemd"
    nginx = tmp_path / "nginx"
    runtime_root.mkdir()
    systemd.mkdir()
    nginx.mkdir()
    monkeypatch.setattr(runtime_service, "_RUNTIME_ROOT", runtime_root)
    monkeypatch.setattr(runtime_service, "_SYSTEMD_DIR", systemd)
    monkeypatch.setattr(runtime_service, "_NGINX_DIR", nginx)
    return runtime_root, systemd, nginx


def make_profile(runtime_root: Path) -> ProvisionerProfile:
    source = runtime_root / "dsx_restaurant_demo_master"
    (source / "src").mkdir(parents=True)
    (source / "src" / "odoo-bin").write_text("#!/usr/bin/env python3\n")
    (source / "venv" / "bin").mkdir(parents=True)
    (source / "venv" / "bin" / "python3").write_text("")
    (source / "extra-addons").mkdir()
    (source / "logs").mkdir()
    (source / "odoo.conf").write_text(
        "[options]\n"
        f"addons_path = {source}/src/addons, {source}/extra-addons\n"
        "proxy_mode = True\n"
        "db_name = dsx_restaurant_demo_master\n"
    )
    return ProvisionerProfile(
        template_id="template-restaurant-v1",
        source_database="dsx_restaurant_demo_master",
        database_prefix="dsx_restaurant",
        database_owner="odoo",
        filestore_root=runtime_root / "filestore",
        filestore_user="root",
        filestore_group="root",
        allowed_modules=frozenset({"pos_restaurant"}),
        allow_empty_filestore=False,
    )


def test_runtime_config_validates_ports_and_tls_pair() -> None:
    parsed = parse_runtime_config(raw_config())
    assert parsed.http_port_start == 3100
    assert parsed.trial_base_domain == "trial.dsxpos.com"

    raw = raw_config()
    raw["http_port_start"] = 3101
    with pytest.raises(ProvisionerError, match="invalid_runtime_port_range"):
        parse_runtime_config(raw)

    raw = raw_config()
    raw["tls_certificate"] = "/etc/letsencrypt/live/trial.dsxpos.com/fullchain.pem"
    with pytest.raises(ProvisionerError, match="invalid_runtime_tls_pair"):
        parse_runtime_config(raw)


def test_trial_runtime_materializes_isolated_instance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime_root, systemd, nginx = patch_roots(tmp_path, monkeypatch)
    profile = make_profile(runtime_root)
    lifecycle = RuntimeLifecycle(parse_runtime_config(raw_config()))
    monkeypatch.setattr(
        lifecycle,
        "_run",
        lambda argv, timeout=60: SimpleNamespace(returncode=0, stdout=""),
    )
    monkeypatch.setattr(lifecycle, "_health", lambda port: None)
    monkeypatch.setattr(lifecycle, "_reload", lambda: None)
    monkeypatch.setattr(lifecycle, "_port_available", lambda port: True)
    monkeypatch.setattr(
        runtime_service.ProvisioningEngine,
        "_chown_tree",
        lambda path, user, group: None,
    )

    lifecycle.ensure(request(), profile)
    target = runtime_root / request().database_name
    source = runtime_root / profile.source_database
    assert target.is_dir() and source.is_dir() and target != source

    config = (target / "odoo.conf").read_text()
    assert str(target) in config
    assert str(source) not in config
    assert "db_name = dsx_restaurant_burger_house_12345678" in config
    assert "list_db = False" in config

    marker = json.loads((target / "dsx-runtime.json").read_text())
    assert (marker["http_port"], marker["gevent_port"]) == (3100, 3101)
    legacy = json.loads((target / "meta.json").read_text())
    assert (legacy["web_port"], legacy["gevent_port"]) == ("3100", "3101")

    service = (systemd / f"odona-{request().database_name}.service").read_text()
    assert "--http-port 3100" in service and "--gevent-port 3101" in service
    route = (nginx / f"dsx-trial-{request().database_name}.conf").read_text()
    assert "server_name burger-house.trial.dsxpos.com;" in route


def test_allocator_skips_existing_runtime_ports(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime_root, _, _ = patch_roots(tmp_path, monkeypatch)
    occupied = runtime_root / "existing"
    occupied.mkdir()
    (occupied / "dsx-runtime.json").write_text(
        json.dumps({"http_port": 3100, "gevent_port": 3101})
    )
    lifecycle = RuntimeLifecycle(parse_runtime_config(raw_config()))
    monkeypatch.setattr(lifecycle, "_port_available", lambda port: True)
    assert lifecycle.allocate_ports() == (3102, 3103)


def test_cleanup_requires_identity_and_preserves_golden(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime_root, _, _ = patch_roots(tmp_path, monkeypatch)
    profile = make_profile(runtime_root)
    lifecycle = RuntimeLifecycle(parse_runtime_config(raw_config()))
    target = runtime_root / request().database_name
    target.mkdir()
    (target / "dsx-runtime.json").write_text(
        json.dumps(
            {
                "tenant_id": request().tenant_id,
                "template_id": request().template_id,
                "database_name": request().database_name,
                "operation_id": request().operation_id,
            }
        )
    )
    monkeypatch.setattr(
        lifecycle,
        "_run",
        lambda argv, timeout=60: SimpleNamespace(returncode=0, stdout=""),
    )
    monkeypatch.setattr(lifecycle, "_reload", lambda: None)

    with pytest.raises(ProvisionerError, match="runtime_cleanup_marker_mismatch"):
        lifecycle.remove(
            request().database_name,
            profile.source_database,
            ("wrong", request().template_id, request().database_name, request().operation_id),
        )
    assert target.exists()

    lifecycle.remove(
        request().database_name,
        profile.source_database,
        (
            request().tenant_id,
            request().template_id,
            request().database_name,
            request().operation_id,
        ),
    )
    assert not target.exists()
    assert (runtime_root / profile.source_database).exists()

    with pytest.raises(ProvisionerError, match="runtime_cleanup_source_blocked"):
        lifecycle.remove(profile.source_database, profile.source_database, None)
