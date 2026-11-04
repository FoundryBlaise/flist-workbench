"""A TestClient that calls the sidecar the way the app window does.

The sidecar answers only requests that carry the real Host and the
launch secret Electron hands it at spawn (ADR 0002). Tests that are not
about that gate build their client here, so the gate stays on and every
other test still speaks to it like the app.

The route sweep lives here too: tests that check a rule on every route
take the routes from the app itself, so a route added later is covered
without touching the test.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from httpx import Response

#: What `conftest.py` puts into the sidecar's environment for every test.
TEST_LAUNCH_SECRET = "test-launch-secret"
SECRET_HEADER = "X-Workbench-Secret"
BASE_URL = "http://127.0.0.1:27384"


def app_client(app: Any, **kwargs: Any) -> TestClient:
    """A client with the app window's Host and launch secret."""
    headers = {SECRET_HEADER: TEST_LAUNCH_SECRET, **kwargs.pop("headers", {})}
    kwargs.setdefault("base_url", BASE_URL)
    return TestClient(app, headers=headers, **kwargs)


# ---- the route sweep ---------------------------------------------------------


@dataclass(frozen=True)
class Route:
    """One method on one path template, as the app declares it. `group`
    is the area that declares it: the router module's name (`workbench`,
    `labels`, ...)."""

    method: str
    path: str
    group: str = ""

    def url(self, **params: str) -> str:
        """The path with the named parameters filled in, every other one as `x`."""
        path = self.path
        for name, value in params.items():
            path = path.replace(f"{{{name}}}", value)
        return re.sub(r"\{[^}]+\}", "x", path)


def api_routes(app: Any, *, param: str | None = None) -> list[Route]:
    """Every declared API route, or only those whose path takes `param`."""
    routes = []
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        if param is not None and f"{{{param}}}" not in route.path:
            continue
        group = route.endpoint.__module__.rpartition(".")[2]
        for method in sorted(route.methods - {"HEAD"}):
            routes.append(Route(method, route.path, group))
    return routes


def character_routes(app: Any) -> list[Route]:
    """Every route that turns a `{character_id}` from the URL into a folder."""
    return api_routes(app, param="character_id")


def sweep(
    client: TestClient,
    routes: Iterable[Route],
    accept: Callable[[Response], bool],
    *,
    json: Any = None,
    **params: str,
) -> list[str]:
    """Call every route once and describe each answer `accept` rejects.

    `params` fill the path (see `Route.url`); `json` is sent as the body.
    Every error the sweep provokes must also be in the agreed
    `{code, message, details}` shape, whatever `accept` says, so callers
    can show the reason without special cases.
    An empty result means every route answered as expected, so a test
    asserts `== []` and a failure lists the routes that let it down.
    """
    failures = []
    for route in routes:
        url = route.url(**params)
        res = client.request(route.method, url, json=json)
        if not accept(res):
            failures.append(f"{route.method} {url} -> {res.status_code}")
        elif res.status_code >= 400 and not is_refusal_shaped(res):
            failures.append(
                f"{route.method} {url} -> {res.status_code} not {{code, message, details}}: {res.text[:200]}"
            )
    return failures


#: The keys of every error body, and nothing else.
ERROR_KEYS = {"code", "message", "details"}


def is_refusal_shaped(res: Response) -> bool:
    """True when the body is exactly `{code, message, details}`: a code
    the schema lists (`refusals.RefusalCode`), a string message and a
    `details` object, with no error object nested inside it."""
    from refusals import RefusalCode

    try:
        body = res.json()
    except ValueError:
        return False
    return (
        isinstance(body, dict)
        and set(body) == ERROR_KEYS
        and body["code"] in set(RefusalCode)
        and isinstance(body["message"], str)
        and isinstance(body["details"], dict)
        and not any(_is_error_object(v) for v in body["details"].values())
    )


def _is_error_object(value: Any) -> bool:
    return isinstance(value, dict) and "code" in value and "message" in value


def error_code(res: Response) -> str | None:
    """The `code` of a refusal, or None when the body has none."""
    try:
        return res.json().get("code")
    except ValueError:
        return None


def disk_tree(root: Path) -> set[str]:
    """Every file and folder under `root`, to prove a request left it alone."""
    return {str(p.relative_to(root)) for p in root.rglob("*")}
