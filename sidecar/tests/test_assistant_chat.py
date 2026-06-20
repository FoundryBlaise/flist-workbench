"""Tests for the assistant chat orchestrator.

The LLM transport is stubbed with a list of canned responses so the
tool-loop semantics can be exercised without a live model. Each test
appends one canned response per round it expects; the stub raises if
the chat layer overshoots.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest


MAPPING_LIST: dict[str, Any] = {
    "infotags": {
        "49": {
            "id": 49,
            "name": "Language",
            "list": [{"id": 21, "name": "English"}, {"id": 22, "name": "German"}],
        }
    },
    "kinks": [{"id": 100, "name": "k100"}],
}


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    import importlib
    import sys

    for mod in (
        "paths",
        "character_archive",
        "ai_draft",
        "ai_draft_validate",
        "ai_tools_atomic",
        "ai_tools_read",
        "ai_tools_composite",
        "assistant_chat",
        "settings",
    ):
        if mod in sys.modules:
            importlib.reload(sys.modules[mod])
    return tmp_path / "wb"


def _seed(character_id: str, name: str = "Test") -> None:
    import character_archive

    character_archive.register_character(character_id, name)
    working = {
        "_schema_version": character_archive.WORKING_SCHEMA_VERSION,
        "_overlay": [],
        "character": {"id": int(character_id), "name": name, "description": "desc"},
        "infotags": {"49": "21"},
        "settings": {"public": True},
        "kinks": {"100": "yes"},
        "custom_kinks": {},
        "_custom_kinks_order": [],
        "images": [],
    }
    character_archive.write_working(character_id, working)


def _stub_config():
    import assistant_chat

    return assistant_chat.AssistantConfig(
        endpoint="http://stub",
        model="stub-model",
        api_key="",
        system_prompt="test prompt",
        temperature=0.0,
        timeout_sec=5.0,
        token_budget=4096,
    )


def _stub_llm(monkeypatch: pytest.MonkeyPatch, responses: list[dict[str, Any]]) -> None:
    """Replace `assistant_chat.call_llm_round` with a deterministic
    canned-response queue."""
    import assistant_chat

    queue = list(responses)

    def fake_call(config, messages, *, tools):
        if not queue:
            raise AssertionError("chat layer made more LLM calls than expected")
        return queue.pop(0)

    monkeypatch.setattr(assistant_chat, "call_llm_round", fake_call)


def test_immediate_text_response_no_tools(env, monkeypatch):
    import assistant_chat

    _seed("42")
    _stub_llm(monkeypatch, [{"role": "assistant", "content": "hi there"}])
    events = list(
        assistant_chat.run_chat_turn(
            _stub_config(),
            [{"role": "user", "content": "hello"}],
            active_character_id="42",
            mapping_list=MAPPING_LIST,
        )
    )
    types = [e["event"] for e in events]
    assert types == ["start", "text", "done"]
    assert events[1]["data"]["content"] == "hi there"


def test_single_atomic_tool_call_persists_edit(env, monkeypatch):
    import assistant_chat
    import ai_draft

    _seed("42")
    _stub_llm(
        monkeypatch,
        [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "set_infotag",
                            "arguments": json.dumps(
                                {
                                    "infotag_id": "49",
                                    "value": "German",
                                    "rationale": "user asked",
                                }
                            ),
                        },
                    }
                ],
            },
            {
                "role": "assistant",
                "content": "Done — language set to German.",
            },
        ],
    )
    events = list(
        assistant_chat.run_chat_turn(
            _stub_config(),
            [{"role": "user", "content": "set language to German"}],
            active_character_id="42",
            mapping_list=MAPPING_LIST,
        )
    )
    types = [e["event"] for e in events]
    assert "tool_call" in types
    assert "tool_result" in types
    assert "draft_update" in types
    assert "text" in types
    assert "done" in types

    # Persisted to ai-draft.json
    draft = ai_draft.read_draft("42")
    assert draft is not None
    assert draft["edits"][0]["new_value"] == "22"


def test_composite_tool_call_emits_one_draft_update(env, monkeypatch):
    import assistant_chat
    import ai_draft

    _seed("42", "Alpha")
    _seed("43", "Bravo")
    # Give Bravo a different kink so the diff is non-empty.
    import character_archive

    other = character_archive.read_working("43")
    other["kinks"] = {"100": "fave"}
    character_archive.write_working("43", other)

    _stub_llm(
        monkeypatch,
        [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "copy_standard_kinks_from",
                            "arguments": json.dumps(
                                {
                                    "other_character_id": "43",
                                    "scope": "all",
                                    "rationale": "mirror",
                                }
                            ),
                        },
                    }
                ],
            },
            {"role": "assistant", "content": "Copied."},
        ],
    )
    events = list(
        assistant_chat.run_chat_turn(
            _stub_config(),
            [{"role": "user", "content": "match B"}],
            active_character_id="42",
            mapping_list=MAPPING_LIST,
        )
    )
    draft_updates = [e for e in events if e["event"] == "draft_update"]
    assert len(draft_updates) == 1
    edits = draft_updates[0]["data"]["draft"]["edits"]
    assert len(edits) == 1
    assert edits[0]["composite_id"] is not None


def test_read_tool_call_does_not_create_draft(env, monkeypatch):
    import assistant_chat
    import ai_draft

    _seed("42")
    _stub_llm(
        monkeypatch,
        [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "get_active_character",
                            "arguments": "{}",
                        },
                    }
                ],
            },
            {"role": "assistant", "content": "I see."},
        ],
    )
    events = list(
        assistant_chat.run_chat_turn(
            _stub_config(),
            [{"role": "user", "content": "what's there?"}],
            active_character_id="42",
            mapping_list=MAPPING_LIST,
        )
    )
    draft_updates = [e for e in events if e["event"] == "draft_update"]
    assert draft_updates == []
    assert ai_draft.read_draft("42") is None


def test_tool_loop_cap_emits_error(env, monkeypatch):
    import assistant_chat

    _seed("42")
    # Every round returns a tool call → cap reached.
    tool_call_round = {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": "call-loop",
                "type": "function",
                "function": {
                    "name": "get_active_character",
                    "arguments": "{}",
                },
            }
        ],
    }
    _stub_llm(monkeypatch, [tool_call_round] * assistant_chat.MAX_TOOL_ROUNDS)
    events = list(
        assistant_chat.run_chat_turn(
            _stub_config(),
            [{"role": "user", "content": "loop"}],
            active_character_id="42",
            mapping_list=MAPPING_LIST,
        )
    )
    errors = [e for e in events if e["event"] == "error"]
    assert len(errors) == 1
    assert errors[0]["data"]["code"] == "tool_loop_cap"


def test_transport_error_surfaces_to_error_event(env, monkeypatch):
    import assistant_chat

    _seed("42")

    def boom(*args, **kwargs):
        raise assistant_chat.ChatTransportError("no endpoint configured")

    monkeypatch.setattr(assistant_chat, "call_llm_round", boom)
    events = list(
        assistant_chat.run_chat_turn(
            _stub_config(),
            [{"role": "user", "content": "go"}],
            active_character_id="42",
            mapping_list=MAPPING_LIST,
        )
    )
    errors = [e for e in events if e["event"] == "error"]
    assert errors and errors[0]["data"]["code"] == "transport"


def test_resolve_assistant_config_prefers_explicit_endpoint(env, monkeypatch):
    import assistant_chat
    import settings as settings_store

    conn = settings_store.connect()
    try:
        settings_store.set_value(
            conn, settings_store.KEY_AI_ASSISTANT_ENDPOINT, "http://explicit"
        )
        settings_store.set_value(
            conn, settings_store.KEY_RAG_CHAT_ENDPOINT, "http://rag"
        )
    finally:
        conn.close()

    conn = settings_store.connect()
    try:
        config = assistant_chat.resolve_assistant_config(conn)
    finally:
        conn.close()
    assert config.endpoint == "http://explicit"


def test_resolve_assistant_config_falls_back_to_rag(env, monkeypatch):
    import assistant_chat
    import settings as settings_store

    conn = settings_store.connect()
    try:
        settings_store.set_value(
            conn, settings_store.KEY_RAG_CHAT_ENDPOINT, "http://rag-fallback"
        )
        settings_store.set_value(
            conn, settings_store.KEY_RAG_CHAT_MODEL, "rag-model"
        )
    finally:
        conn.close()

    conn = settings_store.connect()
    try:
        config = assistant_chat.resolve_assistant_config(conn)
    finally:
        conn.close()
    assert config.endpoint == "http://rag-fallback"
    assert config.model == "rag-model"


def test_resolve_assistant_config_falls_back_to_default_when_no_prompt_saved(env):
    """No saved prompt → first preset (NSFW-EN) wins as the live
    system prompt. Matches labels' "first preset is the default"
    convention."""
    import assistant_chat

    import settings as settings_store

    conn = settings_store.connect()
    try:
        config = assistant_chat.resolve_assistant_config(conn)
    finally:
        conn.close()
    assert config.system_prompt == assistant_chat.DEFAULT_PROMPT_NSFW


def test_resolve_assistant_config_uses_saved_prompt_verbatim(env):
    """Any non-empty saved system_prompt is the live one. Preset
    picker in the UI is purely a "copy this body into the textarea"
    affordance — same model as labels / RAG. There's no mode switch
    that could silently override the user's text."""
    import assistant_chat
    import settings as settings_store

    conn = settings_store.connect()
    try:
        settings_store.set_value(
            conn,
            settings_store.KEY_AI_ASSISTANT_SYSTEM_PROMPT,
            "my custom thing",
        )
    finally:
        conn.close()
    conn = settings_store.connect()
    try:
        config = assistant_chat.resolve_assistant_config(conn)
    finally:
        conn.close()
    assert config.system_prompt == "my custom thing"


