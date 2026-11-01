"""A TestClient that calls the sidecar the way the app window does.

The sidecar answers only requests that carry the real Host and the
launch secret Electron hands it at spawn (ADR 0002). Tests that are not
about that gate build their client here, so the gate stays on and every
other test still speaks to it like the app.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

#: What `conftest.py` puts into the sidecar's environment for every test.
TEST_LAUNCH_SECRET = "test-launch-secret"
SECRET_HEADER = "X-Workbench-Secret"
BASE_URL = "http://127.0.0.1:27384"


def app_client(app: Any, **kwargs: Any) -> TestClient:
    """A client with the app window's Host and launch secret."""
    headers = {SECRET_HEADER: TEST_LAUNCH_SECRET, **kwargs.pop("headers", {})}
    kwargs.setdefault("base_url", BASE_URL)
    return TestClient(app, headers=headers, **kwargs)
