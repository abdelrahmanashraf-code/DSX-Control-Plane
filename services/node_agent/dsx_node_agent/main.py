from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass

import httpx

from dsx_node_agent.client import ControlPlaneClient
from dsx_node_agent.metrics import collect_node_metrics
from dsx_node_agent.operation_dispatch import (
    AnyClaimedOperation,
    execute_any_operation,
    parse_any_claimed_operation,
)
from dsx_node_agent.operations import OperationExecutionResult, OperationProtocolError
from dsx_node_agent.settings import AgentSettings
from dsx_node_agent.state import NodeIdentity, load_identity


@dataclass
class ActiveOperation:
    operation: AnyClaimedOperation
    future: Future[OperationExecutionResult]
    next_lease_renewal: float
    result: OperationExecutionResult | None = None


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="DSX Node Agent")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("diagnostics", help="Print local, non-secret metrics and exit")
    sub.add_parser("enroll", help="Enroll this node using DSX_ENROLLMENT_TOKEN")
    sub.add_parser("heartbeat-once", help="Send one authenticated heartbeat and exit")
    sub.add_parser("run", help="Run the heartbeat loop")
    return parser


def _start_one_operation(
    client: ControlPlaneClient,
    identity: NodeIdentity,
    settings: AgentSettings,
    executor: ThreadPoolExecutor,
) -> ActiveOperation | None:
    claimed = parse_any_claimed_operation(client.claim_operation(identity))
    if claimed is None:
        return None

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

    socket_path = settings.provisioner_socket if settings.enable_provisioning_execution else None
    future = executor.submit(
        execute_any_operation,
        claimed,
        provisioner_socket=socket_path,
        timeout_seconds=settings.provisioner_timeout_seconds,
    )
    return ActiveOperation(
        operation=claimed,
        future=future,
        next_lease_renewal=time.monotonic() + settings.operation_poll_seconds,
    )


def _advance_active_operation(
    active: ActiveOperation,
    client: ControlPlaneClient,
    identity: NodeIdentity,
    settings: AgentSettings,
) -> bool:
    """Advance one running operation and return True only after terminal result is accepted."""
    now = time.monotonic()
    if active.result is None and active.future.done():
        try:
            active.result = active.future.result()
        except Exception:  # noqa: BLE001 - process boundary must fail closed on executor bugs.
            active.result = OperationExecutionResult(
                state="failed", error_code="local_provisioner_internal_error"
            )

    if active.result is not None:
        result = active.result
        client.report_operation_result(
            identity,
            operation_id=active.operation.operation_id,
            lease_token=active.operation.lease_token,
            state=result.state,
            error_code=result.error_code,
            database_name=result.database_name,
        )
        return True

    if now >= active.next_lease_renewal:
        client.report_operation_result(
            identity,
            operation_id=active.operation.operation_id,
            lease_token=active.operation.lease_token,
            state="running",
        )
        active.next_lease_renewal = now + settings.operation_poll_seconds
    return False


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
    active: ActiveOperation | None = None
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="dsx-provision")
    try:
        while True:
            try:
                client.heartbeat(identity)
            except httpx.HTTPError as exc:
                print(f"heartbeat failed: {type(exc).__name__}", file=sys.stderr, flush=True)

            if active is not None:
                try:
                    if _advance_active_operation(active, client, identity, settings):
                        active = None
                except httpx.HTTPError as exc:
                    print(
                        f"operation result failed: {type(exc).__name__}",
                        file=sys.stderr,
                        flush=True,
                    )

            monotonic_now = time.monotonic()
            if (
                active is None
                and settings.enable_operations
                and monotonic_now >= next_operation_poll
            ):
                try:
                    active = _start_one_operation(client, identity, settings, executor)
                except OperationProtocolError as exc:
                    print(f"operation protocol rejected: {exc}", file=sys.stderr, flush=True)
                except httpx.HTTPError as exc:
                    print(
                        f"operation request failed: {type(exc).__name__}",
                        file=sys.stderr,
                        flush=True,
                    )
                next_operation_poll = monotonic_now + settings.operation_poll_seconds

            time.sleep(settings.heartbeat_seconds)
    except KeyboardInterrupt:
        return
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
