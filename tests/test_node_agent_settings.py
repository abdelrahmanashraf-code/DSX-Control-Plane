from pathlib import Path

from dsx_node_agent.settings import AgentSettings


def test_agent_settings_never_auto_reads_cwd_dotenv(monkeypatch, tmp_path: Path) -> None:
    dotenv = tmp_path / ".env"
    dotenv.write_text("DSX_NODE_NAME=should-not-be-read\n", encoding="utf-8")
    dotenv.chmod(0o000)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DSX_NODE_NAME", "explicit-node")

    settings = AgentSettings()

    assert settings.node_name == "explicit-node"
    assert AgentSettings.model_config.get("env_file") is None
