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

    def heartbeat(self, identity: NodeIdentity) -> dict[str, Any]:
        metrics = collect_node_metrics()
        response = httpx.post(
            f"{self.settings.base_url}/v1/nodes/{identity.node_id}/heartbeat",
            headers={"Authorization": f"Bearer {identity.agent_token}"},
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
