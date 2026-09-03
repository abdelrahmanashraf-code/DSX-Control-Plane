# ruff: noqa: I001

import grp
import hashlib
import json
import os
import pwd
import stat
from pathlib import Path

import pytest

from dsx_node_agent.backup_stage_service import BackupArtifactStager, parse_backup_stage_request
from dsx_node_agent.backup_upload import (
    BackupUploadClaimedOperation,
    expected_object_key,
    parse_backup_upload_claimed_operation,
)
from dsx_node_agent.operation_dispatch import parse_any_claimed_operation
from dsx_node_agent.operations import OperationProtocolError
from dsx_node_agent.provisioner import ProvisionerConfig


SHA_A = hashlib.sha256(b"DATABASE").hexdigest()
SHA_B = hashlib.sha256(b"FILESTORE").hexdigest()


def valid_upload_claim() -> dict:
    manifest = {
        "schema_version": 1,
        "backup_id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "tenant_id": "12345678-abcd-4abc-8abc-1234567890ab",
        "environment_kind": "test",
        "template_id": "template-restaurant-v1",
        "provisioning_operation_id": "94510378-b752-4dab-a4c7-625af6a9b252",
        "database_name": "dsx_restaurant_phase4_12345678",
        "backup_type": "full",
        "created_at": "2026-09-03T12:00:00Z",
        "artifacts": [
            {
                "artifact_kind": "database_dump",
                "file_name": "database.dump",
                "size_bytes": 8,
                "sha256": SHA_A,
            },
            {
                "artifact_kind": "filestore_archive",
                "file_name": "filestore.tar.gz",
                "size_bytes": 9,
                "sha256": SHA_B,
            },
        ],
    }
    manifest_bytes = (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()
    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    return {
        "operation": {
            "id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "type": "upload_verify_backup_artifacts",
            "lease_token": "dsx_backup_upload_lease_12345678901234567890",
            "lease_expires_at": "2026-09-03T12:30:00+00:00",
            "payload": {
                "tenant_id": "12345678-abcd-4abc-8abc-1234567890ab",
                "environment_kind": "test",
                "template_id": "template-restaurant-v1",
                "provisioning_operation_id": "94510378-b752-4dab-a4c7-625af6a9b252",
                "database_name": "dsx_restaurant_phase4_12345678",
                "backup_type": "full",
                "manifest_sha256": manifest_sha,
                "total_size_bytes": 8 + 9 + len(manifest_bytes),
                "artifacts": [
                    {"artifact_kind": "database_dump", "size_bytes": 8, "sha256": SHA_A},
                    {"artifact_kind": "filestore_archive", "size_bytes": 9, "sha256": SHA_B},
                    {
                        "artifact_kind": "manifest",
                        "size_bytes": len(manifest_bytes),
                        "sha256": manifest_sha,
                    },
                ],
            },
        },
        "manifest": manifest,
        "manifest_bytes": manifest_bytes,
    }


def local_stage_request() -> dict:
    claim = valid_upload_claim()["operation"]
    return {
        "operation_id": claim["id"],
        "type": "stage_backup_for_upload",
        "payload": claim["payload"],
    }


def test_upload_claim_is_strictly_typed_and_has_no_storage_credentials() -> None:
    claim = valid_upload_claim()
    claim.pop("manifest")
    claim.pop("manifest_bytes")
    parsed = parse_any_claimed_operation(claim)
    assert isinstance(parsed, BackupUploadClaimedOperation)
    assert parsed.payload.environment_kind == "test"
    assert expected_object_key(parsed, "manifest").endswith("/manifest.json")

    unsafe = valid_upload_claim()
    unsafe.pop("manifest")
    unsafe.pop("manifest_bytes")
    unsafe["operation"]["payload"]["bucket"] = "unexpected"
    with pytest.raises(OperationProtocolError, match="invalid_operation_payload_fields"):
        parse_backup_upload_claimed_operation(unsafe)


def test_stage_parser_rejects_paths_and_secrets() -> None:
    parsed = parse_backup_stage_request(local_stage_request())
    assert parsed.operation_type == "stage_backup_for_upload"

    unsafe = local_stage_request()
    unsafe["payload"]["path"] = "/etc/shadow"
    with pytest.raises(Exception, match="invalid_payload_fields"):
        parse_backup_stage_request(unsafe)

    unsafe = local_stage_request()
    unsafe["payload"]["secret_key"] = "secret"
    with pytest.raises(Exception, match="invalid_payload_fields"):
        parse_backup_stage_request(unsafe)


def test_stager_exports_read_only_workspace_and_root_purges_it(tmp_path: Path) -> None:
    claim = valid_upload_claim()
    request = parse_backup_stage_request(local_stage_request())
    work_root = tmp_path / "work"
    workspace = work_root / "backups" / request.operation_id
    workspace.mkdir(parents=True)
    (workspace / "database.dump").write_bytes(b"DATABASE")
    (workspace / "filestore.tar.gz").write_bytes(b"FILESTORE")
    (workspace / "manifest.json").write_bytes(claim["manifest_bytes"])

    outbox = tmp_path / "outbox"
    outbox.mkdir(mode=0o750)
    user_uid = os.getuid()
    group = grp.getgrgid(os.getgid()).gr_name
    config = ProvisionerConfig(
        enabled=True,
        phase="test-only",
        postgres_os_user="postgres",
        work_root=work_root,
        profiles={},
    )
    stager = BackupArtifactStager(
        config,
        outbox_root=outbox,
        export_group=group,
        outbox_owner_uid=user_uid,
    )

    assert stager.stage(request) == {"state": "staged"}
    staged = outbox / request.operation_id
    assert stat.S_IMODE(staged.stat().st_mode) == 0o750
    assert (staged / "database.dump").read_bytes() == b"DATABASE"
    assert (staged / "filestore.tar.gz").read_bytes() == b"FILESTORE"
    assert (staged / "manifest.json").read_bytes() == claim["manifest_bytes"]
    for name in ("database.dump", "filestore.tar.gz", "manifest.json"):
        assert stat.S_IMODE((staged / name).stat().st_mode) == 0o440

    purge_payload = local_stage_request()
    purge_payload["type"] = "purge_verified_backup"
    purge = parse_backup_stage_request(purge_payload)
    assert stager.purge(purge) == {"state": "purged"}
    assert not workspace.exists()
    assert not staged.exists()


def test_stager_rejects_group_writable_outbox(tmp_path: Path) -> None:
    request = parse_backup_stage_request(local_stage_request())
    work_root = tmp_path / "work"
    workspace = work_root / "backups" / request.operation_id
    workspace.mkdir(parents=True)
    claim = valid_upload_claim()
    (workspace / "database.dump").write_bytes(b"DATABASE")
    (workspace / "filestore.tar.gz").write_bytes(b"FILESTORE")
    (workspace / "manifest.json").write_bytes(claim["manifest_bytes"])

    outbox = tmp_path / "outbox"
    outbox.mkdir(mode=0o770)
    os.chmod(outbox, 0o770)
    config = ProvisionerConfig(
        enabled=True,
        phase="test-only",
        postgres_os_user="postgres",
        work_root=work_root,
        profiles={},
    )
    stager = BackupArtifactStager(
        config,
        outbox_root=outbox,
        export_group=grp.getgrgid(os.getgid()).gr_name,
        outbox_owner_uid=os.getuid(),
    )
    with pytest.raises(Exception, match="backup_outbox_permissions_insecure"):
        stager.stage(request)
