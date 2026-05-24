"""On-demand IC/OOC classifier — calls an OpenAI-compatible LLM.

Adapted from Chat_RAG/classify.py for the Workbench sidecar. The
heavy lifting differences:

  - No more file I/O. Inputs are parsed messages (already in memory)
    + a LabelsSettings; outputs go straight to labels.upsert_label.
  - Cancellation: a threading.Event polled between batches. In-flight
    requests are allowed to finish so their results aren't lost.
  - Progress: a callback fires after each labeled message so the job
    manager can update its progress event for the UI.
  - All endpoint/model/key/prompt come from settings — no hardcoded
    defaults here so the user controls everything via the UI.

Rules-vs-LLM split is deliberately small. The labels.resolve() rules
(empty body, text_len < threshold, "((" prefix) are the source of truth
for the cheap auto-OOC cases; this module never persists rule outcomes.
The LLM only sees messages the rules didn't already classify, matching
the rule-on-read design in docs/RAG_DESIGN.md.
"""

from __future__ import annotations

import json
import re
import threading
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from typing import Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import labels as labels_store
from labels import LabelsSettings, msg_hash

CONTEXT_BEFORE = 3
CONTEXT_AFTER = 3
CONTEXT_TRUNCATE_CHARS = 500
REQUEST_TIMEOUT = 180


def fmt_msg(m: dict, truncate: bool = False) -> str:
    t = datetime.fromtimestamp(m["ts"], tz=timezone.utc).strftime("%m-%d %H:%M")
    text = (m.get("text") or "").replace("\n", " ").strip()
    if truncate and len(text) > CONTEXT_TRUNCATE_CHARS:
        text = text[:CONTEXT_TRUNCATE_CHARS].rstrip() + " [… truncated]"
    n = len(text)
    # F-Chat type byte 1 == /me action. Surface it as an explicit
    # marker so the classifier doesn't have to infer "this is a /me"
    # from the parser-prepended speaker name alone.
    action_marker = " | action" if m.get("type") == 1 else ""
    return f"[{t} | {n} chars{action_marker}] {m['speaker']}: {text}"


def build_user_prompt(messages: list[dict], target_idx: int) -> str:
    lo = max(0, target_idx - CONTEXT_BEFORE)
    hi = min(len(messages), target_idx + CONTEXT_AFTER + 1)
    parts: list[str] = []
    if target_idx > lo:
        parts.append("KONTEXT VORHER (nicht klassifizieren):")
        for i in range(lo, target_idx):
            parts.append(fmt_msg(messages[i], truncate=True))
        parts.append("")
    parts.append(">>> ZIELNACHRICHT <<<")
    parts.append(fmt_msg(messages[target_idx], truncate=False))
    parts.append(">>> ENDE ZIELNACHRICHT <<<")
    if hi > target_idx + 1:
        parts.append("")
        parts.append("KONTEXT NACHHER (nicht klassifizieren):")
        for i in range(target_idx + 1, hi):
            parts.append(fmt_msg(messages[i], truncate=True))
    return "\n".join(parts)


def call_llm(
    endpoint: str,
    model: str,
    api_key: str,
    system_prompt: str,
    user_prompt: str,
    *,
    max_tokens: int = 800,
    timeout: float = REQUEST_TIMEOUT,
) -> str:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = Request(
        f"{endpoint.rstrip('/')}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
    )
    try:
        with urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read())
    except HTTPError as e:
        try:
            err_body = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            err_body = "<unreadable>"
        raise HTTPError(e.url, e.code, f"{e.reason}: {err_body}", e.headers, None) from e
    return body["choices"][0]["message"]["content"]


_FENCE_RE = re.compile(r"^```[a-zA-Z]*\n?|\n?```$")


def parse_label(content: str) -> dict | None:
    """Extract {label, confidence, reason} from the LLM JSON reply."""
    s = content.strip()
    if s.startswith("```"):
        s = _FENCE_RE.sub("", s)
    start = s.find("{")
    end = s.rfind("}")
    if start < 0 or end < 0:
        return None
    try:
        data = json.loads(s[start : end + 1])
    except json.JSONDecodeError:
        return None
    label = str(data.get("label", "")).upper()
    if label not in ("IC", "OOC"):
        return None
    try:
        conf = float(data.get("confidence", 0.5))
    except (TypeError, ValueError):
        conf = 0.5
    conf = max(0.0, min(1.0, conf))
    reason = str(data.get("reason", ""))[:120]
    return {"label": label, "confidence": conf, "reason": reason}


ProgressCb = Callable[[dict], None]


