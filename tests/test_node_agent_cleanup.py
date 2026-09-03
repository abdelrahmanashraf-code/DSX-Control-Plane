from pathlib import Path

import pytest
from dsx_node_agent.operation_dispatch import (
    CleanupClaimedOperation,
    execute_any_operation,
    parse_any_claimed_operation,
)
from dsx_node_agent.operations import OperationProtocolError
from dsx_node_agent.provisioner import (
    CommandResult,
    ProvisionerConfig,
    ProvisionerError,
    ProvisionerProfile,
)
from dsx_node_agent.provisioner_service import CleanupEngine, parse_cleanup_request


def valid_cleanup_claim(environment_kind: str = "test") -> dict:
    return {
        "operation": {
            "id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "type": "cleanup_test_odoo_environment",
            "lease_token": "dsx_cleanup_lease_12345678901234567890",
            "lease_expires_at": "2026-09-02T20:00:00.000Z",
            "payload": {
                "tenant_id": "12345678-abcd-4abc-8abc-1234567890ab",
                "environment_kind": environment_kind,
                "template_id": "template-restaurant-v1",
                "provisioning_operation_id": "94510378-b752-4dab-a4c7-625af6a9b252",
                "database_name": "dsx_restaurant_demo_12345678",
            },
        }
    }


def valid_privileged_cleanup_request(environment_kind: str = "test") -> dict:
    operation = valid_cleanup_claim(environment_kind)["operation"]
    return {
        "operation_id": operation["id"],
        "type": operation["type"],
        "payload": operation["payload"],
    }


def cleanup_config(tmp_path: Path, phase: str = "test-only") -> ProvisionerConfig:
    return ProvisionerConfig(
        enabled=True,
        phase=phase,
        postgres_os_user="postgres",
        work_root=tmp_path / "work",
        profiles={
            "template-restaurant-v1": ProvisionerProfile(
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
        },
    )


class MarkerMismatchProvisioning:
    def __init__(self) -> None:
        self.drop_calls = 0

    def _database_exists(self, database_name: str) -> bool:
        return True

    def _run_postgres(self, argv: list[str], **kwargs) -> CommandResult:
        if argv[0] == "/usr/bin/dropdb":
            self.drop_calls += 1
            return CommandResult(returncode=0, stdout="")
        if "--dbname=postgres" in argv:
            return CommandResult(returncode=0, stdout="odoo\n")
        return CommandResult(
            returncode=0,
            stdout=(
                "wrong-tenant\ttemplate-restaurant-v1\t"
                "94510378-b752-4dab-a4c7-625af6a9b252\n"
            ),
        )


def test_cleanup_claim_is_strictly_typed() -> None:
    operation = parse_any_claimed_operation(valid_cleanup_claim())
    assert isinstance(operation, CleanupClaimedOperation)
    assert operation.operation_type == "cleanup_test_odoo_environment"
    assert operation.payload.environment_kind == "test"
    assert operation.payload.provisioning_operation_id == "94510378-b752-4dab-a4c7-625af6a9b252"


def test_cleanup_claim_accepts_trial_but_rejects_production_and_extra_path() -> None:
    trial = parse_any_claimed_operation(valid_cleanup_claim("trial"))
    assert isinstance(trial, CleanupClaimedOperation)
    assert trial.payload.environment_kind == "trial"

    claim = valid_cleanup_claim("production")
    with pytest.raises(OperationProtocolError, match="cleanup_production_environment_blocked"):
        parse_any_claimed_operation(claim)

    claim = valid_cleanup_claim()
    claim["operation"]["payload"]["path"] = "/var/lib/odoo"
    with pytest.raises(OperationProtocolError, match="invalid_operation_payload_fields"):
        parse_any_claimed_operation(claim)


def test_cleanup_executor_fails_closed_without_privileged_socket() -> None:
    operation = parse_any_claimed_operation(valid_cleanup_claim())
    assert isinstance(operation, CleanupClaimedOperation)
    result = execute_any_operation(operation, provisioner_socket=None)
    assert result.state == "failed"
    assert result.error_code == "cleanup_executor_not_ready"


def test_privileged_cleanup_parser_accepts_test_and_trial_only() -> None:
    parsed = parse_cleanup_request(valid_privileged_cleanup_request())
    assert parsed.database_name == "dsx_restaurant_demo_12345678"
    assert parsed.environment_kind == "test"

    trial = parse_cleanup_request(valid_privileged_cleanup_request("trial"))
    assert trial.environment_kind == "trial"

    unsafe = valid_privileged_cleanup_request()
    unsafe["payload"]["path"] = "/etc/shadow"
    with pytest.raises(ProvisionerError, match="invalid_payload_fields"):
        parse_cleanup_request(unsafe)

    production = valid_privileged_cleanup_request("production")
    with pytest.raises(ProvisionerError, match="cleanup_production_environment_blocked"):
        parse_cleanup_request(production)


def test_privileged_cleanup_boundary_never_accepts_lease_fields() -> None:
    claim_operation = valid_cleanup_claim()["operation"]
    with pytest.raises(ProvisionerError, match="invalid_request_fields"):
        parse_cleanup_request(claim_operation)


def test_trial_cleanup_requires_explicit_trial_enabled_phase(tmp_path: Path) -> None:
    request = parse_cleanup_request(valid_privileged_cleanup_request("trial"))
    provisioning = MarkerMismatchProvisioning()
    engine = CleanupEngine(cleanup_config(tmp_path, phase="test-only"), provisioning)

    with pytest.raises(ProvisionerError, match="cleanup_trial_environment_blocked"):
        engine.cleanup(request)
    assert provisioning.drop_calls == 0


def test_trial_enabled_phase_reaches_same_identity_guards(tmp_path: Path) -> None:
    request = parse_cleanup_request(valid_privileged_cleanup_request("trial"))
    provisioning = MarkerMismatchProvisioning()
    engine = CleanupEngine(cleanup_config(tmp_path, phase="trial-enabled"), provisioning)

    with pytest.raises(ProvisionerError, match="cleanup_marker_mismatch"):
        engine.cleanup(request)
    assert provisioning.drop_calls == 0


def test_cleanup_marker_mismatch_blocks_drop_before_filestore_mutation(tmp_path: Path) -> None:
    provisioning = MarkerMismatchProvisioning()
    engine = CleanupEngine(cleanup_config(tmp_path), provisioning)
    request = parse_cleanup_request(valid_privileged_cleanup_request())

    with pytest.raises(ProvisionerError, match="cleanup_marker_mismatch"):
        engine.cleanup(request)

    assert provisioning.drop_calls == 0
    assert not (tmp_path / "filestore").exists()


def test_cleanup_source_database_is_never_allowed(tmp_path: Path) -> None:
    request_payload = valid_privileged_cleanup_request()
    request_payload["payload"]["database_name"] = "dsx_restaurant_demo_master"
    request = parse_cleanup_request(request_payload)
    provisioning = MarkerMismatchProvisioning()
    engine = CleanupEngine(cleanup_config(tmp_path), provisioning)

    with pytest.raises(ProvisionerError, match="cleanup_source_database_blocked"):
        engine.cleanup(request)

    assert provisioning.drop_calls == 0