def test_build_initial_messages_appends_no_think_to_system_and_user(env):
    """Qwen 3.x's chat template respects `/no_think` only when it's in
    the most recent USER message; we append it to the system prompt
    too as belt-and-suspenders for templates that look there instead.
    Other model families treat the token as literal text."""
    import assistant_chat

    history = [
        {"role": "user", "content": "first turn"},
        {"role": "assistant", "content": "OK"},
        {"role": "user", "content": "second turn"},
    ]

    plain = assistant_chat.build_initial_messages("BE TERSE.", history)
    assert plain[0]["content"] == "BE TERSE."
    assert plain[-1]["content"] == "second turn"

    augmented = assistant_chat.build_initial_messages(
        "BE TERSE.", history, append_no_think=True
    )
    # System prompt carries it.
    assert augmented[0]["content"].endswith("/no_think")
    assert augmented[0]["content"].startswith("BE TERSE.")
    # Last user message carries it; earlier user turns left untouched
    # so we don't inflate the multi-turn prompt with N copies.
    user_msgs = [m for m in augmented if m.get("role") == "user"]
    assert user_msgs[0]["content"] == "first turn"
    assert user_msgs[-1]["content"].endswith("/no_think")
    assert user_msgs[-1]["content"].startswith("second turn")


def test_build_initial_messages_no_think_idempotent_on_user(env):
    """If the renderer (or a previous turn) already stuck /no_think on
    the user message we don't double-append."""
    import assistant_chat

    history = [{"role": "user", "content": "first turn\n\n/no_think"}]
    augmented = assistant_chat.build_initial_messages(
        "BE TERSE.", history, append_no_think=True
    )
    user_content = next(m for m in augmented if m["role"] == "user")["content"]
    assert user_content.count("/no_think") == 1


