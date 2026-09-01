from dsx_control_plane.main import app
from fastapi.testclient import TestClient


def test_healthz() -> None:
    client = TestClient(app)
    response = client.get("/healthz")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["service"] == "dsx-control-plane-api"
    assert payload["environment"]
