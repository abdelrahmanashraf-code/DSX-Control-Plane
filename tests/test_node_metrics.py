from dsx_node_agent.metrics import collect_node_metrics


def test_collect_node_metrics_has_expected_safe_fields() -> None:
    payload = collect_node_metrics()

    expected = {
        "observed_at",
        "hostname",
        "os",
        "os_release",
        "architecture",
        "cpu_count",
        "cpu_percent",
        "memory_total_bytes",
        "memory_available_bytes",
        "memory_percent",
        "disk_total_bytes",
        "disk_free_bytes",
        "disk_percent",
        "boot_time",
        "services",
        "runtime_inventory",
    }

    assert expected.issubset(payload)
    assert payload["cpu_count"] >= 1
    assert payload["memory_total_bytes"] > 0
    assert payload["disk_total_bytes"] > 0
    assert isinstance(payload["services"]["odoo"]["running"], bool)
    assert isinstance(payload["services"]["postgresql"]["running"], bool)
    assert payload["runtime_inventory"]["collection_mode"] == "read_only_local"
