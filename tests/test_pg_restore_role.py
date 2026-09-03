from pathlib import Path
from typing import Any

from dsx_node_agent.provisioner import (
    CommandResult,
    ProvisionerConfig,
    ProvisionerProfile,
    ProvisionRequest,
    ProvisioningEngine,
)
from dsx_node_agent.restore_service import RestoreEngine, RestoreRequest


class FakeProvisioning:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def _run_postgres(self, argv: list[str], **kwargs: Any) -> CommandResult:
        self.calls.append(argv)
        return CommandResult(returncode=0, stdout="")


def test_restore_uses_target_database_owner_role(tmp_path: Path) -> None:
    fake = FakeProvisioning()
    engine = RestoreEngine(config=None, provisioning=fake)  # type: ignore[arg-type]
    dump_path = tmp_path / "database.dump"
    dump_path.write_bytes(b"fake-dump")
    request = RestoreRequest(
        operation_id="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        backup_job_id="c57703c6-48a1-4f5f-85f0-f98328cb7688",
        source_tenant_id="5b6099ab-282e-4c7b-a5eb-9b607e2e2362",
        target_tenant_id="87d57fe3-3a6e-48f2-a1a3-b8c8b5fbf5bc",
        environment_kind="test",
        template_id="template-restaurant-v1",
        source_provisioning_operation_id="d93f3452-a58d-463b-9295-5852c973dcc9",
        source_database_name="dsx_restaurant_phase4_backup_gate_20260903_5b6099ab",
        target_database_name="dsx_restaurant_restore_role_gate_87d57fe3",
        manifest_sha256="a" * 64,
        total_size_bytes=0,
        artifacts=(),
    )

    engine._create_and_restore_database(request, dump_path, "odoo")

    restore_call = next(call for call in fake.calls if call[0] == "/usr/bin/pg_restore")
    assert "--role=odoo" in restore_call
    assert f"--dbname={request.target_database_name}" in restore_call


def test_provisioning_clone_uses_profile_database_owner_role(tmp_path: Path) -> None:
    config = ProvisionerConfig(
        enabled=True,
        phase="test-only",
        postgres_os_user="postgres",
        work_root=tmp_path,
        profiles={},
    )
    engine = ProvisioningEngine(config)
    calls: list[list[str]] = []

    def fake_run(argv: list[str], **kwargs: Any) -> CommandResult:
        calls.append(argv)
        output = kwargs.get("stdout_handle")
        if argv[0] == "/usr/bin/pg_dump" and output is not None:
            output.write(b"fake-dump")
        return CommandResult(returncode=0, stdout="")

    engine._run_postgres = fake_run  # type: ignore[method-assign]
    profile = ProvisionerProfile(
        template_id="template-restaurant-v1",
        source_database="dsx_restaurant_demo_master",
        database_prefix="dsx_restaurant",
        database_owner="odoo",
        filestore_root=tmp_path / "filestore",
        filestore_user="odoo",
        filestore_group="odoo",
        allowed_modules=frozenset(),
        allow_empty_filestore=False,
    )
    request = ProvisionRequest(
        operation_id="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        tenant_id="87d57fe3-3a6e-48f2-a1a3-b8c8b5fbf5bc",
        tenant_slug="restore-role-gate",
        sector="restaurant",
        environment_kind="test",
        template_id=profile.template_id,
        template_version=1,
        odoo_major=18,
        database_name="dsx_restaurant_restore_role_gate_87d57fe3",
        modules=(),
    )

    engine._clone_database(request, profile)

    restore_call = next(call for call in calls if call[0] == "/usr/bin/pg_restore")
    assert "--role=odoo" in restore_call
    assert f"--dbname={request.database_name}" in restore_call
