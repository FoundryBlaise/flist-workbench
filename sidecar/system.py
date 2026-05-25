"""System-level probes used by the AI Setup wizard.

Currently this module only talks to Ollama (the wizard's exclusive
target), but anything else "what does the host environment look like"
goes here so the server module stays focused on HTTP routing.

Why a separate module:
  - Keeps the urllib + json juggling out of server.py.
  - Pure-Python; no third-party deps. Probes happen on the renderer's
    request and need to be fast (5 s short timeout).
  - Trivial to unit-test (no FastAPI needed).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Iterator
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_OLLAMA_URL = "http://localhost:11434"

# Short — the wizard's "is Ollama there?" probe should feel instant.
# A user with a misbehaving inference server gets fast feedback rather
# than a 60 s spinner that resolves to "no".
PROBE_TIMEOUT = 5.0


@dataclass(slots=True)
class OllamaStatus:
    # True if /api/tags responded with a parseable JSON body.
    running: bool
    # True if Ollama appears installed (winget reports it) but isn't
    # currently serving. Only meaningful on Windows; on other platforms
    # `installed` collapses to True when running, False otherwise.
    installed: bool
    # Best-effort version string from /api/version. None if not running.
    version: str | None
    # Models currently pulled, as reported by /api/tags. Empty list when
    # Ollama is running but has no models pulled yet — distinct from
    # None (= didn't reach Ollama).
    models: list[str] | None
    # Human-readable failure string when running=False. None on success.
    error: str | None

    def to_dict(self) -> dict:
        return {
            "running": self.running,
            "installed": self.installed,
            "version": self.version,
            "models": self.models,
            "error": self.error,
        }


def _http_json(url: str, timeout: float = PROBE_TIMEOUT) -> dict | list | None:
    """GET a URL and parse the body as JSON. Returns None on any failure.

    We swallow errors here because callers want the probe result, not
    the exception. The error string is reconstructed by callers from
    context — e.g. "Ollama isn't responding" is more useful than the
    raw `URLError(reason='Connection refused')`.
    """
    try:
        with urlopen(Request(url), timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, OSError):
        return None


def _winget_has_ollama() -> bool:
    """True if `winget list Ollama.Ollama` reports an installation.

    Only useful on Windows. `winget` exits 0 + has the package id in
    stdout when installed; otherwise non-zero or no match. We don't
    parse versions — the goal is to disambiguate the "Ollama is
    installed but not running" message from "Ollama is missing".
    """
    if sys.platform != "win32":
        return False
    winget = shutil.which("winget")
    if not winget:
        return False
    try:
        out = subprocess.run(
            [winget, "list", "--id", "Ollama.Ollama", "--exact"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (subprocess.TimeoutExpired, OSError):
        return False
    return out.returncode == 0 and "Ollama.Ollama" in out.stdout


def ollama_status(base_url: str = DEFAULT_OLLAMA_URL) -> OllamaStatus:
    """Probe Ollama. Synchronous + fast (≤ PROBE_TIMEOUT)."""
    tags = _http_json(f"{base_url.rstrip('/')}/api/tags")
    if tags is None or not isinstance(tags, dict):
        # Not reachable. Disambiguate installed-but-not-running on Win.
        return OllamaStatus(
            running=False,
            installed=_winget_has_ollama(),
            version=None,
            models=None,
            error="Ollama isn't responding on http://localhost:11434. "
                  "Make sure it's installed and the tray icon is running.",
        )
    # version is a separate endpoint; some Ollama versions omit it.
    version_payload = _http_json(f"{base_url.rstrip('/')}/api/version")
    version = (
        version_payload.get("version")
        if isinstance(version_payload, dict) and isinstance(version_payload.get("version"), str)
        else None
    )
    models: list[str] = []
    raw_models = tags.get("models")
    if isinstance(raw_models, list):
        for m in raw_models:
            if isinstance(m, dict) and isinstance(m.get("name"), str):
                models.append(m["name"])
    return OllamaStatus(
        running=True,
        installed=True,
        version=version,
        models=sorted(set(models)),
        error=None,
    )


def ollama_pull_stream(
    model: str, base_url: str = DEFAULT_OLLAMA_URL, timeout: float = 600.0
) -> Iterator[dict]:
    """Stream NDJSON progress events from /api/pull as Python dicts.

    Ollama emits one JSON object per line with shapes like:
      {"status": "pulling manifest"}
      {"status": "downloading", "digest": "sha256:…", "total": N, "completed": M}
      {"status": "success"}

    We yield each one through verbatim. The HTTP-level error path
    (Ollama not running) bubbles up as URLError / HTTPError — callers
    surface it.

    The renderer disconnects to cancel; closing the urlopen response
    causes the upstream HTTP/1.1 connection to drop and Ollama stops
    pulling. Partial blob files stay in ~/.ollama/models/blobs and
    Ollama resumes from there on the next pull.
    """
    payload = json.dumps({"name": model, "stream": True}).encode("utf-8")
    req = Request(
        f"{base_url.rstrip('/')}/api/pull",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urlopen(req, timeout=timeout) as resp:
        for raw_line in resp:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                # Ollama shouldn't emit garbage but if it does, skip
                # rather than aborting the whole pull on one bad line.
                continue
