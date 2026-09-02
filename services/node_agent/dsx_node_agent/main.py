from __future__ import annotations

import argparse
import json
import sys
import time

import httpx

from dsx_node_agent.client import ControlPlaneClient
from dsx_node_agent.metrics import collect_node_metrics
from dsx_node_agent.operations import (
    OperationProtocolError,
    execute_operation,
    parse_claimed_operation,
)
from dsx_node_agent.settings import AgentSettings
from dsx_node_agent.state import NodeIdentity, load_identity


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="DSX Node Agent")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("diagnostics", help="Print local, non-secret metrics and exit")
    sub.add_parser("enroll", help="Enroll this node using DSX_ENROLLMENT_TOKEN")
    sub.add_parser("heartbeat-once", help="Send one authenticated heartbeat and exit")
    sub.add_parser("run", help="Run the heartbeat loop")
    return parser


def _process_one_operation(client: ControlPlaneClient, identity: NodeIdentity) -> bool:
    claimed = parse_claimed_operation(client.claim_operation(identity))
    if claimed is None:
        return False

    print(
        f"claimed typed operation id={claimed.operation_id} type={claimed.operation_type}",
        file=sys.stderr,
        flush=True,
    )
    client.report_operation_result(
        identity,
        operation_id=claimed.operation_id,
        lease_token=claimed.lease_token,
        state="running",
    )

    result = execute_operation(claimed)
    client.report_operation_result(
        identity,
        operation_id=claimed.operation_id,
        lease_token=claimed.lease_token,
        state=result.state,
        error_code=result.error_code,
        database_name=result.database_name,
    )
    return True


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

    next_operation_poll = 0.0
    try:
        while True:
            try:
                client.heartbeat(identity)
            except httpx.HTTPError as exc:
                print(f"heartbeat failed: {type(exc).__name__}", file=sys.stderr, flush=True)

            monotonic_now = time.monotonic()
            if settings.enable_operations and monotonic_now >= next_operation_poll:
                try:
                    _process_one_operation(client, identity)
                except OperationProtocolError as exc:
                    print(f"operation protocol rejected: {exc}", file=sys.stderr, flush=True)
                except httpx.HTTPError as exc:
                    print(f"operation request failed: {type(exc).__name__}", file=sys.stderr, flush=True)
                next_operation_poll = monotonic_now + settings.operation_poll_seconds

            time.sleep(settings.heartbeat_seconds)
    except KeyboardInterrupt:
        return


if __name__ == "__main__":
    main()
