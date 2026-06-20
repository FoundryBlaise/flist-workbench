"""Validation guards for AI-assistant edit proposals.

The assistant proposes structured edits via tool calls; this module
verifies each proposed edit against the live working-copy payload and
the current mapping list before it gets persisted into
`ai-draft.json`. Mismatches return a `ValidationResult` carrying a
machine-readable `reason` code the chat endpoint surfaces back to the
model so it can self-correct.

Guards layered here:
- Field-path allowlist (`generate_allowlist`) — only the surfaces the
  user opted into Phase 9 v1.1 are writable; anything else is rejected
  at the boundary.
- Kink-choice enum — `fave/yes/maybe/no/undecided` matches the renderer
  type guard `isKinkChoice` (see ChoiceButtons.tsx).
- BBCode tag fidelity — lowercase tags are preserved, no markdown leaks
  into description / custom-kink descriptions, `[user]…[/user]` and
  `[icon]…[/icon]` round-trip exactly.
- Anchor matching — `old_value` / `old_excerpt` must match the current
  working content (whitespace-normalised) or the edit is `stale`.
- Mapping-list reverse lookup — labels coming from the model
  ("English", "Anthro") are resolved to canonical `listitem_id`s
  against the cached mapping list.
- Gallery permutation — `reorder_gallery` must supply exactly the
  current set of image_ids in some order; additions / removals go
  through dedicated tools.

The settings allowlist (`ASSISTANT_SETTABLE_SETTINGS`) is the only
keyhole into character-level settings — everything else under
`settings.*` is invisible to the assistant by design.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


# Editable boolean flags under `character.settings.*`. Anything not in
# this set is off-limits to the assistant — keeps the surface tight.
ASSISTANT_SETTABLE_SETTINGS: frozenset[str] = frozenset(
    {
        "customs_first",
        "show_friends",
        "guestbook",
        "prevent_bookmarks",
        "public",
    }
)

# Kink choice values the renderer accepts. Mirrors ChoiceButtons.tsx
# `isKinkChoice`; both sides must agree or accept_edits will fail at
# the working-copy write step.
VALID_KINK_CHOICES: frozenset[str] = frozenset(
    {"fave", "yes", "maybe", "no", "undecided"}
)


@dataclass(frozen=True)
class ValidationResult:
    """Outcome of `validate_edit`. `ok=False` carries a `reason` code
    + `message`; the chat endpoint surfaces both back to the model.
    Successful results return `edit` with any sidecar-side derivations
    filled in (resolved listitem_id, normalised choice value, etc.)."""

    ok: bool
    reason: str = ""
    message: str = ""
    edit: dict[str, Any] | None = None


# ---- allowlist -------------------------------------------------------


def generate_allowlist(mapping_list: dict[str, Any]) -> set[str]:
    """Build the set of legal `field_path` values for the active mapping.

    The allowlist enumerates:
    - `character.description` — the BBCode body
    - `infotags.<id>` — one per mapping-list infotag id
    - `custom_kinks.<id>.{name,description,choice}` — per-row paths
    - `custom_kinks` — collection-level add/remove
    - `kinks.<id>` — one per standard-kink listitem_id in the mapping
    - `images` — collection-level reorder / add / remove
    - `settings.<allowlisted_key>` — only `ASSISTANT_SETTABLE_SETTINGS`

    The infotag and kink id enumerations are sourced from the supplied
    `mapping_list` (the cached f-list response). If the renderer hands
    us a stale mapping the assistant pane refuses anyway via the
    staleness chip, so this is best-effort.
    """
    out: set[str] = {"character.description", "custom_kinks", "images"}

    # Infotag ids — wiki/`fetch_mapping_list` shape: `infotags` is a
    # dict keyed by string ids OR a list of objects with an `id`.
    infotags = mapping_list.get("infotags")
    if isinstance(infotags, dict):
        ids = infotags.keys()
    elif isinstance(infotags, list):
        ids = (str(e.get("id")) for e in infotags if isinstance(e, dict))
    else:
        ids = ()
    for tid in ids:
        if tid:
            out.add(f"infotags.{tid}")

    # Standard-kink listitem ids — `kinks` is a list of objects in the
    # mapping response; each has an integer id.
    kinks = mapping_list.get("kinks")
    if isinstance(kinks, list):
        for entry in kinks:
            if isinstance(entry, dict):
                kid = entry.get("id")
                if kid is not None and kid != "":
                    out.add(f"kinks.{kid}")

    for key in ASSISTANT_SETTABLE_SETTINGS:
        out.add(f"settings.{key}")

    # custom_kinks.<id>.* is wildcarded — we can't know the working
    # copy's custom kink ids from the mapping list alone. `validate_edit`
    # does the per-id lookup against the live working payload.
    return out


def is_path_allowed(path: str, allowlist: set[str]) -> bool:
    """Wildcard-aware allowlist check. Handles the `custom_kinks.<id>.*`
    fan-out without enumerating every existing custom-kink id upfront.
    """
    if path in allowlist:
        return True
    if path.startswith("custom_kinks.") and path.count(".") >= 1:
        # Need at least `custom_kinks.<id>` or `custom_kinks.<id>.<field>`.
        parts = path.split(".")
        if len(parts) == 2:
            return True  # custom_kinks.<id> — remove
        if len(parts) == 3 and parts[2] in {"name", "description", "choice"}:
            return True
    return False


# ---- BBCode tag-fidelity ---------------------------------------------

_BBCODE_TAG_RE = re.compile(r"\[/?(\w+)(?:=[^\]]*)?\]")
_MARKDOWN_LEAK_PATTERNS = (
    re.compile(r"(?m)^#{1,6}\s"),  # # heading
    re.compile(r"(?<!\w)\*\*[^*\n]+\*\*"),  # **bold**
    re.compile(r"(?<!\w)__[^_\n]+__"),  # __bold__
    re.compile(r"(?m)^\s*```"),  # ``` fences
    re.compile(r"(?m)^\s*[-*+]\s+\w"),  # - bullet (markdown)
)


def check_bbcode_fidelity(new_value: str) -> tuple[bool, str]:
    """Reject obvious BBCode→Markdown drift in proposed prose.

    Catches the most common model mistakes: emitting Markdown headings
    (`# Title`), `**bold**`, fenced code, or bullet lists. Also rejects
    uppercased tags (`[B]`) since F-list emits lowercase only and the
    project style note pins that — letting the assistant emit `[B]`
    would create inconsistencies the rest of the editor doesn't make.

    Returns `(ok, message)`. Tag preservation across an edit (the
    `[user]…[/user]` round-trip) is handled in `validate_edit` because
    that needs both old and new strings.
    """
    if not isinstance(new_value, str):
        return False, "new_value must be a string"
    for pat in _MARKDOWN_LEAK_PATTERNS:
        if pat.search(new_value):
            return False, "markdown syntax leaked into BBCode field"
    # Any tag with at least one uppercase letter triggers reject. We
    # match `[Tag]` or `[/Tag]` or `[Tag=arg]`.
    for m in _BBCODE_TAG_RE.finditer(new_value):
        tag = m.group(1)
        if tag != tag.lower():
            return False, f"BBCode tag must be lowercase: [{tag}]"
    return True, ""


def check_anchor(claimed_old: str, current: str) -> bool:
    """Whitespace-normalised equality. The model often quotes the
    current text with collapsed runs of spaces or normalised line
    endings; we accept those as matches but reject substantive drift.
    """
    if not isinstance(claimed_old, str) or not isinstance(current, str):
        return False
    return _norm_ws(claimed_old) == _norm_ws(current)


def _norm_ws(s: str) -> str:
    # Newline + CR runs collapse to single \n; tabs to single space;
    # multiple inline spaces collapse to one. Leading/trailing trimmed.
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n\s*\n", "\n\n", s)
    return s.strip()


# ---- mapping-list reverse lookup -------------------------------------


def reverse_lookup_infotag(
    infotag_id: str | int,
    label_or_id: str | int,
    mapping_list: dict[str, Any],
) -> tuple[str | None, str | None]:
    """Resolve a label (`'English'`) or already-numeric id (`'21'`) to a
    canonical `listitem_id` for the given `infotag_id`.

    Returns `(listitem_id, label)` on success or `(None, error)` on
    failure. Numeric inputs are taken at face value when present in the
    infotag's listitem set. Strings are matched case-insensitively
    against `name`.
    """
    if label_or_id is None:
        return None, "value is null"
    tid = str(infotag_id)
    raw_value = str(label_or_id).strip()
    if not raw_value:
        return None, "value is empty"

    infotags = mapping_list.get("infotags")
    entry: dict[str, Any] | None = None
    if isinstance(infotags, dict):
        candidate = infotags.get(tid)
        if isinstance(candidate, dict):
            entry = candidate
    elif isinstance(infotags, list):
        for it in infotags:
            if isinstance(it, dict) and str(it.get("id")) == tid:
                entry = it
                break

    if entry is None:
        return None, f"unknown infotag id {tid}"

    # Free-text fields (no listitems) — accept the literal value.
    listitems = entry.get("list") or entry.get("listitems")
    if not isinstance(listitems, list) or not listitems:
        return raw_value, raw_value

    # First pass: numeric id match.
    if raw_value.isdigit():
        for li in listitems:
            if isinstance(li, dict) and str(li.get("id")) == raw_value:
                return str(li.get("id")), str(li.get("name", raw_value))

    # Second pass: case-insensitive name match.
    lower = raw_value.lower()
    matches: list[dict[str, Any]] = []
    for li in listitems:
        if not isinstance(li, dict):
            continue
        name = str(li.get("name", "")).strip()
        if name.lower() == lower:
            matches.append(li)
    if len(matches) == 1:
        return str(matches[0].get("id")), str(matches[0].get("name"))
    if len(matches) > 1:
        return None, f"ambiguous label '{raw_value}' for infotag {tid}"
    return None, f"unknown value '{raw_value}' for infotag {tid}"


# ---- top-level validator --------------------------------------------


def validate_edit(
    edit: dict[str, Any],
    working: dict[str, Any],
    allowlist: set[str],
    mapping_list: dict[str, Any],
    *,
    character_id: str | int | None = None,
) -> ValidationResult:
    """Run every guard against a single proposed edit. The returned
    `ValidationResult.edit` is the canonical form (resolved
    listitem_id, normalised anchor, etc.) — callers should persist
    *that*, not the raw input.

    Required keys on the input: `tool`, `field_path`, `kind`,
    `new_value` (or per-kind shape), `rationale`. Optional:
    `old_value`, `old_excerpt`, `new_label_hint`, `composite_id`,
    `gallery_order` (for reorder).
    """
    if not isinstance(edit, dict):
        return ValidationResult(False, "bad_shape", "edit is not a dict")
    tool = edit.get("tool")
    if not isinstance(tool, str) or not tool:
        return ValidationResult(False, "missing_tool", "edit missing tool name")
    field_path = edit.get("field_path")
    if not isinstance(field_path, str) or not field_path:
        return ValidationResult(False, "missing_field_path", "edit missing field_path")
    if not is_path_allowed(field_path, allowlist):
        return ValidationResult(
            False, "field_not_editable", f"field_path '{field_path}' not editable"
        )
    rationale = edit.get("rationale", "")
    if not isinstance(rationale, str):
        return ValidationResult(False, "bad_rationale", "rationale must be a string")
    rationale = rationale.strip()[:300]

    canonical: dict[str, Any] = {
        "tool": tool,
        "field_path": field_path,
        "kind": edit.get("kind"),
        "rationale": rationale,
        "composite_id": edit.get("composite_id"),
    }

    # ---- per-tool guards --------------------------------------------
    if tool == "set_infotag":
        return _validate_set_infotag(edit, canonical, working, mapping_list)
    if tool == "clear_infotag":
        return _validate_clear_infotag(edit, canonical, working)
    if tool == "replace_description":
        return _validate_replace_description(edit, canonical, working)
    if tool == "patch_description":
        return _validate_patch_description(edit, canonical, working)
    if tool == "set_custom_kink":
        return _validate_set_custom_kink(edit, canonical, working)
    if tool == "add_custom_kink":
        return _validate_add_custom_kink(edit, canonical)
    if tool == "remove_custom_kink":
        return _validate_remove_custom_kink(edit, canonical, working)
    if tool == "set_standard_kink":
        return _validate_set_standard_kink(edit, canonical, working)
    if tool == "set_character_setting":
        return _validate_set_character_setting(edit, canonical, working)
    if tool == "add_image_to_gallery":
        # Stash character_id so the on-disk existence check can find
        # the image dir without changing every _validate_* signature.
        edit_with_ctx = dict(edit)
        if character_id is not None:
            edit_with_ctx["_character_id"] = character_id
        return _validate_add_image(edit_with_ctx, canonical, working)
    if tool == "remove_image_from_gallery":
        return _validate_remove_image(edit, canonical, working)
    if tool == "reorder_gallery":
        return _validate_reorder_gallery(edit, canonical, working)
    return ValidationResult(
        False, "unknown_tool", f"tool '{tool}' not recognised"
    )


def _validate_set_infotag(
    edit: dict[str, Any],
    canonical: dict[str, Any],
    working: dict[str, Any],
    mapping_list: dict[str, Any],
) -> ValidationResult:
    field_path = canonical["field_path"]
    infotag_id = field_path.removeprefix("infotags.")
    new_in = edit.get("new_value")
    listitem_id, label_or_err = reverse_lookup_infotag(
        infotag_id, new_in, mapping_list
    )
    if listitem_id is None:
        return ValidationResult(False, "unknown_value", label_or_err or "lookup failed")
    # Free-text infotags (Height, Build, etc.) bypass the listitem
    # reverse lookup — the model returns the raw value verbatim. Run
    # the BBCode-fidelity guard on those so markdown leak / uppercase
    # tags don't sneak past. List-typed infotags resolve to ids and
    # don't need the check.
    if _is_free_text_infotag(infotag_id, mapping_list):
        ok, msg = check_bbcode_fidelity(listitem_id)
        if not ok:
            return ValidationResult(False, "bbcode_fidelity", msg)
    current = _read_path(working, field_path)
    canonical.update(
        kind="value_replace",
        old_value=None if current is None else str(current),
        new_value=listitem_id,
        new_label_hint=label_or_err,
    )
    return ValidationResult(True, edit=canonical)


def _is_free_text_infotag(
    infotag_id: str | int, mapping_list: dict[str, Any]
) -> bool:
    """True when the infotag has no `listitems` (i.e. accepts arbitrary
    string content rather than a fixed enum). Free-text means the model
    can author BBCode here, which needs the fidelity guard."""
    tid = str(infotag_id)
    infotags = mapping_list.get("infotags")
    entry: dict[str, Any] | None = None
    if isinstance(infotags, dict):
        candidate = infotags.get(tid)
        if isinstance(candidate, dict):
            entry = candidate
    elif isinstance(infotags, list):
        for it in infotags:
            if isinstance(it, dict) and str(it.get("id")) == tid:
                entry = it
                break
    if entry is None:
        return False
    listitems = entry.get("list") or entry.get("listitems")
    return not isinstance(listitems, list) or len(listitems) == 0


def _validate_clear_infotag(
    edit: dict[str, Any], canonical: dict[str, Any], working: dict[str, Any]
) -> ValidationResult:
    current = _read_path(working, canonical["field_path"])
    canonical.update(
        kind="value_clear",
        old_value=None if current is None else str(current),
        new_value=None,
    )
    return ValidationResult(True, edit=canonical)


def _validate_replace_description(
    edit: dict[str, Any], canonical: dict[str, Any], working: dict[str, Any]
) -> ValidationResult:
    new_value = edit.get("new_value")
    if not isinstance(new_value, str):
        return ValidationResult(False, "bad_value", "new_value must be a string")
    ok, msg = check_bbcode_fidelity(new_value)
    if not ok:
        return ValidationResult(False, "bbcode_fidelity", msg)
    current = _read_path(working, canonical["field_path"]) or ""
    canonical.update(
        kind="text_replace",
        old_value=str(current),
        new_value=new_value,
    )
    return ValidationResult(True, edit=canonical)


def _validate_patch_description(
    edit: dict[str, Any], canonical: dict[str, Any], working: dict[str, Any]
) -> ValidationResult:
    old_excerpt = edit.get("old_excerpt")
    new_value = edit.get("new_value")
    if not isinstance(old_excerpt, str) or not isinstance(new_value, str):
        return ValidationResult(
            False, "bad_value", "old_excerpt and new_value must be strings"
        )
    ok, msg = check_bbcode_fidelity(new_value)
    if not ok:
        return ValidationResult(False, "bbcode_fidelity", msg)
    # Read the current text at the explicit target_path; if absent,
    # search across every BBCode-bearing field to find where the
    # model's quote actually lives and use that field path. This
    # rescues the common failure where the model quotes text from a
    # custom_kink description but calls patch_description (which used
    # to be hard-coded to character.description).
    target_path = canonical["field_path"]
    current = _read_path(working, target_path) or ""
    if not isinstance(current, str) or _locate_anchor(old_excerpt, current) is None:
        autofound = _find_text_field_containing(old_excerpt, working)
        if autofound is not None:
            target_path = autofound
            canonical["field_path"] = autofound
            current = _read_path(working, autofound) or ""
    if not isinstance(current, str):
        return ValidationResult(False, "no_anchor", "field is not a string")
    # Anchor escalation:
    # 1. Raw literal match — cheapest, exact, the common case.
    # 2. Whitespace-normalised match — handles the typical local-model
    #    failures (multiple spaces collapsed, CR vs LF, leading/trailing
    #    whitespace differences).
    # In both cases we resolve to precise (start, end) raw indices so
    # the apply path can splice exactly that range. Earlier versions
    # fell back to whole-body replace on a normalised match, which
    # silently clobbered any prior text_patch edits in the same draft.
    # That fallback is gone; only literal+normalised matching, both
    # surfaced as concrete bounds.
    bounds = _locate_anchor(old_excerpt, current)
    if bounds is None:
        # Give the model a hint about what's actually near where it
        # was looking so it can re-quote. Without this, the model
        # just retries variants of the same wrong quote until the
        # tool-round cap fires.
        suggestion = _nearest_substring_hint(old_excerpt, current)
        msg = (
            "old_excerpt not found in current description "
            "(even after whitespace normalisation)."
        )
        if suggestion:
            msg += (
                f" Closest stretch of the description by overlap: "
                f"…{suggestion}…  Re-quote from the actual description "
                f"or use replace_description for whole-paragraph rewrites."
            )
        return ValidationResult(False, "anchor_mismatch", msg)
    anchor_start, anchor_end = bounds
    canonical.update(
        kind="text_patch",
        old_excerpt=old_excerpt,
        new_value=new_value,
        anchor_start=anchor_start,
        anchor_end=anchor_end,
    )
    return ValidationResult(True, edit=canonical)


def _find_text_field_containing(
    needle: str, working: dict[str, Any]
) -> str | None:
    """Walk every BBCode-bearing text field in the working copy and
    return the first dotted path whose content contains `needle`
    (literal or whitespace-normalised). Order: main description,
    then each custom-kink description.

    Used by `patch_description` as a fallback when the model quotes
    text that lives in a custom kink description rather than the
    main field — without this, every patch silently fails validation
    with `anchor_mismatch` and no card ever lands in the review pane.
    """
    if not isinstance(needle, str) or not needle:
        return None

    description = _read_path(working, "character.description")
    if isinstance(description, str) and _locate_anchor(needle, description) is not None:
        return "character.description"

    custom_kinks = working.get("custom_kinks")
    if isinstance(custom_kinks, dict):
        for ck_id, row in custom_kinks.items():
            if not isinstance(row, dict):
                continue
            ck_desc = row.get("description")
            if isinstance(ck_desc, str) and _locate_anchor(needle, ck_desc) is not None:
                return f"custom_kinks.{ck_id}.description"
    return None


def _nearest_substring_hint(needle: str, haystack: str, *, window: int = 80) -> str:
    """Pick the longest contiguous substring of `needle` (≥ 8 chars)
    that DOES appear in `haystack`, then return a window around its
    location. Used to coach the model when its `patch_description`
    quote mismatches the live text — without a hint the model just
    retries variants of the same wrong quote.

    Returns "" when no meaningful overlap exists (rare for any
    real grammar-fix attempt; common for a wholly invented quote).
    """
    if not needle or not haystack:
        return ""
    best_len = 0
    best_in_haystack = -1
    # Sliding-substring scan from longest → shortest. Most local-model
    # mistakes are off-by-a-few-chars, so we usually find a hit on the
    # first or second pass. Cap the scan at the smallest of (needle
    # len, 120) so very long needles don't explode the cost.
    max_try = min(len(needle), 120)
    for L in range(max_try, 7, -1):
        for i in range(0, len(needle) - L + 1):
            sub = needle[i : i + L]
            pos = haystack.find(sub)
            if pos != -1:
                best_len = L
                best_in_haystack = pos
                break
        if best_len > 0:
            break
    if best_in_haystack < 0:
        return ""
    start = max(0, best_in_haystack - window // 2)
    end = min(len(haystack), best_in_haystack + best_len + window // 2)
    snippet = haystack[start:end]
    # Truncate runaway whitespace in the snippet so the hint stays
    # readable; preserve everything else verbatim.
    snippet = re.sub(r"\s+", " ", snippet).strip()
    if len(snippet) > 200:
        snippet = snippet[:200] + "…"
    return snippet


def _locate_anchor(needle: str, haystack: str) -> tuple[int, int] | None:
    """Return `(start, end)` raw indices in `haystack` that splicing
    over with the new value reproduces the intent of replacing
    `needle`. Two escalating strategies:

    1. Literal substring: `needle in haystack` → exact `find` bounds.
    2. Whitespace-normalised: collapse runs of `\\s+` to single space
       in both sides, find the normalised needle in the normalised
       haystack, then map the start/end back to raw indices via a
       per-char raw-index list.

    Returns None when neither finds a match. NFC normalisation is NOT
    applied here — German `ü` is the only common case and is almost
    always stored composed; if a real decomposed case bites we can
    add NFC as a third escalation step.
    """
    if not isinstance(needle, str) or not needle:
        return None
    if needle in haystack:
        start = haystack.find(needle)
        return start, start + len(needle)

    # Whitespace-normalised pass. Build a parallel list of raw indices
    # for every char of the normalised haystack so we can splice
    # precisely. Collapse runs of `\s+` to a single space, drop leading
    # / trailing whitespace.
    normalised_chars: list[str] = []
    raw_index: list[int] = []
    pending_ws = False
    for i, ch in enumerate(haystack):
        if ch.isspace():
            pending_ws = True
            continue
        if pending_ws and normalised_chars:
            normalised_chars.append(" ")
            raw_index.append(i)
        normalised_chars.append(ch)
        raw_index.append(i)
        pending_ws = False
    norm_haystack = "".join(normalised_chars)

    norm_needle = " ".join(needle.split())
    if not norm_needle or norm_needle not in norm_haystack:
        return None

    n_start = norm_haystack.find(norm_needle)
    n_end = n_start + len(norm_needle) - 1
    if n_start >= len(raw_index) or n_end >= len(raw_index):
        return None
    raw_start = raw_index[n_start]
    raw_end = raw_index[n_end] + 1  # exclusive end
    if raw_start >= raw_end or raw_end > len(haystack):
        return None
    return raw_start, raw_end


def _validate_set_custom_kink(
    edit: dict[str, Any], canonical: dict[str, Any], working: dict[str, Any]
) -> ValidationResult:
    field_path = canonical["field_path"]
    # Path shape: custom_kinks.<id>.{name|description|choice}
    parts = field_path.split(".")
    if len(parts) != 3:
        return ValidationResult(False, "bad_path", "expected custom_kinks.<id>.<field>")
    _, ck_id, attr = parts
    custom_kinks = working.get("custom_kinks") or {}
    if not isinstance(custom_kinks, dict) or ck_id not in custom_kinks:
        return ValidationResult(
            False, "unknown_custom_kink", f"custom_kinks.{ck_id} does not exist"
        )
    current_row = custom_kinks[ck_id] if isinstance(custom_kinks[ck_id], dict) else {}
    new_value = edit.get("new_value")
    if attr == "choice":
        if new_value not in VALID_KINK_CHOICES:
            return ValidationResult(
                False, "bad_choice", f"choice must be one of {sorted(VALID_KINK_CHOICES)}"
            )
    elif attr == "description":
        if not isinstance(new_value, str):
            return ValidationResult(False, "bad_value", "description must be a string")
        ok, msg = check_bbcode_fidelity(new_value)
        if not ok:
            return ValidationResult(False, "bbcode_fidelity", msg)
    elif attr == "name":
        if not isinstance(new_value, str) or not new_value.strip():
            return ValidationResult(False, "bad_value", "name must be a non-empty string")
    else:
        return ValidationResult(False, "bad_path", f"unknown custom-kink field '{attr}'")
    current = current_row.get(attr)
    canonical.update(
        kind="value_replace" if attr == "choice" else "text_replace",
        old_value=current if isinstance(current, str) else None,
        new_value=new_value,
    )
    return ValidationResult(True, edit=canonical)


def _validate_add_custom_kink(
    edit: dict[str, Any], canonical: dict[str, Any]
) -> ValidationResult:
    new_value = edit.get("new_value")
    if not isinstance(new_value, dict):
        return ValidationResult(False, "bad_value", "new_value must be a kink object")
    name = new_value.get("name")
    description = new_value.get("description", "")
    choice = new_value.get("choice", "undecided")
    if not isinstance(name, str) or not name.strip():
        return ValidationResult(False, "bad_value", "kink name required")
    if not isinstance(description, str):
        return ValidationResult(False, "bad_value", "description must be a string")
    if description:
        ok, msg = check_bbcode_fidelity(description)
        if not ok:
            return ValidationResult(False, "bbcode_fidelity", msg)
    if choice not in VALID_KINK_CHOICES:
        return ValidationResult(
            False, "bad_choice", f"choice must be one of {sorted(VALID_KINK_CHOICES)}"
        )
    canonical.update(
        kind="custom_kink_add",
        old_value=None,
        new_value={"name": name, "description": description, "choice": choice},
    )
    return ValidationResult(True, edit=canonical)


def _validate_remove_custom_kink(
    edit: dict[str, Any], canonical: dict[str, Any], working: dict[str, Any]
) -> ValidationResult:
    field_path = canonical["field_path"]
    parts = field_path.split(".")
    if len(parts) != 2:
        return ValidationResult(False, "bad_path", "expected custom_kinks.<id>")
    _, ck_id = parts
    custom_kinks = working.get("custom_kinks") or {}
    if not isinstance(custom_kinks, dict) or ck_id not in custom_kinks:
        return ValidationResult(
            False, "unknown_custom_kink", f"custom_kinks.{ck_id} does not exist"
        )
    current_row = custom_kinks[ck_id] if isinstance(custom_kinks[ck_id], dict) else {}
    canonical.update(
        kind="custom_kink_remove",
        old_value=dict(current_row),
        new_value=None,
    )
    return ValidationResult(True, edit=canonical)


def _validate_set_standard_kink(
    edit: dict[str, Any], canonical: dict[str, Any], working: dict[str, Any]
) -> ValidationResult:
    field_path = canonical["field_path"]
    kink_id = field_path.removeprefix("kinks.")
    new_value = edit.get("new_value")
    if new_value not in VALID_KINK_CHOICES:
        return ValidationResult(
            False, "bad_choice", f"choice must be one of {sorted(VALID_KINK_CHOICES)}"
        )
    kinks = working.get("kinks") or {}
    if isinstance(kinks, dict):
        current = kinks.get(kink_id)
    else:
        current = None
    canonical.update(
        kind="value_replace",
        old_value=current,
        new_value=new_value,
    )
    return ValidationResult(True, edit=canonical)


def _validate_set_character_setting(
    edit: dict[str, Any], canonical: dict[str, Any], working: dict[str, Any]
) -> ValidationResult:
    field_path = canonical["field_path"]
    key = field_path.removeprefix("settings.")
    if key not in ASSISTANT_SETTABLE_SETTINGS:
        return ValidationResult(
            False, "field_not_editable", f"setting '{key}' is not assistant-editable"
        )
    new_value = edit.get("new_value")
    if not isinstance(new_value, bool):
        return ValidationResult(False, "bad_value", "setting value must be a boolean")
    settings = working.get("settings") or {}
    current = settings.get(key) if isinstance(settings, dict) else None
    canonical.update(
        kind="value_replace",
        old_value=current,
        new_value=new_value,
    )
    return ValidationResult(True, edit=canonical)


def _validate_add_image(
    edit: dict[str, Any], canonical: dict[str, Any], working: dict[str, Any]
) -> ValidationResult:
    image_id = edit.get("new_value")
    if not isinstance(image_id, str) or not image_id:
        return ValidationResult(False, "bad_value", "image_id required")
    gallery = working.get("images")
    if isinstance(gallery, list):
        for entry in gallery:
            if isinstance(entry, dict) and str(entry.get("image_id")) == image_id:
                return ValidationResult(
                    False, "already_in_gallery", f"image {image_id} already in gallery"
                )
    # Verify the bytes exist in the per-character image store. Without
    # this, an invented image_id is accepted, written, and the
    # renderer shows a broken thumbnail until the user manually
    # cleans up. The caller (assistant_chat / endpoint) supplies the
    # character_id via the canonical edit's owning character; we
    # resolve via character_archive's image directory.
    character_id = edit.get("_character_id")
    if character_id is not None and not _image_id_present(character_id, image_id):
        return ValidationResult(
            False,
            "unknown_image",
            f"image_id {image_id} not found in the local image store",
        )
    canonical.update(
        kind="image_add",
        old_value=None,
        new_value=image_id,
    )
    return ValidationResult(True, edit=canonical)


def _image_id_present(character_id: str | int, image_id: str) -> bool:
    """Cheap on-disk existence check. We don't know the extension up
    front (F-list serves jpg/png/gif), so glob for any file whose stem
    matches the id. Lazy-imported to keep this module's import graph
    test-friendly when character_archive isn't on sys.path."""
    try:
        import character_archive

        d = character_archive.images_dir(character_id)
    except Exception:  # noqa: BLE001 — best-effort, never explode validation
        return True
    if not d.exists():
        return False
    for entry in d.iterdir():
        if entry.is_file() and entry.stem == str(image_id):
            return True
    return False


