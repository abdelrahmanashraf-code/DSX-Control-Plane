# ruff: noqa: I001

import hashlib
import io
from pathlib import Path

from dsx_node_agent import backup_upload
from dsx_node_agent.backup_upload import (
    BackupUploadClaimedOperation,
    BackupUploadPayload,
    ExpectedUploadArtifact,
    execute_backup_upload_operation,
    expected_object_key,
)
from dsx_node_agent.settings import AgentSettings


class FakeS3:
    def __init__(self, *, corrupt_reads: bool = False) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.corrupt_reads = corrupt_reads

    def put_object(self, *, Bucket: str, Key: str, Body, Metadata: dict[str, str]):
        data = Body.read()
        assert Metadata["sha256"] == hashlib.sha256(data).hexdigest()
        self.objects[(Bucket, Key)] = data
        return {"ETag": '"fake-etag"'}

    def get_object(self, *, Bucket: str, Key: str):
        data = self.objects[(Bucket, Key)]
        if self.corrupt_reads and Key.endswith("database.dump"):
            data = b"X" + data[1:]
        return {"ContentLength": len(data), "Body": io.BytesIO(data)}


def upload_operation() -> tuple[BackupUploadClaimedOperation, dict[str, bytes]]:
    files = {
        "database_dump": b"DATABASE",
        "filestore_archive": b"FILESTORE",
        "manifest": b'{"manifest":"test"}\n',
    }
    artifacts = tuple(
        ExpectedUploadArtifact(
            artifact_kind=kind,
            size_bytes=len(data),
            sha256=hashlib.sha256(data).hexdigest(),
        )
        for kind, data in files.items()
    )
    return (
        BackupUploadClaimedOperation(
            operation_id="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            operation_type="upload_verify_backup_artifacts",
            lease_token="dsx_backup_upload_lease_12345678901234567890",
            lease_expires_at="2026-09-03T12:30:00+00:00",
            payload=BackupUploadPayload(
                tenant_id="12345678-abcd-4abc-8abc-1234567890ab",
                environment_kind="test",
                template_id="template-restaurant-v1",
                provisioning_operation_id="94510378-b752-4dab-a4c7-625af6a9b252",
                database_name="dsx_restaurant_phase4_12345678",
                backup_type="full",
                manifest_sha256=next(
                    item.sha256 for item in artifacts if item.artifact_kind == "manifest"
                ),
                total_size_bytes=sum(item.size_bytes for item in artifacts),
                artifacts=artifacts,
            ),
        ),
        files,
    )


def settings(outbox: Path) -> AgentSettings:
    return AgentSettings(
        backup_s3_endpoint_url="https://example.invalid",
        backup_s3_bucket="dsx-backups-nonprod",
        backup_s3_access_key_id="local-test-key",
        backup_s3_secret_access_key="local-test-secret",
        backup_outbox_root=outbox,
    )


def stage_files(outbox: Path, operation: BackupUploadClaimedOperation, files: dict[str, bytes]) -> None:
    job_dir = outbox / operation.operation_id
    job_dir.mkdir(parents=True)
    names = {
        "database_dump": "database.dump",
        "filestore_archive": "filestore.tar.gz",
        "manifest": "manifest.json",
    }
    for kind, data in files.items():
        (job_dir / names[kind]).write_bytes(data)


def test_upload_get_verifies_sha_and_keeps_local_copy_until_cp_ack(
    tmp_path: Path,
    monkeypatch,
) -> None:
    operation, files = upload_operation()
    outbox = tmp_path / "outbox"
    stage_files(outbox, operation, files)
    monkeypatch.setattr(backup_upload, "_call_local_helper", lambda *args, **kwargs: {"state": "staged"})
    storage = FakeS3()

    result = execute_backup_upload_operation(
        operation,
        settings=settings(outbox),
        provisioner_socket=Path("/run/fake.sock"),
        timeout_seconds=30,
        s3_client=storage,
    )

    assert result.state == "verified"
    assert result.error_code is None
    assert result.backup_artifacts is not None
    assert len(result.backup_artifacts) == 3
    assert (outbox / operation.operation_id).is_dir()
    for item in result.backup_artifacts:
        assert item["object_key"] == expected_object_key(operation, str(item["artifact_kind"]))
        assert str(item["object_version"]).startswith("etag:")


def test_remote_checksum_mismatch_fails_closed_and_keeps_local_copy(
    tmp_path: Path,
    monkeypatch,
) -> None:
    operation, files = upload_operation()
    outbox = tmp_path / "outbox"
    stage_files(outbox, operation, files)
    monkeypatch.setattr(backup_upload, "_call_local_helper", lambda *args, **kwargs: {"state": "staged"})

    result = execute_backup_upload_operation(
        operation,
        settings=settings(outbox),
        provisioner_socket=Path("/run/fake.sock"),
        timeout_seconds=30,
        s3_client=FakeS3(corrupt_reads=True),
    )

    assert result.state == "failed"
    assert result.error_code == "backup_storage_checksum_mismatch"
    assert (outbox / operation.operation_id).is_dir()
