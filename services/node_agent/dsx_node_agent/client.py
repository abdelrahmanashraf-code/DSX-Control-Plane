from __future__ import annotations

import socket
from typing import Any

import httpx

from dsx_node_agent.metrics import collect_node_metrics
from dsx_node_agent.settings import AgentSettings
from dsx_node_agent.state import NodeIdentity, save_identity


class ControlPlaneClient:
    def __init__(self, settings: AgentSettings) -> None:
        self.settings = settings

    def enroll(self) -> NodeIdentity:
        secret = self.settings.enrollment_token
        if secret is None or not secret.get_secret_value().strip():
            raise RuntimeError("DSX_ENROLLMENT_TOKEN is required for enrollment")

        response = httpx.post(
            f"{self.settings.base_url}/v1/nodes/enroll",
            json={
                "enrollment_token": secret.get_secret_value(),
                "name": self.settings.node_name,
                "hostname": socket.gethostname(),
                "agent_version": self.settings.agent_version,
            },
            timeout=self.settings.request_timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        identity = NodeIdentity(
            node_id=str(payload["node_id"]),
            agent_token=str(payload["agent_token"]),
        )
        save_identity(self.settings.agent_state_file, identity)
        return identity

    @staticmethod
    def _agent_headers(identity: NodeIdentity) -> dict[str, str]:
        return {"Authorization": f"Bearer {identity.agent_token}"}

    def heartbeat(self, identity: NodeIdentity) -> dict[str, Any]:
        metrics = collect_node_metrics()
        response = httpx.post(
            f"{self.settings.base_url}/v1/nodes/{identity.node_id}/heartbeat",
            headers=self._agent_headers(identity),
            json={
                "observed_at": metrics["observed_at"],
                "hostname": metrics["hostname"],
                "agent_version": self.settings.agent_version,
                "metrics": metrics,
            },
            timeout=self.settings.request_timeout_seconds,
        )
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {"status": "accepted"}

    def claim_operation(self, identity: NodeIdentity) -> dict[str, Any]:
        response = httpx.post(
            f"{self.settings.base_url}/v1/nodes/{identity.node_id}/operations/claim",
            headers=self._agent_headers(identity),
            timeout=self.settings.request_timeout_seconds,
        )
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise TypeError("invalid_operation_claim_response")
        return data

    def report_operation_result(
        self,
        identity: NodeIdentity,
        *,
        operation_id: str,
        lease_token: str,
        state: str,
        error_code: str | None = None,
        database_name: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "lease_token": lease_token,
            "state": state,
        }
        if error_code is not None:
            payload["error_code"] = error_code
        if database_name is not None:
            payload["database_name"] = database_name

        response = httpx.post(
            f"{self.settings.base_url}/v1/nodes/{identity.node_id}/operations/{operation_id}/result",
            headers=self._agent_headers(identity),
            json=payload,
            timeout=self.settings.request_timeout_seconds,
        )
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {"status": "accepted"}
