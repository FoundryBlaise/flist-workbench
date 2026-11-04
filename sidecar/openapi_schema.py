"""The sidecar's OpenAPI schema, as committed in `openapi.json`.

The renderer's API types are generated from that file
(`npm run gen:api` runs this script, then openapi-typescript), so a
field renamed in Python fails the TypeScript type-check.
`tests/test_openapi_schema.py` fails when the committed file is not
what the app says now.

Read from the app without starting it: no server, no lifespan, no data
folder touched. Run as a script, it writes the file:

    uv run --project sidecar --no-sync python sidecar/openapi_schema.py
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

SCHEMA_PATH = Path(__file__).resolve().parent / "openapi.json"

#: The schema's `info.version`. The app reports the installed version
#: (`/health`), which differs per build; the committed schema must not.
SCHEMA_VERSION = "0.0.0-dev"


def schema() -> dict[str, Any]:
    """The app's OpenAPI schema, with a fixed version."""
    from server import app

    document = copy.deepcopy(app.openapi())
    document["info"]["version"] = SCHEMA_VERSION
    return document


def render() -> str:
    """The schema as the committed file holds it: indented JSON, one
    trailing newline, so a change reads as a line diff."""
    return json.dumps(schema(), indent=2, ensure_ascii=False) + "\n"


def main() -> None:
    SCHEMA_PATH.write_text(render(), encoding="utf-8", newline="\n")
    print(f"wrote {SCHEMA_PATH}")


if __name__ == "__main__":
    main()
