"""The sidecar's OpenAPI schema is what the renderer's API types are
generated from (`npm run gen:api`). These tests keep the committed
schema honest: it is the app's schema, it names every refusal code, and
each route says what it answers."""

from __future__ import annotations

from pathlib import Path

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


#: Where a job takes its code from something other than a literal or a
#: constant: `_drive` fails a stream job with the code of the stream's
#: `error` event, which `sse.error` (checked below) or a refusal built.
FORWARDED_JOB_CODES = {("services/jobs.py", "_drive")}


def _job_failure_codes_in_code() -> tuple[set[str], list[str]]:
    """Every code a job fails with (`job.fail(code, ...)`) or a job's
    stream stops with (`sse.error(stage, code, ...)`), read from the
    source; plus the calls whose code could not be read."""
    import ast
    import importlib

    sidecar = Path(openapi_schema.__file__).resolve().parent
    codes: set[str] = set()
    unreadable: list[str] = []
    for path in sorted(sidecar.rglob("*.py")):
        rel = path.relative_to(sidecar).as_posix()
        if rel.startswith((".venv/", "tests/")):
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        module = None
        # Module functions and methods, each with the functions nested in it.
        defs = tree.body + [n for c in tree.body if isinstance(c, ast.ClassDef) for n in c.body]
        for func in [n for n in defs if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
            for call in [n for n in ast.walk(func) if isinstance(n, ast.Call)]:
                f = call.func
                if not isinstance(f, ast.Attribute) or not isinstance(f.value, ast.Name):
                    continue
                if (f.value.id, f.attr) == ("job", "fail"):
                    arg = call.args[0]
                elif (f.value.id, f.attr) == ("sse", "error"):
                    arg = call.args[1]
                else:
                    continue
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    codes.add(arg.value)
                elif isinstance(arg, ast.Name):
                    if module is None:
                        module = importlib.import_module(rel.removesuffix(".py").replace("/", "."))
                    codes.add(str(getattr(module, arg.id)))
                elif (rel, func.name) not in FORWARDED_JOB_CODES:
                    unreadable.append(f"{rel}:{call.lineno}")
    return codes, unreadable


def test_the_schema_names_every_code_a_job_fails_with() -> None:
    schemas = openapi_schema.schema()["components"]["schemas"]
    job_codes = set(schemas["RefusalCode"]["enum"]) | set(schemas["JobFailureCode"]["enum"])
    codes, unreadable = _job_failure_codes_in_code()

    assert unreadable == [], "use a literal or a module constant as the code"
    assert {"embedding_model_changed", "not_signed_in", "internal_error"} <= codes
    missing = codes - job_codes
    assert missing == set(), f"add these to wire.JobFailureCode: {sorted(missing)}"


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
#: #127 health + settings; #128-#130 add theirs; #131 makes it every
#: group and drops this list).
TYPED_GROUPS = {
    "health",
    "settings",
    "live",
    "workbench",
    "pull_backups",
    "upload",
    "logs",
    "labels",
    "aliases",
    "index",
    "jobs",
}

#: What a route that answers no JSON model declares instead: an event
#: stream, bytes, or nothing.
NOT_JSON = {"text/event-stream", "application/octet-stream", "application/zip", "image/png", "image/jpeg"}


def _names_models(schema: dict) -> bool:
    """Whether a body schema is a model, a list of models, or one of
    several models (a route answering either shape, such as a Backup
    saved or not)."""
    if schema.get("$ref", "").startswith("#/components/schemas/"):
        return True
    if schema.get("type") == "array":
        return _names_models(schema.get("items", {}))
    branches = schema.get("anyOf") or schema.get("oneOf")
    return bool(branches) and all(_names_models(b) for b in branches)


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
            if not _names_models(body.get("schema", {})):
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
