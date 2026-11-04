"""The sidecar's OpenAPI schema is what the renderer's API types are
generated from (`npm run gen:api`). These tests keep the committed
schema honest: it is the app's schema, it names every refusal code, and
each route says what it answers."""

from __future__ import annotations

import openapi_schema


def test_the_committed_schema_is_the_apps_schema() -> None:
    committed = openapi_schema.SCHEMA_PATH.read_text(encoding="utf-8")
    assert committed == openapi_schema.render(), (
        "sidecar/openapi.json is stale: run `npm run gen:api` and commit "
        "the schema and the generated types"
    )


def _refusal_classes() -> list[type]:
    import server  # noqa: F401 - imports every module that raises a refusal
    from refusals import Refusal

    found, todo = [], [Refusal]
    while todo:
        cls = todo.pop()
        found.append(cls)
        todo.extend(cls.__subclasses__())
    return found


def _codes_raised_in_code() -> set[str]:
    """Every code a `Refusal` can carry: a class's own `code`, the codes
    a class takes per instance (`STATUS_BY_CODE`, `CODES`)."""
    codes: set[str] = set()
    for cls in _refusal_classes():
        codes.add(cls.code)
        codes.update(getattr(cls, "STATUS_BY_CODE", {}))
        codes.update(getattr(cls, "CODES", ()))
    return codes


def _schema_refusal_codes() -> set[str]:
    return set(openapi_schema.schema()["components"]["schemas"]["RefusalCode"]["enum"])


def test_the_schema_names_every_refusal_code() -> None:
    missing = _codes_raised_in_code() - _schema_refusal_codes()
    assert missing == set(), f"add these to refusals.RefusalCode: {sorted(missing)}"


def test_the_schema_names_the_refusals_no_class_raises() -> None:
    # The local-access guard, the framework and the error handlers in
    # server.py answer these without a Refusal class.
    assert {
        "unauthorized",
        "forbidden_origin",
        "forbidden_host",
        "invalid_request",
        "internal_error",
        "http_404",
        "http_405",
    } <= _schema_refusal_codes()


def test_every_route_answers_a_refusal_when_it_is_not_ok() -> None:
    undeclared = [
        f"{method.upper()} {path}"
        for path, operations in openapi_schema.schema()["paths"].items()
        for method, operation in operations.items()
        if operation["responses"].get("default", {}).get("content", {}).get("application/json", {}).get("schema")
        != {"$ref": "#/components/schemas/RefusalBody"}
    ]
    assert undeclared == []


#: The router modules whose routes declare what they answer (spec #8:
#: #127 health + settings; #128-#130 add theirs (#130: the F-list
#: session, Foreign profiles, the Pool and the Trash, look-ups and
#: rendering); #131 makes it every
#: group and drops this list).
TYPED_GROUPS = {"health", "settings", "flist_session", "foreign", "images_trash", "lookups", "render"}

#: What a route that answers no JSON model declares instead: an event
#: stream, bytes, or nothing.
NOT_JSON = {
    "text/event-stream",
    "application/octet-stream",
    "application/zip",
    "image/png",
    "image/jpeg",
    "image/gif",
}


def _undeclared_answer(operation: dict) -> str | None:
    """Why `operation`'s ok answer says nothing about its body, or None
    when it names a model (or a stream, bytes, or no body)."""
    ok = {status: r for status, r in operation["responses"].items() if status.startswith("2")}
    if not ok:
        return "no 2xx answer"
    for status, response in ok.items():
        content = response.get("content")
        if status == "204":
            if content:
                return "204 with a body"
            continue
        if not content:
            return f"{status} without content"
        for media_type, body in content.items():
            if media_type in NOT_JSON:
                continue
            ref = body.get("schema", {}).get("$ref", "")
            if not ref.startswith("#/components/schemas/"):
                return f"{status} {media_type} names no model: {body.get('schema')}"
    return None


def test_typed_routes_declare_a_response_model() -> None:
    from sidecar_client import api_routes

    from server import app

    paths = openapi_schema.schema()["paths"]
    problems = []
    for route in api_routes(app):
        if route.group not in TYPED_GROUPS:
            continue
        why = _undeclared_answer(paths[route.path][route.method.lower()])
        if why:
            problems.append(f"{route.method} {route.path}: {why}")
    assert problems == []


def test_model_names_are_unique_across_routers() -> None:
    # Two models of one name get module-qualified names in the schema
    # (`routers__settings__Settings`), and the renderer's names with them.
    names = openapi_schema.schema()["components"]["schemas"]
    assert [name for name in names if "__" in name] == []