def classify_messages(
    character: str,
    partner: str,
    messages: Iterable[dict],
    settings: LabelsSettings,
    labels_conn,
    *,
    cancel: threading.Event | None = None,
    on_progress: ProgressCb | None = None,
    concurrency: int = 3,
    skip_existing: bool = True,
) -> dict:
    """Classify everything that doesn't already have a DB row or a rule hit.

    Returns a summary dict with counts. Writes labels (source='llm') as
    they come back so the UI sees progress even if cancelled mid-run.
    """
    cancel = cancel or threading.Event()
    msgs = list(messages)
    by_hash = labels_store.labels_for_partner(labels_conn, character, partner)

    # Pre-compute tasks. Rule-only matches don't need the LLM.
    tasks: list[tuple[int, dict, str, str]] = []  # (idx, msg, hash, prompt)
    skipped_existing = 0
    skipped_rule = 0
    for idx, m in enumerate(msgs):
        h = msg_hash(m)
        if skip_existing and h in by_hash:
            skipped_existing += 1
            continue
        # If the rules would catch it (Unlabeled means no rule applied),
        # don't waste an LLM call.
        if labels_store.resolve(m, None, settings) != labels_store.LABEL_UNLABELED:
            skipped_rule += 1
            continue
        tasks.append((idx, m, h, build_user_prompt(msgs, idx)))

    total = len(tasks)
    classified = 0
    failed = 0

    def emit_progress(extra: dict | None = None) -> None:
        if not on_progress:
            return
        payload = {
            "character": character,
            "partner": partner,
            "classified": classified,
            "failed": failed,
            "total": total,
            "skipped_existing": skipped_existing,
            "skipped_rule": skipped_rule,
        }
        if extra:
            payload.update(extra)
        on_progress(payload)

    emit_progress()
    if not tasks:
        return {
            "character": character,
            "partner": partner,
            "classified": 0,
            "failed": 0,
            "total": 0,
            "skipped_existing": skipped_existing,
            "skipped_rule": skipped_rule,
            "cancelled": False,
        }

    def process(task: tuple[int, dict, str, str]) -> tuple[dict | None, str | None]:
        _idx, m, h, prompt = task
        try:
            content = call_llm(
                settings.llm_endpoint,
                settings.llm_model,
                settings.llm_api_key,
                settings.system_prompt,
                prompt,
            )
        except (HTTPError, URLError, TimeoutError) as e:
            return None, f"api error: {e}"
        parsed = parse_label(content)
        if parsed is None:
            return None, f"bad json: {content[:120]!r}"
        return {
            "hash": h,
            "ts": m["ts"],
            "speaker": m["speaker"],
            "label": parsed["label"],
            "confidence": parsed["confidence"],
            "reason": parsed["reason"],
        }, None

    cancelled = False
    if concurrency <= 1:
        for task in tasks:
            if cancel.is_set():
                cancelled = True
                break
            label, err = process(task)
            if label:
                labels_store.upsert_label(
                    labels_conn,
                    hash=label["hash"],
                    character=character,
                    partner=partner,
                    ts=label["ts"],
                    speaker=label["speaker"],
                    label=label["label"],
                    source="llm",
                    confidence=label["confidence"],
                    reason=label["reason"],
                )
                classified += 1
                emit_progress({"last_label": label["label"]})
            else:
                failed += 1
                emit_progress({"last_error": err})
    else:
        # Chunked submission so cancel takes effect within ~one model
        # latency. The previous code submitted every task up front,
        # and ThreadPoolExecutor.__exit__ then waited for all of them
        # — so cancel-lag scaled with `remaining_tasks * latency /
        # concurrency` (measured ~9.5 s on a 5-task probe). With this
        # loop, only `concurrency` futures are in-flight at any time;
        # on cancel we stop submitting new ones and wait at most for
        # the current batch to drain.
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            task_iter = iter(tasks)
            in_flight: dict = {}

            def submit_next() -> bool:
                try:
                    t = next(task_iter)
                except StopIteration:
                    return False
                in_flight[ex.submit(process, t)] = t
                return True

            # Prime the pump up to `concurrency`.
            for _ in range(concurrency):
                if cancel.is_set():
                    cancelled = True
                    break
                if not submit_next():
                    break

            while in_flight:
                # Re-check cancel on a short tick so the user doesn't
                # wait the full model latency just to see "cancelled".
                done, _pending = wait(
                    in_flight.keys(), timeout=0.5, return_when=FIRST_COMPLETED
                )
                if not done:
                    if cancel.is_set():
                        cancelled = True
                    continue
                for fut in done:
                    label, err = fut.result()
                    del in_flight[fut]
                    if label:
                        labels_store.upsert_label(
                            labels_conn,
                            hash=label["hash"],
                            character=character,
                            partner=partner,
                            ts=label["ts"],
                            speaker=label["speaker"],
                            label=label["label"],
                            source="llm",
                            confidence=label["confidence"],
                            reason=label["reason"],
                        )
                        classified += 1
                        emit_progress({"last_label": label["label"]})
                    else:
                        failed += 1
                        emit_progress({"last_error": err})
                    # Backfill only if we're still running. After
                    # cancel we let the remaining in-flight finish but
                    # don't queue more.
                    if cancel.is_set():
                        cancelled = True
                    else:
                        submit_next()

    return {
        "character": character,
        "partner": partner,
        "classified": classified,
        "failed": failed,
        "total": total,
        "skipped_existing": skipped_existing,
        "skipped_rule": skipped_rule,
        "cancelled": cancelled,
    }
