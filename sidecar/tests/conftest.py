"""Shared pytest setup for the sidecar suite."""

from data_invariants import *  # noqa: F401,F403 - fixture, markers and hooks

pytest_plugins = ["pytester"]
