from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class NodeIdentity:
    node_id: str
    agent_token: str


def load_identity(path: Path) -> NodeIdentity:
    data = json.loads(path.read_text(encoding="utf-8"))
    node_id = str(data.get("node_id") or "").strip()
    agent_token = str(data.get("agent_token") or "").strip()
    if not node_id or not agent_token:
        raise ValueError(f"Invalid DSX agent identity file: {path}")
    return NodeIdentity(node_id=node_id, agent_token=agent_token)


def save_identity(path: Path, identity: NodeIdentity) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(asdict(identity), indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)
    os.chmod(path, 0o600)