def test_resolve_config_append_no_think_defaults_on(env):
    """Default ON because most local-model setups produce empty replies
    when the model spends its budget on reasoning. Users who want the
    thinking trace visible explicitly opt out."""
    import assistant_chat
    import settings as settings_store

    conn = settings_store.connect()
    try:
        config = assistant_chat.resolve_assistant_config(conn)
    finally:
        conn.close()
    assert config.append_no_think is True


def test_resolve_config_append_no_think_can_be_disabled(env):
    """An explicit 'false' overrides the default — survives the
    settings → config round-trip cleanly."""
    import assistant_chat
    import settings as settings_store

    conn = settings_store.connect()
    try:
        settings_store.set_value(
            conn,
            settings_store.KEY_AI_ASSISTANT_APPEND_NO_THINK,
            "false",
        )
    finally:
        conn.close()
    conn = settings_store.connect()
    try:
        config = assistant_chat.resolve_assistant_config(conn)
    finally:
        conn.close()
    assert config.append_no_think is False


def test_assistant_prompt_presets_carry_all_four_languages(env):
    """The picker dropdown must contain NSFW + SFW for both English
    and German so the UI can offer the language toggle the user asked
    for (2026-06-20)."""
    import assistant_chat

    ids = {p.id for p in assistant_chat.PROMPT_PRESETS}
    assert ids == {"nsfw-en", "nsfw-de", "sfw-en", "sfw-de"}
    languages = {p.language for p in assistant_chat.PROMPT_PRESETS}
    assert languages == {"English", "German"}


def test_all_tool_schemas_includes_every_kind(env):
    import assistant_chat

    tools = assistant_chat.all_tool_schemas()
    names = {t["function"]["name"] for t in tools}
    # Atomic
    assert "set_infotag" in names
    assert "set_standard_kink" in names
    # Read
    assert "get_active_character" in names
    assert "get_other_character" in names
    # Composite
    assert "copy_standard_kinks_from" in names
    assert "bulk_set_standard_kinks" in names
    # Removed surface
    assert "delete_image_bytes" not in names


def test_parse_tool_arguments_handles_dict_and_string():
    import assistant_chat

    assert assistant_chat._parse_tool_arguments(
        {"function": {"arguments": {"key": "value"}}}
    ) == {"key": "value"}
    assert assistant_chat._parse_tool_arguments(
        {"function": {"arguments": '{"key": "value"}'}}
    ) == {"key": "value"}
    assert assistant_chat._parse_tool_arguments(
        {"function": {"arguments": ""}}
    ) == {}


def test_sse_format_emits_event_and_data_lines():
    import assistant_chat

    payload = assistant_chat.sse_format(
        {"event": "text", "data": {"content": "hi"}}
    )
    text = payload.decode("utf-8")
    assert text.startswith("event: text\n")
    assert "\ndata: {\"content\": \"hi\"}\n\n" in text
