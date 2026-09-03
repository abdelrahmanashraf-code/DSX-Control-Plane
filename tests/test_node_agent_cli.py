from dsx_node_agent.main import _parser


def test_node_agent_cli_parser_accepts_all_commands() -> None:
    parser = _parser()
    for command in ("diagnostics", "enroll", "heartbeat-once", "run"):
        args = parser.parse_args([command])
        assert args.command == command