def _validate_remove_image(
    edit: dict[str, Any], canonical: dict[str, Any], working: dict[str, Any]
) -> ValidationResult:
    image_id = edit.get("old_value") or edit.get("new_value")
    if not isinstance(image_id, str) or not image_id:
        return ValidationResult(False, "bad_value", "image_id required")
    gallery = working.get("images")
    found = False
    if isinstance(gallery, list):
        for entry in gallery:
            if isinstance(entry, dict) and str(entry.get("image_id")) == image_id:
                found = True
                break
    if not found:
        return ValidationResult(
            False, "not_in_gallery", f"image {image_id} not in gallery"
        )
    canonical.update(
        kind="image_remove",
        old_value=image_id,
        new_value=None,
    )
    return ValidationResult(True, edit=canonical)


def _validate_reorder_gallery(
    edit: dict[str, Any], canonical: dict[str, Any], working: dict[str, Any]
) -> ValidationResult:
    new_order = edit.get("new_value")
    if not isinstance(new_order, list) or not all(isinstance(x, str) for x in new_order):
        return ValidationResult(
            False, "bad_value", "new_value must be a list of image_id strings"
        )
    gallery = working.get("images") or []
    if not isinstance(gallery, list):
        return ValidationResult(False, "no_gallery", "no gallery present in working copy")
    current_ids = [
        str(e.get("image_id"))
        for e in gallery
        if isinstance(e, dict) and e.get("image_id") is not None
    ]
    if sorted(current_ids) != sorted(new_order):
        return ValidationResult(
            False,
            "not_a_permutation",
            "reorder_gallery must be an exact permutation of current image_ids",
        )
    canonical.update(
        kind="gallery_reorder",
        old_value=current_ids,
        new_value=new_order,
    )
    return ValidationResult(True, edit=canonical)


# ---- path helpers ----------------------------------------------------


def _read_path(payload: dict[str, Any], path: str) -> Any:
    """Tiny dotted-path reader. Returns None for any missing segment;
    matches the renderer `pathLookup` semantics. Does not handle list
    indices because no allowlisted path traverses one — gallery edits
    target the collection root.
    """
    cur: Any = payload
    for seg in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(seg)
    return cur
