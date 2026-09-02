import pytest
from dsx_node_agent.operation_dispatch import (
    CleanupClaimedOperation,
    execute_any_operation,
    parse_any_claimed_operation,
)
from dsx_node_agent.operations import OperationProtocolError
from dsx_node_agent.provisioner import ProvisionerError
from dsx_node_agent.provisioner_service import parse_cleanup_request


def valid_cleanup_claim() -> dict:
    return {
        "operation": {
            "id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "type": "cleanup_test_odoo_environment",
            "lease_token": "dsx_cleanup_lease_12345678901234567890",
            "lease_expires_at": "2026-09-02T20:00:00.000Z",
            "payload": {
                "tenant_id": "12345678-abcd-4abc-8abc-1234567890ab",
                "environment_kind": "test",
                "template_id": "template-restaurant-v1",
                "provisioning_operation_id": "94510378-b752-4dab-a4c7-625af6a9b252",
                "database_name": "dsx_restaurant_demo_12345678",
            },
        }
    }


def test_cleanup_claim_is_strictly_typed() -> None:
    operation = parse_any_claimed_operation(valid_cleanup_claim())
    assert isinstance(operation, CleanupClaimedOperation)
    assert operation.operation_type == "cleanup_test_odoo_environment"
    assert operation.payload.environment_kind == "test"
    assert operation.payload.provisioning_operation_id == "94510378-b752-4dab-a4c7-625af6a9b252"


def test_cleanup_claim_rejects_production_and_extra_path() -> None:
    claim = valid_cleanup_claim()
    claim["operation"]["payload"]["environment_kind"] = "production"
    with pytest.raises(OperationProtocolError, match="cleanup_non_test_environment_blocked"):
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


def test_privileged_cleanup_parser_requires_test_only_identity_fields() -> None:
    operation = valid_cleanup_claim()["operation"]
    parsed = parse_cleanup_request(operation)
    assert parsed.database_name == "dsx_restaurant_demo_12345678"
    assert parsed.environment_kind == "test"

    unsafe = valid_cleanup_claim()["operation"]
    unsafe["payload"]["path"] = "/etc/shadow"
    with pytest.raises(ProvisionerError, match="invalid_payload_fields"):
        parse_cleanup_request(unsafe)

    production = valid_cleanup_claim()["operation"]
    production["payload"]["environment_kind"] = "production"
    with pytest.raises(ProvisionerError, match="cleanup_non_test_environment_blocked"):
        parse_cleanup_request(production)
