# ruff: noqa: I001

from __future__ import annotations

import hashlib
import io
import json
import tarfile
from pathlib import Path

import pytest
from pydantic import SecretStr

from dsx_node_agent import restore_operation
from dsx_node_agent.operation_dispatch import parse_any_claimed_operation
from dsx_node_agent.operations import OperationProtocolError
from dsx_node_agent.provisioner import ProvisionerError
from dsx_node_agent.restore_operation import (
    RestoreClaimedOperation,
    execute_restore_operation,
    parse_restore_claimed_operation,
    purge_restore_download_local,
)
from dsx_node_agent.restore_service import RestoreEngine, parse_restore_request
from dsx_node_agent.settings import AgentSettings


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _archive(source_database: str) -> bytes:
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        root = tarfile.TarInfo(source_database)
        root.type = tarfile.DIRTYPE
        archive.addfile(root)
        payload = b"ODOO-FILESTORE"
        member = tarfile.TarInfo(f"{source_database}/ab/blob")
        member.size = len(payload)
        archive.addfile(member, io.BytesIO(payload))
    return stream.getvalue()


def restore_fixture() -> tuple[dict, dict[str, bytes]]:
    restore_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    backup_id = "c57703c6-48a1-4f5f-85f0-f98328cb7688"
    source_tenant = "5b6099ab-282e-4c7b-a5eb-9b607e2e2362"
    target_tenant = "11111111-2222-4333-8444-555555555555"
    source_provisioning = "d93f3452-a58d-463b-9295-5852c973dcc9"
    source_database = "dsx_restaurant_phase4_backup_gate_20260903_5b6099ab"
    target_database = "dsx_restaurant_restore_phase4_gate_11111111"

    database = b"FAKE-PG-DUMP"
    filestore = _archive(source_database)
    database_artifact = {
        "artifact_kind": "database_dump",
        "file_name": "database.dump",
        "size_bytes": len(database),
        "sha256": _sha(database),
    }
    filestore_artifact = {
        "artifact_kind": "filestore_archive",
        "file_name": "filestore.tar.gz",
        "size_bytes": len(filestore),
        "sha256": _sha(filestore),
    }
    manifest_value = {
        "schema_version": 1,
        "backup_id": backup_id,
        "tenant_id": source_tenant,
        "environment_kind": "test",
        "template_id": "template-restaurant-v1",
        "provisioning_operation_id": source_provisioning,
        "database_name": source_database,
        "backup_type": "full",
        "created_at": "2026-09-03T09:37:47Z",
        "artifacts": [database_artifact, filestore_artifact],
    }
    manifest = (json.dumps(manifest_value, sort_keys=True, separators=(",", ":")) + "\n").encode()

    objects = {
        f"test/{source_tenant}/{backup_id}/database.dump": database,
        f"test/{source_tenant}/{backup_id}/filestore.tar.gz": filestore,
        f"test/{source_tenant}/{backup_id}/manifest.json": manifest,
    }
    artifacts = [
        {
            "artifact_kind": "database_dump",
            "object_key": f"test/{source_tenant}/{backup_id}/database.dump",
            "object_version": "etag:db",
            "size_bytes": len(database),
            "sha256": _sha(database),
        },
        {
            "artifact_kind": "filestore_archive",
            "object_key": f"test/{source_tenant}/{backup_id}/filestore.tar.gz",
            "object_version": "etag:fs",
            "size_bytes": len(filestore),
            "sha256": _sha(filestore),
        },
        {
            "artifact_kind": "manifest",
            "object_key": f"test/{source_tenant}/{backup_id}/manifest.json",
            "object_version": "etag:manifest",
            "size_bytes": len(manifest),
            "sha256": _sha(manifest),
        },
    ]
    claim = {
        "operation": {
            "id": restore_id,
            "type": "restore_verified_backup",
            "lease_token": "dsx_restore_lease_12345678901234567890",
            "lease_expires_at": "2026-09-03T13:00:00+00:00",
            "payload": {
                "backup_job_id": backup_id,
                "source_tenant_id": source_tenant,
                "target_tenant_id": target_tenant,
                "environment_kind": "test",
                "template_id": "template-restaurant-v1",
                "source_provisioning_operation_id": source_provisioning,
                "source_database_name": source_database,
                "target_database_name": target_database,
                "manifest_sha256": _sha(manifest),
                "total_size_bytes": sum(item["size_bytes"] for item in artifacts),
                "artifacts": artifacts,
            },
        }
    }
    return claim, objects


class FakeS3:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = objects

    def get_object(self, *, Bucket: str, Key: str, **kwargs):
        del Bucket, kwargs
        value = self.objects[Key]
        return {"ContentLength": len(value), "Body": io.BytesIO(value)}


