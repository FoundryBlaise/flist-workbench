"""Shared pytest setup for the sidecar suite."""

import pytest

from data_invariants import *  # noqa: F401,F403 - fixture, markers and hooks
from services.local_access import RENDERER_ORIGIN_ENV, SECRET_ENV
from sidecar_client import TEST_LAUNCH_SECRET

pytest_plugins = ["pytester"]


@pytest.fixture(autouse=True)
def _launch_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every sidecar in a test runs as Electron would start it."""
    monkeypatch.setenv(SECRET_ENV, TEST_LAUNCH_SECRET)
    monkeypatch.delenv(RENDERER_ORIGIN_ENV, raising=False)
