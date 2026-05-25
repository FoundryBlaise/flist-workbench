"""Multi-query expansion — ask the chat LLM for paraphrased queries.

Why this exists:
  Dense embeddings depend on the input phrasing. A question worded one
  way ("Wer war der Pharao?") may not retrieve the chunk that contains
  the answer if that chunk uses different language ("In Ägypten regiert
  ein Pharao namens ..."). Asking the LLM for 2–5 alternative phrasings
  first lets the retrieval round cover more semantic angles.

Why it fixes the typo case too:
  Local chat models are good at autocorrecting obvious misspellings of
  proper nouns. A query for "Orphelia" will produce variants including
  "Ophelia" — which lands the right chunk under either dense or BM25
  retrieval. The expansion prompt explicitly calls for this so the
  model doesn't preserve the typo across all variants.

Why best-effort:
  Hallucinated variants are harmless (worst case wastes one retrieval
  round). Empty / malformed output is treated as "no variants" so the
  pipeline falls back to single-query retrieval cleanly.
"""

from __future__ import annotations

import json
import re

import labels_llm
import rag as rag_settings

_EXPAND_PROMPT_SYSTEM = (
    "You generate alternative phrasings of a user question so it can be "
    "used for retrieval against roleplay chat logs. Reply ONLY with a "
    "JSON array of strings — no commentary, no markdown fences, no "
    "explanation. Keep each variant in the same language as the input "
    "question.\n\n"
    "Rules for the variants:\n"
    "- If the question contains a likely misspelling of a proper noun "
    "(character name, place, item), include the corrected spelling in "
    "at least one variant. Do NOT include the misspelled form in every "
    "variant — give the corrected version a real chance.\n"
    "- Vary verbs, synonyms, and word order. Aim for distinct phrasings "
    "rather than minor rewrites.\n"
    "- Do not invent new facts or names. Stay close to what the user "
    "asked about.\n"
    "- Output between 2 and 5 variants."
)

_REQUEST_TIMEOUT = 30.0
"""Generous-but-bounded — expansion runs synchronously before the chat
stream starts, so a hung server here delays first-token latency. 30 s
catches a slow cold-start without trapping the user behind a stuck
endpoint forever."""


def expand_query(
    question: str,
    *,
    n: int,
    rag_set: rag_settings.RagSettings,
) -> list[str]:
    """Return up to `n` alternative phrasings of `question`.

    Uses the chat LLM (NOT the labels LLM) on purpose: the chat model is
    what the user has loaded for the answering step, so it already
    matches their language preference and quality bar.

    Returns [] on any failure — the caller falls back to single-query
    retrieval transparently. Never raises.
    """
    n = max(2, min(5, int(n)))
    user_prompt = f'Original question: "{question}"\n\nN={n}'
    try:
        raw = labels_llm.call_llm(
            rag_set.chat_endpoint,
            rag_set.chat_model,
            rag_set.chat_api_key,
            _EXPAND_PROMPT_SYSTEM,
            user_prompt,
            max_tokens=512,
            timeout=_REQUEST_TIMEOUT,
        )
    except Exception:  # noqa: BLE001 — expansion is best-effort
        return []
    variants = _parse_variants(raw)
    # Drop variants that are exactly the original (case-insensitive,
    # whitespace-collapsed) — those add nothing to retrieval and would
    # double-count in RRF.
    seen = {_norm(question)}
    out: list[str] = []
    for v in variants:
        key = _norm(v)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(v.strip())
        if len(out) >= n:
            break
    return out


def _norm(s: str) -> str:
    return " ".join(s.lower().split())


def _parse_variants(raw: str) -> list[str]:
    """Extract a list of strings from the LLM's reply.

    Happy path: the reply is exactly a JSON array. Tolerated:
      - JSON wrapped in ``` fences (model couldn't help itself)
      - JSON with a leading "Variants:" / "Output:" preface
      - bullet list ("- foo\n- bar") as a graceful degradation
    """
    if not raw:
        return []
    text = raw.strip()
    # Strip markdown fences if present.
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n", "", text)
        text = re.sub(r"\n```\s*$", "", text)
    # Find the first '[' and the matching last ']' — handles models that
    # prefix the array with prose like "Sure! Here are the variants:".
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end > start:
        candidate = text[start : end + 1]
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, list):
            return [str(v) for v in parsed if isinstance(v, (str, int, float))]
    # Fallback: parse a markdown / numbered bullet list.
    bullets: list[str] = []
    for line in text.splitlines():
        m = re.match(r"\s*(?:[-*]|\d+[.)])\s+(.+)", line)
        if m:
            bullets.append(m.group(1).strip().strip('"').strip("'"))
    return bullets