def test_restore_claim_is_strict_typed_and_test_only() -> None:
    claim, _ = restore_fixture()
    operation = parse_any_claimed_operation(claim)
    assert isinstance(operation, RestoreClaimedOperation)
    assert operation.payload.environment_kind == "test"
    assert operation.payload.source_tenant_id != operation.payload.target_tenant_id

    unsafe = restore_fixture()[0]
    unsafe["operation"]["payload"]["local_path"] = "/etc/shadow"
    with pytest.raises(OperationProtocolError, match="invalid_operation_payload_fields"):
        parse_restore_claimed_operation(unsafe)

    production = restore_fixture()[0]
    production["operation"]["payload"]["environment_kind"] = "production"
    with pytest.raises(OperationProtocolError, match="restore_non_test_environment_blocked"):
        parse_restore_claimed_operation(production)


def test_restore_download_sha_manifest_and_local_handoff(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    claim, objects = restore_fixture()
    operation = parse_restore_claimed_operation(claim)
    assert operation is not None
    inbox = tmp_path / "restores"
    monkeypatch.setattr(restore_operation, "_RESTORE_INBOX_ROOT", inbox)
    monkeypatch.setattr(
        restore_operation,
        "_call_local_helper",
        lambda operation, **kwargs: {
            "state": "validated",
            "database_name": operation.payload.target_database_name,
        },
    )
    settings = AgentSettings(
        backup_s3_endpoint_url="http://127.0.0.1:9000",
        backup_s3_bucket="dsx-backups-nonprod",
        backup_s3_region="us-east-1",
        backup_s3_access_key_id=SecretStr("access"),
        backup_s3_secret_access_key=SecretStr("secret"),
    )
    result = execute_restore_operation(
        operation,
        settings=settings,
        provisioner_socket=tmp_path / "fake.sock",
        timeout_seconds=30,
        s3_client=FakeS3(objects),
    )
    assert result.state == "validated"
    assert result.database_name == operation.payload.target_database_name
    workspace = inbox / operation.operation_id
    assert (workspace / "database.dump").read_bytes() == next(
        value for key, value in objects.items() if key.endswith("database.dump")
    )
    assert purge_restore_download_local(operation)
    assert not workspace.exists()


def test_restore_download_corruption_fails_closed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    claim, objects = restore_fixture()
    operation = parse_restore_claimed_operation(claim)
    assert operation is not None
    corrupted = dict(objects)
    database_key = next(key for key in corrupted if key.endswith("database.dump"))
    corrupted[database_key] = b"CORRUPTED-DUMP"
    monkeypatch.setattr(restore_operation, "_RESTORE_INBOX_ROOT", tmp_path / "restores")
    settings = AgentSettings(
        backup_s3_endpoint_url="http://127.0.0.1:9000",
        backup_s3_bucket="dsx-backups-nonprod",
        backup_s3_access_key_id=SecretStr("access"),
        backup_s3_secret_access_key=SecretStr("secret"),
    )
    result = execute_restore_operation(
        operation,
        settings=settings,
        provisioner_socket=tmp_path / "fake.sock",
        timeout_seconds=30,
        s3_client=FakeS3(corrupted),
    )
    assert result.state == "failed"
    assert result.error_code in {"restore_storage_size_mismatch", "restore_storage_checksum_mismatch"}


def test_privileged_restore_request_rejects_storage_and_paths() -> None:
    claim, _ = restore_fixture()
    operation = claim["operation"]
    local = {
        "operation_id": operation["id"],
        "type": operation["type"],
        "payload": {
            key: value
            for key, value in operation["payload"].items()
            if key not in {"artifacts"}
        },
    }
    local["payload"]["artifacts"] = [
        {
            "artifact_kind": item["artifact_kind"],
            "size_bytes": item["size_bytes"],
            "sha256": item["sha256"],
        }
        for item in operation["payload"]["artifacts"]
    ]
    parsed = parse_restore_request(local)
    assert parsed.target_database_name == operation["payload"]["target_database_name"]

    local["payload"]["bucket"] = "forbidden"
    with pytest.raises(ProvisionerError, match="invalid_payload_fields"):
        parse_restore_request(local)


def test_restore_tar_member_rejects_traversal_and_links() -> None:
    traversal = tarfile.TarInfo("source_db/../etc/passwd")
    with pytest.raises(ProvisionerError, match="restore_filestore_path_traversal"):
        RestoreEngine._safe_member_relative(traversal, "source_db")

    symlink = tarfile.TarInfo("source_db/link")
    symlink.type = tarfile.SYMTYPE
    symlink.linkname = "/etc/shadow"
    with pytest.raises(ProvisionerError, match="restore_filestore_unsafe_member"):
        RestoreEngine._safe_member_relative(symlink, "source_db")
