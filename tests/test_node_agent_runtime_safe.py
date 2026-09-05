# ruff: noqa: I001

from pathlib import Path
from types import SimpleNamespace

import pytest

from dsx_node_agent import runtime_service
from dsx_node_agent.provisioner import (
    ProvisionRequest,
    ProvisionerConfig,
    ProvisionerError,
    ProvisionerProfile,
    ProvisioningEngine,
)
from dsx_node_agent.runtime_service_safe import SafeRuntimeProvisioningEngine


def make_request() -> ProvisionRequest:
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


def make_engine(tmp_path: Path) -> SafeRuntimeProvisioningEngine:
    profile = ProvisionerProfile(
        template_id="template-restaurant-v1",
        source_database="dsx_restaurant_demo_master",
        database_prefix="dsx_restaurant",
        database_owner="odoo",
        filestore_root=tmp_path / "filestore",
        filestore_user="odoo",
        filestore_group="odoo",
        allowed_modules=frozenset({"pos_restaurant"}),
        allow_empty_filestore=False,
    )
    config = ProvisionerConfig(
        enabled=True,
        phase="trial-enabled",
        postgres_os_user="postgres",
        work_root=tmp_path / "work",
        profiles={profile.template_id: profile},
    )
    return SafeRuntimeProvisioningEngine(config)


def test_trial_runtime_failure_rolls_back_database_and_filestore(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = make_request()
    engine = make_engine(tmp_path)
    profile = engine.config.profiles[request.template_id]
    filestore = profile.filestore_root / request.database_name
    filestore.mkdir(parents=True)
    dropped: list[str] = []

    monkeypatch.setattr(
        engine,
        "_read_marker",
        lambda name: (request.tenant_id, request.template_id),
    )
    monkeypatch.setattr(engine, "_drop_database", lambda name: dropped.append(name))
    checks = iter([True, False])
    monkeypatch.setattr(engine, "_database_exists", lambda name: next(checks))

    engine._rollback_trial_data(request)

    assert dropped == [request.database_name]
    assert not filestore.exists()


def test_trial_runtime_failure_preserves_unverified_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = make_request()
    engine = make_engine(tmp_path)
    profile = engine.config.profiles[request.template_id]
    filestore = profile.filestore_root / request.database_name
    filestore.mkdir(parents=True)

    monkeypatch.setattr(engine, "_database_exists", lambda name: True)
    monkeypatch.setattr(engine, "_read_marker", lambda name: ("other-tenant", request.template_id))

    with pytest.raises(ProvisionerError, match="runtime_rollback_marker_mismatch"):
        engine._rollback_trial_data(request)

    assert filestore.exists()


def test_provision_invokes_rollback_when_runtime_start_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = make_request()
    engine = make_engine(tmp_path)
    rolled_back: list[str] = []

    monkeypatch.setattr(
        ProvisioningEngine,
        "provision",
        lambda self, req: {"state": "ready", "database_name": req.database_name},
    )
    monkeypatch.setattr(
        runtime_service,
        "_RUNTIME",
        SimpleNamespace(
            config=SimpleNamespace(enabled=True),
            ensure=lambda req, profile: (_ for _ in ()).throw(ProvisionerError("runtime_failed")),
        ),
    )
    monkeypatch.setattr(
        engine,
        "_rollback_trial_data",
        lambda req: rolled_back.append(req.database_name),
    )

    with pytest.raises(ProvisionerError, match="runtime_failed"):
        engine.provision(request)

    assert rolled_back == [request.database_name]
