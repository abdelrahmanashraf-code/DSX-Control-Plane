from dsx_node_agent.metrics import collect_node_metrics


def test_heartbeat_metrics_include_placement_capacity_shape() -> None:
    metrics = collect_node_metrics()

    assert metrics["memory"]["available_bytes"] == metrics["memory_available_bytes"]
    assert metrics["memory"]["total_bytes"] == metrics["memory_total_bytes"]
    assert metrics["disk"]["free_bytes"] == metrics["disk_free_bytes"]
    assert metrics["disk"]["total_bytes"] == metrics["disk_total_bytes"]

    assert metrics["memory"]["available_bytes"] >= 0
    assert metrics["disk"]["free_bytes"] >= 0
