import grp
import json
import os
import pwd
from pathlib import Path

import pytest
from dsx_node_agent.backup_operation import BackupClaimedOperation
from dsx_node_agent.backup_service import BackupEngine, parse_backup_request
from dsx_node_agent.operation_dispatch import execute_any_operation, parse_any_claimed_operation
from dsx_node_agent.operations import OperationProtocolError
from dsx_node_agent.provisioner import (
    CommandResult,
    ProvisionerConfig,
    ProvisionerError,
    ProvisionerProfile,
)


def valid_backup_claim() -> dict:
    return {
        "operation": {
            "id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "type": "backup_odoo_environment",
            "lease_token": "dsx_backup_lease_12345678901234567890",
            "lease_expires_at": "2026-09-03T12:00:00.000Z",
            "payload": {
                "tenant_id": "12345678-abcd-4abc-8abc-1234567890ab",
                "environment_kind": "test",
                "template_id": "template-restaurant-v1",
                "provisioning_operation_id": "94510378-b752-4dab-a4c7-625af6a9b252",
                "database_name": "dsx_restaurant_phase4_12345678",
                "backup_type": "full",
            },
        }
    }


def valid_privileged_backup_request() -> dict:
    operation = valid_backup_claim()["operation"]
    return {
        "operation_id": operation["id"],
        "type": operation["type"],
        "payload": operation["payload"],
    }


def backup_config(tmp_path: Path) -> ProvisionerConfig:
    user = pwd.getpwuid(os.getuid()).pw_name
    group = grp.getgrgid(os.getgid()).gr_name
    return ProvisionerConfig(
        enabled=True,
        phase="test-only",
        postgres_os_user="postgres",
        work_root=tmp_path / "work",
        profiles={
            "template-restaurant-v1": ProvisionerProfile(
                template_id="template-restaurant-v1",
                source_database="dsx_restaurant_demo_master",
                database_prefix="dsx_restaurant",
                database_owner=user,
                filestore_root=tmp_path / "filestore",
                filestore_user=user,
                filestore_group=group,
                allowed_modules=frozenset(),
                allow_empty_filestore=False,
            )
        },
    )


class FakeBackupProvisioning:
    def __init__(self, *, marker_matches: bool = True) -> None:
        self.marker_matches = marker_matches
        self.dump_calls = 0

    def _database_exists(self, database_name: str) -> bool:
        return True

    def _run_postgres(self, argv: list[str], **kwargs) -> CommandResult:
        if argv[0] == "/usr/bin/pg_dump":
            self.dump_calls += 1
            kwargs["stdout_handle"].write(b"FAKE-POSTGRES-DUMP")
            return CommandResult(returncode=0, stdout="")
        if "--dbname=postgres" in argv:
            return CommandResult(returncode=0, stdout=f"{pwd.getpwuid(os.getuid()).pw_name}\n")
        tenant = "12345678-abcd-4abc-8abc-1234567890ab" if self.marker_matches else "wrong-tenant"
        return CommandResult(
            returncode=0,
            stdout=(
                f"{tenant}\ttemplate-restaurant-v1\t"
                "94510378-b752-4dab-a4c7-625af6a9b252\n"
            ),
        )


def test_backup_claim_is_strictly_typed() -> None:
    operation = parse_any_claimed_operation(valid_backup_claim())
    assert isinstance(operation, BackupClaimedOperation)
    assert operation.operation_type == "backup_odoo_environment"
    assert operation.payload.backup_type == "full"
    assert operation.payload.environment_kind == "test"


def test_backup_claim_rejects_production_and_arbitrary_path() -> None:
    claim = valid_backup_claim()
    claim["operation"]["payload"]["environment_kind"] = "production"
    with pytest.raises(OperationProtocolError, match="backup_non_test_environment_blocked"):
        parse_any_claimed_operation(claim)

    claim = valid_backup_claim()
    claim["operation"]["payload"]["path"] = "/etc/shadow"
    with pytest.raises(OperationProtocolError, match="invalid_operation_payload_fields"):
        parse_any_claimed_operation(claim)


