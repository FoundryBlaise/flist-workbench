"""The app stops its sidecar by asking it to (POST /shutdown), and only
the app may ask: the request needs this launch's secret (ADR 0002).

The real process is started here the way Electron starts it, because
what matters is that it really exits, not that a flag was set.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from sidecar_client import BASE_URL, SECRET_HEADER, app_client

SIDECAR_DIR = Path(__file__).resolve().parent.parent
START_BUDGET_S = 60
EXIT_BUDGET_S = 15


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def sidecar_process(tmp_path: Path):  # noqa: ANN201
    """The sidecar as Electron spawns it: `server.py` with a port, a
    version and a launch secret in its environment."""
    port = _free_port()
    secret = "shutdown-test-secret"
    env = {
        **os.environ,
        "SIDECAR_PORT": str(port),
        "FLIST_WORKBENCH_LAUNCH_SECRET": secret,
        "FLIST_WORKBENCH_VERSION": "9.9.9",
        "FLIST_WORKBENCH_DATA_DIR": str(tmp_path / "data"),
        "FLIST_WORKBENCH_OFFLINE_STARTUP": "1",
    }
    proc = subprocess.Popen(
        [sys.executable, "server.py"],
        cwd=SIDECAR_DIR,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + START_BUDGET_S
        while True:
            assert proc.poll() is None, "the sidecar exited before it answered /health"
            try:
                if httpx.get(f"{url}/health", timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            assert time.monotonic() < deadline, "the sidecar did not answer /health"
            time.sleep(0.25)
        yield proc, url, secret
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=10)


def _exit_code(proc: subprocess.Popen, budget_s: float) -> int | None:
    try:
        return proc.wait(timeout=budget_s)
    except subprocess.TimeoutExpired:
        return None


def test_the_app_stops_its_sidecar_by_asking(sidecar_process) -> None:  # noqa: ANN001
    proc, url, secret = sidecar_process
    # The window's event stream is open while the app quits; it must not
    # hold the sidecar up.
    with httpx.Client(timeout=5) as stream_client:
        with stream_client.stream(
            "GET", f"{url}/events", headers={SECRET_HEADER: secret}
        ) as stream:
            assert stream.status_code == 200
            res = httpx.post(f"{url}/shutdown", headers={SECRET_HEADER: secret}, timeout=5)
            assert res.status_code == 202, res.text
            assert res.json() == {"stopping": True}
            assert _exit_code(proc, EXIT_BUDGET_S) == 0


@pytest.mark.parametrize("headers", [{}, {SECRET_HEADER: "guess"}])
def test_a_caller_without_the_launch_secret_cannot_stop_it(
    sidecar_process, headers: dict[str, str]  # noqa: ANN001
) -> None:
    proc, url, _secret = sidecar_process
    res = httpx.post(f"{url}/shutdown", headers=headers, timeout=5)
    assert res.status_code == 401
    assert res.json()["code"] == "unauthorized"
    time.sleep(1)
    assert proc.poll() is None
    assert httpx.get(f"{url}/health", timeout=2).status_code == 200


def test_a_sidecar_the_app_did_not_start_says_it_cannot_stop_itself() -> None:
    """Run in-process (tests, a hand-started `uvicorn server:app`) there
    is no server loop of ours to end: refused, nothing stops."""
    import server

    res = app_client(server.app).post("/shutdown")
    assert res.status_code == 409
    assert res.json()["code"] == "not_stoppable"
    # And a stranger still hears 401 first.
    assert TestClient(server.app, base_url=BASE_URL).post("/shutdown").status_code == 401
