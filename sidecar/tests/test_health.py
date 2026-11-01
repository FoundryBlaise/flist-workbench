from sidecar_client import app_client

from server import app


def test_health() -> None:
    client = app_client(app)
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert "version" in body
