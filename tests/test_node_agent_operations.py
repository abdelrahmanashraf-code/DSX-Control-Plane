from dsx_node_agent.operations import (
    OperationProtocolError,
    execute_operation,
    parse_claimed_operation,
)


def valid_claim() -> dict:
    return {
        "operation": {
            "id": "12345678-abcd-4abc-8abc-1234567890ab",
            "type": "provision_odoo_environment",
            "lease_token": "dsx_lease_12345678901234567890",
            "lease_expires_at": "2026-09-02T18:00:00.000Z",
            "payload": {
                "tenant_id": "12345678-abcd-4abc-8abc-1234567890ab",
                "tenant_slug": "demo-restaurant",
                "sector": "restaurant",
                "environment_kind": "test",
                "template_id": "template-restaurant-v1",
                "template_version": 1,
                "odoo_major": 18,
                "database_name": "dsx_restaurant_demo_restaurant_12345678",
                "modules": ["point_of_sale", "ds_pos_delivery"],
            },
        }
    }


def test_empty_claim_is_safe() -> None:
    assert parse_claimed_operation({"operation": None}) is None


def test_valid_claim_is_strictly_typed() -> None:
    operation = parse_claimed_operation(valid_claim())
    assert operation is not None
    assert operation.operation_type == "provision_odoo_environment"
    assert operation.payload.sector == "restaurant"
    assert operation.payload.modules == ("point_of_sale", "ds_pos_delivery")
    assert operation.payload.database_name == "dsx_restaurant_demo_restaurant_12345678"


def test_claim_rejects_unknown_operation_type() -> None:
    claim = valid_claim()
    claim["operation"]["type"] = "shell"

    try:
        parse_claimed_operation(claim)
    except OperationProtocolError as exc:
        assert str(exc) == "unsupported_operation_type"
    else:
        raise AssertionError("unknown operation type must be rejected")


def test_claim_rejects_extra_command_or_path_fields() -> None:
    claim = valid_claim()
    claim["operation"]["command"] = "rm -rf /"

    try:
        parse_claimed_operation(claim)
    except OperationProtocolError as exc:
        assert str(exc) == "invalid_operation_fields"
    else:
        raise AssertionError("free-form command field must be rejected")

    claim = valid_claim()
    claim["operation"]["payload"]["path"] = "/etc/shadow"

    try:
        parse_claimed_operation(claim)
    except OperationProtocolError as exc:
        assert str(exc) == "invalid_operation_payload_fields"
    else:
        raise AssertionError("free-form path field must be rejected")


def test_claim_rejects_unsafe_module_name() -> None:
    claim = valid_claim()
    claim["operation"]["payload"]["modules"] = ["point_of_sale", "../../evil"]

    try:
        parse_claimed_operation(claim)
    except OperationProtocolError as exc:
        assert str(exc) == "invalid_module"
    else:
        raise AssertionError("unsafe module name must be rejected")


def test_stage_b_executor_fails_closed_until_stage_c() -> None:
    operation = parse_claimed_operation(valid_claim())
    assert operation is not None

    result = execute_operation(operation)

    assert result.state == "failed"
    assert result.error_code == "provisioning_executor_not_ready"
    assert result.database_name is None
