from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_ok():
    res = client.get("/api/v1/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["mapCenter"] == [52.2297, 21.0122]


def test_cors_allows_angular_dev_server():
    res = client.get("/api/v1/health", headers={"Origin": "http://localhost:4200"})
    assert res.headers.get("access-control-allow-origin") == "http://localhost:4200"
