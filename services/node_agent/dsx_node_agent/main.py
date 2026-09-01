from __future__ import annotations

import argparse
import json
import sys
import time

from dsx_node_agent.client import ControlPlaneClient
from dsx_node_agent.metrics import collect_node_metrics
from dsx_node_agent.settings import AgentSettings
from dsx_node_agent.state import load_identity


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="DSX Node Agent")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("diagnostics", help="Print local, non-secret metrics and exit")
    sub.add_parser("enroll", help="Enroll this node using DSX_ENROLLMENT_TOKEN")
    sub.add_parser("heartbeat-once", help="Send one authenticated heartbeat and exit")
    sub.add_parser("run", help="Run the heartbeat loop")
    return parser


def main() -> None:
    args = _parser().parse_args()
    settings = AgentSettings()
    client = ControlPlaneClient(settings)

    if args.command == "diagnostics":
        print(json.dumps(collect_node_metrics(), indent=2, sort_keys=True))
        return

    if args.command == "enroll":
        identity = client.enroll()
        print(f"Enrolled node {identity.node_id}; identity saved to {settings.agent_state_file}")
        return

    identity = load_identity(settings.agent_state_file)
    if args.command == "heartbeat-once":
        print(json.dumps(client.heartbeat(identity), indent=2, sort_keys=True))
        return

    try:
        while True:
            try:
                client.heartbeat(identity)
            except Exception as exc:  # keep agent alive through transient network/control-plane failures
                print(f"heartbeat failed: {type(exc).__name__}", file=sys.stderr, flush=True)
            time.sleep(settings.heartbeat_seconds)
    except KeyboardInterrupt:
        return


if __name__ == "__main__":
    main()
