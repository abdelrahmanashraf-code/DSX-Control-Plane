import stat

from dsx_node_agent.state import NodeIdentity, load_identity, save_identity


def test_identity_roundtrip_and_private_permissions(tmp_path) -> None:
    path = tmp_path / "agent" / "identity.json"
    identity = NodeIdentity(node_id="node-123", agent_token="secret-token")

    save_identity(path, identity)

    assert load_identity(path) == identity
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
