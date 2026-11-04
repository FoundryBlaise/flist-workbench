"""Shared pytest setup for the sidecar suite."""

from pathlib import Path

import pytest

import model_weights
from data_invariants import *  # noqa: F401,F403 - fixture, markers and hooks
from stream_events import stream_events_declared  # noqa: F401 - autouse fixture
from services.local_access import RENDERER_ORIGIN_ENV, SECRET_ENV
from sidecar_client import TEST_LAUNCH_SECRET

pytest_plugins = ["pytester"]


@pytest.fixture(autouse=True)
def _launch_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every sidecar in a test runs as Electron would start it."""
    monkeypatch.setenv(SECRET_ENV, TEST_LAUNCH_SECRET)
    monkeypatch.delenv(RENDERER_ORIGIN_ENV, raising=False)


@pytest.fixture(autouse=True)
def _real_model_weights_stay(
    monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory
) -> None:
    """The sidecar removes stale model weights when it starts, and every
    test that runs it would reach the user's real model folder unless it
    set a temporary data folder. Outside pytest's temp folders there is
    no model folder to find."""
    base = tmp_path_factory.getbasetemp().resolve()
    real = model_weights.models_dir

    def models_dir() -> Path:
        folder = real()
        return folder if folder.resolve().is_relative_to(base) else base / "no-models"

    monkeypatch.setattr(model_weights, "models_dir", models_dir)
