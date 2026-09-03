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

    # Remote typed-operation polling and local privileged execution use separate gates.
    # Both remain false until the Phase 3 non-production acceptance procedure enables them.
    enable_operations: bool = Field(default=False)
    operation_poll_seconds: int = Field(default=30, ge=10, le=300)
    enable_provisioning_execution: bool = Field(default=False)
    provisioner_socket: Path = Field(default=Path("/run/dsx-provisioner/provisioner.sock"))
    provisioner_timeout_seconds: float = Field(default=1800.0, ge=30.0, le=3600.0)

    # Backup object-storage credentials are node-local only. They are never supplied by
    # Control Plane operation payloads. Phase 4 uses an S3-compatible Cloudflare R2 bucket.
    backup_s3_endpoint_url: str | None = None
    backup_s3_bucket: str | None = None
    backup_s3_region: str = Field(default="auto", min_length=1, max_length=64)
    backup_s3_access_key_id: SecretStr | None = None
    backup_s3_secret_access_key: SecretStr | None = None
    backup_outbox_root: Path = Field(default=Path("/var/lib/dsx-node-agent/backup-outbox"))

    @property
    def base_url(self) -> str:
        return self.control_plane_url.rstrip("/")
