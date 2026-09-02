from __future__ import annotations

import os
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_state_file() -> Path:
    explicit = os.getenv("DSX_AGENT_STATE_FILE")
    if explicit:
        return Path(explicit).expanduser()
    xdg_state = os.getenv("XDG_STATE_HOME")
    base = Path(xdg_state).expanduser() if xdg_state else Path.home() / ".local" / "state"
    return base / "dsx-node-agent" / "identity.json"


class AgentSettings(BaseSettings):
    # Production agents receive configuration only through explicit DSX_* environment
    # variables (systemd loads /etc/dsx-node-agent.env). Do not auto-read a cwd .env:
    # the service account may not be allowed to inspect the caller's working directory,
    # and implicit dotenv discovery is unnecessary for the node-agent trust boundary.
    model_config = SettingsConfigDict(
        env_prefix="DSX_",
        extra="ignore",
    )

    control_plane_url: str = Field(default="http://127.0.0.1:8787")
    node_name: str = Field(default="test-node")
    enrollment_token: SecretStr | None = None
    agent_state_file: Path = Field(default_factory=_default_state_file)
    heartbeat_seconds: int = Field(default=30, ge=10, le=300)
    request_timeout_seconds: float = Field(default=10.0, ge=2.0, le=60.0)
    agent_version: str = Field(default="0.1.0")

    @property
    def base_url(self) -> str:
        return self.control_plane_url.rstrip("/")
