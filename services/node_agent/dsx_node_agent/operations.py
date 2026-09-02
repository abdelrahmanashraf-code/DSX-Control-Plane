from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any


class OperationProtocolError(ValueError):
    pass


@dataclass(frozen=True)
class ProvisionEnvironmentPayload:
    tenant_id: str
    tenant_slug: str
    sector: str
    environment_kind: str
    template_id: str
    template_version: int
    odoo_major: int
    database_name: str
    modules: tuple[str, ...]


@dataclass(frozen=True)
class ClaimedOperation:
    operation_id: str
    operation_type: str
    lease_token: str
    lease_expires_at: str
    payload: ProvisionEnvironmentPayload


@dataclass(frozen=True)
class OperationExecutionResult:
    state: str
    error_code: str | None = None
    database_name: str | None = None


_ALLOWED_OPERATION_TYPE = "provision_odoo_environment"
_ALLOWED_SECTORS = {"restaurant", "cafe", "retail", "supermarket"}
_ALLOWED_ENVIRONMENT_KINDS = {"test", "trial", "production"}
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$")
_SAFE_DATABASE = re.compile(r"^[a-z][a-z0-9_]{2,62}$")
_SAFE_MODULE = re.compile(r"^[A-Za-z0-9_]{1,120}$")


def _string(value: Any, *, max_length: int, field: str) -> str:
    if not isinstance(value, str):
        raise OperationProtocolError(f"invalid_{field}")
    result = value.strip()
    if not result or len(result) > max_length:
        raise OperationProtocolError(f"invalid_{field}")
    return result


def _integer(value: Any, *, minimum: int, maximum: int, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise OperationProtocolError(f"invalid_{field}")
    if value < minimum or value > maximum:
        raise OperationProtocolError(f"invalid_{field}")
    return value


def _require_exact_keys(data: dict[str, Any], allowed: set[str], *, field: str) -> None:
    if set(data) != allowed:
        raise OperationProtocolError(f"invalid_{field}_fields")


def parse_claimed_operation(response_payload: Any) -> ClaimedOperation | None:
    if not isinstance(response_payload, dict):
        raise OperationProtocolError("invalid_claim_response")
    _require_exact_keys(response_payload, {"operation"}, field="claim_response")

    operation = response_payload["operation"]
    if operation is None:
        return None
    if not isinstance(operation, dict):
        raise OperationProtocolError("invalid_operation")

    _require_exact_keys(
        operation,
        {"id", "type", "lease_token", "lease_expires_at", "payload"},
        field="operation",
    )

    operation_id = _string(operation["id"], max_length=64, field="operation_id")
    if not _SAFE_ID.fullmatch(operation_id):
        raise OperationProtocolError("invalid_operation_id")

    operation_type = _string(operation["type"], max_length=64, field="operation_type")
    if operation_type != _ALLOWED_OPERATION_TYPE:
        raise OperationProtocolError("unsupported_operation_type")

    lease_token = _string(operation["lease_token"], max_length=256, field="lease_token")
    if len(lease_token) < 16:
        raise OperationProtocolError("invalid_lease_token")

    lease_expires_at = _string(
        operation["lease_expires_at"], max_length=64, field="lease_expires_at"
    )
    try:
        datetime.fromisoformat(lease_expires_at)
    except ValueError as exc:
        raise OperationProtocolError("invalid_lease_expires_at") from exc

    raw_payload = operation["payload"]
    if not isinstance(raw_payload, dict):
        raise OperationProtocolError("invalid_operation_payload")
    _require_exact_keys(
        raw_payload,
        {
            "tenant_id",
            "tenant_slug",
            "sector",
            "environment_kind",
            "template_id",
            "template_version",
            "odoo_major",
            "database_name",
            "modules",
        },
        field="operation_payload",
    )

    tenant_id = _string(raw_payload["tenant_id"], max_length=64, field="tenant_id")
    tenant_slug = _string(raw_payload["tenant_slug"], max_length=64, field="tenant_slug").lower()
    if len(tenant_slug) < 2 or not _SAFE_SLUG.fullmatch(tenant_slug):
        raise OperationProtocolError("invalid_tenant_slug")

    sector = _string(raw_payload["sector"], max_length=32, field="sector").lower()
    if sector not in _ALLOWED_SECTORS:
        raise OperationProtocolError("invalid_sector")

    environment_kind = _string(
        raw_payload["environment_kind"], max_length=32, field="environment_kind"
    ).lower()
    if environment_kind not in _ALLOWED_ENVIRONMENT_KINDS:
        raise OperationProtocolError("invalid_environment_kind")

    template_id = _string(raw_payload["template_id"], max_length=96, field="template_id")
    if not _SAFE_ID.fullmatch(template_id):
        raise OperationProtocolError("invalid_template_id")

    template_version = _integer(
        raw_payload["template_version"], minimum=1, maximum=10000, field="template_version"
    )
    odoo_major = _integer(raw_payload["odoo_major"], minimum=18, maximum=30, field="odoo_major")

    database_name = _string(raw_payload["database_name"], max_length=63, field="database_name").lower()
    if not _SAFE_DATABASE.fullmatch(database_name):
        raise OperationProtocolError("invalid_database_name")

    raw_modules = raw_payload["modules"]
    if not isinstance(raw_modules, list) or len(raw_modules) > 100:
        raise OperationProtocolError("invalid_modules")
    modules: list[str] = []
    for raw_module in raw_modules:
        module = _string(raw_module, max_length=120, field="module")
        if not _SAFE_MODULE.fullmatch(module):
            raise OperationProtocolError("invalid_module")
        if module not in modules:
            modules.append(module)

    return ClaimedOperation(
        operation_id=operation_id,
        operation_type=operation_type,
        lease_token=lease_token,
        lease_expires_at=lease_expires_at,
        payload=ProvisionEnvironmentPayload(
            tenant_id=tenant_id,
            tenant_slug=tenant_slug,
            sector=sector,
            environment_kind=environment_kind,
            template_id=template_id,
            template_version=template_version,
            odoo_major=odoo_major,
            database_name=database_name,
            modules=tuple(modules),
        ),
    )


def execute_operation(operation: ClaimedOperation) -> OperationExecutionResult:
    """Fail closed until the Phase 3 provisioning executor is explicitly implemented.

    Stage B proves the authenticated typed-operation channel. The real database/filestore
    executor is Stage C and is intentionally not hidden behind arbitrary shell execution.
    """
    if operation.operation_type != _ALLOWED_OPERATION_TYPE:
        return OperationExecutionResult(state="failed", error_code="unsupported_operation_type")
    return OperationExecutionResult(state="failed", error_code="provisioning_executor_not_ready")
