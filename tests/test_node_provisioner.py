# ruff: noqa: I001

from pathlib import Path

import pytest

from dsx_node_agent.provisioner import (
    ProvisionerConfig,
    ProvisionerError,
    ProvisionerProfile,
    ProvisioningEngine,
    parse_config,
    parse_request,
)


def valid_request_payload(*, environment_kind: str = "test") -> dict:
    return {
        "operation_id": "12345678-abcd-4abc-8abc-1234567890ab",
        "type": "provision_odoo_environment",
        "payload": {
            "tenant_id": "12345678-abcd-4abc-8abc-1234567890ab",
            "tenant_slug": "demo-restaurant",
            "sector": "restaurant",
            "environment_kind": environment_kind,
            "template_id": "template-restaurant-v1",
            "template_version": 1,
            "odoo_major": 18,
            "database_name": "dsx_restaurant_demo_restaurant_12345678",
            "modules": ["point_of_sale", "ds_pos_delivery"],
        },
    }


def make_profile(tmp_path: Path) -> ProvisionerProfile:
    return ProvisionerProfile(
        template_id="template-restaurant-v1",
        source_database="dsx_restaurant_demo_master",
        database_prefix="dsx_restaurant",
        database_owner="odoo",
        filestore_root=tmp_path / "filestore",
        filestore_user="odoo",
        filestore_group="odoo",
        allowed_modules=frozenset({"point_of_sale", "ds_pos_delivery"}),
        allow_empty_filestore=False,
    )


def make_config(tmp_path: Path, *, enabled: bool = True) -> ProvisionerConfig:
    profile = make_profile(tmp_path)
    return ProvisionerConfig(
        enabled=enabled,
        phase="test-only",
        postgres_os_user="postgres",
        work_root=tmp_path / "work",
        profiles={profile.template_id: profile},
    )


def test_local_provisioner_blocks_non_test_environments() -> None:
    for environment_kind in ("trial", "production"):
        payload = valid_request_payload(environment_kind=environment_kind)
        with pytest.raises(ProvisionerError, match="non_test_environment_blocked"):
            parse_request(payload)


def test_local_provisioner_rejects_free_form_fields() -> None:
    payload = valid_request_payload()
    payload["command"] = "rm -rf /"
    with pytest.raises(ProvisionerError, match="invalid_request_fields"):
        parse_request(payload)

    payload = valid_request_payload()
    payload["payload"]["path"] = "/etc/shadow"
    with pytest.raises(ProvisionerError, match="invalid_payload_fields"):
        parse_request(payload)


def test_config_is_test_only_and_paths_are_absolute() -> None:
    raw = {
        "enabled": False,
        "phase": "test-only",
        "postgres_os_user": "postgres",
        "work_root": "/var/lib/dsx-provisioner/work",
        "profiles": {},
    }
    config = parse_config(raw)
    assert config.enabled is False
    assert config.phase == "test-only"

    raw["work_root"] = "relative/path"
    with pytest.raises(ProvisionerError, match="invalid_work_root"):
        parse_config(raw)


def test_disabled_provisioner_fails_before_postgres_access(tmp_path: Path, monkeypatch) -> None:
    request = parse_request(valid_request_payload())
    engine = ProvisioningEngine(make_config(tmp_path, enabled=False))

    def unexpected_database_access(_database_name: str) -> bool:
        raise AssertionError("disabled provisioner must not touch PostgreSQL")

    monkeypatch.setattr(engine, "_database_exists", unexpected_database_access)
    with pytest.raises(ProvisionerError, match="provisioner_disabled"):
        engine.provision(request)


def test_existing_managed_database_is_idempotent(tmp_path: Path, monkeypatch) -> None:
    request = parse_request(valid_request_payload())
    engine = ProvisioningEngine(make_config(tmp_path))
    clone_calls: list[str] = []

    monkeypatch.setattr(engine, "_database_exists", lambda _name: True)
    monkeypatch.setattr(engine, "_source_is_odoo", lambda _name: True)
    monkeypatch.setattr(
        engine,
        "_read_marker",
        lambda _name: (request.tenant_id, request.template_id),
    )
    monkeypatch.setattr(engine, "_prepare_filestore", lambda _request, _profile: False)
    monkeypatch.setattr(engine, "_validate_modules", lambda _request: None)
    monkeypatch.setattr(engine, "_clone_database", lambda *_args: clone_calls.append("clone"))

    result = engine.provision(request)

    assert result == {"state": "ready", "database_name": request.database_name}
    assert clone_calls == []


def test_existing_database_with_wrong_marker_is_rejected(tmp_path: Path, monkeypatch) -> None:
    request = parse_request(valid_request_payload())
    engine = ProvisioningEngine(make_config(tmp_path))

    monkeypatch.setattr(engine, "_database_exists", lambda _name: True)
    monkeypatch.setattr(engine, "_source_is_odoo", lambda _name: True)
    monkeypatch.setattr(engine, "_read_marker", lambda _name: ("other-tenant", request.template_id))

    with pytest.raises(ProvisionerError, match="database_name_conflict"):
        engine.provision(request)


def test_failure_after_creation_rolls_back_database_and_filestore(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = parse_request(valid_request_payload())
    config = make_config(tmp_path)
    profile = config.profiles[request.template_id]
    engine = ProvisioningEngine(config)
    dropped: list[str] = []
    target_filestore = profile.filestore_root / request.database_name

    def database_exists(name: str) -> bool:
        return name == profile.source_database

    def prepare_filestore(_request, _profile) -> bool:
        target_filestore.mkdir(parents=True)
        (target_filestore / "partial.bin").write_bytes(b"partial")
        return True

    def fail_module_validation(_request) -> None:
        raise ProvisionerError("required_module_not_installed")

    monkeypatch.setattr(engine, "_database_exists", database_exists)
    monkeypatch.setattr(engine, "_source_is_odoo", lambda _name: True)
    monkeypatch.setattr(engine, "_clone_database", lambda _request, _profile: None)
    monkeypatch.setattr(engine, "_prepare_filestore", prepare_filestore)
    monkeypatch.setattr(engine, "_write_marker", lambda _request: None)
    monkeypatch.setattr(engine, "_validate_modules", fail_module_validation)
    monkeypatch.setattr(engine, "_drop_database", lambda name: dropped.append(name))

    with pytest.raises(ProvisionerError, match="required_module_not_installed"):
        engine.provision(request)

    assert dropped == [request.database_name]
    assert not target_filestore.exists()


def test_disallowed_module_is_rejected_before_postgres_access(tmp_path: Path, monkeypatch) -> None:
    payload = valid_request_payload()
    payload["payload"]["modules"] = ["point_of_sale", "unapproved_module"]
    request = parse_request(payload)
    engine = ProvisioningEngine(make_config(tmp_path))

    def unexpected_database_access(_database_name: str) -> bool:
        raise AssertionError("module allow-list failure must happen before PostgreSQL access")

    monkeypatch.setattr(engine, "_database_exists", unexpected_database_access)
    with pytest.raises(ProvisionerError, match="module_not_allowed_by_local_profile"):
        engine.provision(request)
