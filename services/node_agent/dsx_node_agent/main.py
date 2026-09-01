import json

from dsx_node_agent.metrics import collect_node_metrics


def main() -> None:
    """Local diagnostic entry point until secure enrollment/heartbeat transport lands."""
    print(json.dumps(collect_node_metrics(), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