def test_backup_executor_fails_closed_without_privileged_socket() -> None:
    operation = parse_any_claimed_operation(valid_backup_claim())
    assert isinstance(operation, BackupClaimedOperation)
    result = execute_any_operation(operation, provisioner_socket=None)
    assert result.state == "failed"
    assert result.error_code == "backup_executor_not_ready"


def test_privileged_backup_parser_never_accepts_paths_or_lease_fields() -> None:
    parsed = parse_backup_request(valid_privileged_backup_request())
    assert parsed.backup_type == "full"
    assert parsed.database_name == "dsx_restaurant_phase4_12345678"

    unsafe = valid_privileged_backup_request()
    unsafe["payload"]["path"] = "/var/backups"
    with pytest.raises(ProvisionerError, match="invalid_payload_fields"):
        parse_backup_request(unsafe)

    with pytest.raises(ProvisionerError, match="invalid_request_fields"):
        parse_backup_request(valid_backup_claim()["operation"])


def test_backup_marker_mismatch_blocks_dump_before_filestore_access(tmp_path: Path) -> None:
    provisioning = FakeBackupProvisioning(marker_matches=False)
    engine = BackupEngine(backup_config(tmp_path), provisioning)  # type: ignore[arg-type]
    request = parse_backup_request(valid_privileged_backup_request())

    with pytest.raises(ProvisionerError, match="backup_marker_mismatch"):
        engine.backup(request)

    assert provisioning.dump_calls == 0
    assert not (tmp_path / "work" / "backups" / request.operation_id).exists()


def test_backup_creates_dump_filestore_archive_manifest_and_replays(tmp_path: Path) -> None:
    config = backup_config(tmp_path)
    request = parse_backup_request(valid_privileged_backup_request())
    target = config.profiles[request.template_id].filestore_root / request.database_name
    target.mkdir(parents=True, mode=0o700)
    (target / "ab").mkdir()
    (target / "ab" / "blob").write_bytes(b"ODOO-FILESTORE-DATA")

    provisioning = FakeBackupProvisioning(marker_matches=True)
    engine = BackupEngine(config, provisioning)  # type: ignore[arg-type]
    result = engine.backup(request)

    assert result["state"] == "prepared"
    assert len(result["manifest_sha256"]) == 64
    assert len(result["artifacts"]) == 3
    workspace = config.work_root / "backups" / request.operation_id
    assert (workspace / "database.dump").is_file()
    assert (workspace / "filestore.tar.gz").is_file()
    assert (workspace / "manifest.json").is_file()

    manifest = json.loads((workspace / "manifest.json").read_text())
    assert manifest["tenant_id"] == request.tenant_id
    assert manifest["database_name"] == request.database_name
    assert manifest["provisioning_operation_id"] == request.provisioning_operation_id
    assert {item["artifact_kind"] for item in manifest["artifacts"]} == {
        "database_dump",
        "filestore_archive",
    }

    replay = engine.backup(request)
    assert replay["state"] == "prepared"
    assert replay["manifest_sha256"] == result["manifest_sha256"]
    assert provisioning.dump_calls == 1


def test_backup_rejects_symlink_inside_filestore(tmp_path: Path) -> None:
    config = backup_config(tmp_path)
    request = parse_backup_request(valid_privileged_backup_request())
    target = config.profiles[request.template_id].filestore_root / request.database_name
    target.mkdir(parents=True, mode=0o700)
    (target / "unsafe").symlink_to("/tmp")

    provisioning = FakeBackupProvisioning(marker_matches=True)
    engine = BackupEngine(config, provisioning)  # type: ignore[arg-type]
    with pytest.raises(ProvisionerError, match="backup_filestore_symlink_blocked"):
        engine.backup(request)
    assert provisioning.dump_calls == 0
