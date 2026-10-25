"""Every F-Chat record type, written by the shared Log writer and read
back through the real parser and the surfaces built on it.

The names here are the user's own characters and invented ones; the
text is made up for the test.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import parser
from fchat_logs import action, ad, chat, event, roll, utc, warn, write_log


def test_every_record_type_round_trips_through_the_parser(tmp_path: Path) -> None:
    path = write_log(
        tmp_path / "Azure Viper" / "logs" / "Antiquill",
        [
            chat("Azure Viper", "Evening, stranger.", at=1700000000),
            action("Antiquill", "tips his hat.", at=1700000060),
            ad("Aina Sato", "Looking for a long story in the harbour.", at=1700000120),
            roll("Antiquill", "rolls 2d6: 4 + 3 = 7", at=1700000180),
            warn("Aina Sato", "Please keep it civil.", at=1700000240),
            event("Antiquill", "is now away.", at=1700000300),
        ],
    )

    got = [
        (m["type_name"], m["speaker"], m["text"], m["ts"])
        for m in parser.parse_log(path)
    ]

    assert got == [
        ("chat", "Azure Viper", "Evening, stranger.", 1700000000),
        # The parser presents an action with its speaker in front.
        ("action", "Antiquill", "Antiquill tips his hat.", 1700000060),
        ("ad", "Aina Sato", "Looking for a long story in the harbour.", 1700000120),
        ("roll", "Antiquill", "rolls 2d6: 4 + 3 = 7", 1700000180),
        ("warn", "Aina Sato", "Please keep it civil.", 1700000240),
        ("event", "Antiquill", "is now away.", 1700000300),
    ]


def test_records_can_sit_either_side_of_a_utc_midnight(tmp_path: Path) -> None:
    path = write_log(
        tmp_path / "log",
        [
            chat("Azure Viper", "Last words of the day.", at=utc(2024, 3, 9, 23, 59, 59)),
            chat("Antiquill", "First words of the next.", at=utc(2024, 3, 10)),
        ],
    )

    isos = [m["iso"] for m in parser.parse_log(path)]

    assert isos == ["2024-03-09T23:59:59+00:00", "2024-03-10T00:00:00+00:00"]


# ---- the short-message rule at its edge -----------------------------------
#
# Under the threshold (default 200 characters of the text as the parser
# presents it) a message is OOC by rule, unconditionally: a `/me` action
# included, by product decision. At the threshold the rule no longer
# decides, so the message waits for a Label.

THRESHOLD = 200
ME = "Azure Viper"
PARTNER = "Antiquill"


@pytest.fixture
def window(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The sidecar as the window reaches it, over an empty F-Chat folder.
    Returns (client, path of the one conversation's Log)."""
    from fastapi.testclient import TestClient

    root = tmp_path / "fchat"
    monkeypatch.setenv("FCHAT_DATA_DIR", str(root))
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    from server import app

    return TestClient(app), root / ME / "logs" / PARTNER


def _messages(client) -> list[dict]:
    res = client.get("/logs/messages", params={"char": ME, "partner": PARTNER})
    assert res.status_code == 200, res.text
    return res.json()["messages"]


def test_chat_just_under_the_threshold_is_ooc_and_at_it_is_unlabeled(window) -> None:
    client, log = window
    write_log(log, [
        chat(ME, "a" * (THRESHOLD - 1), at=1700000000),
        chat(ME, "b" * THRESHOLD, at=1700000060),
    ])

    got = [(len(m["text"]), m["label"]) for m in _messages(client)]

    assert got == [(199, "OOC"), (200, "Unlabeled")]


def test_an_action_just_under_the_threshold_is_ooc_and_at_it_is_unlabeled(
    window,
) -> None:
    client, log = window
    # The presented text is "Azure Viper " (12 characters) plus the body.
    write_log(log, [
        action(ME, "a" * 187, at=1700000000),
        action(ME, "b" * 188, at=1700000060),
    ])

    got = [(len(m["text"]), m["label"]) for m in _messages(client)]

    assert got == [(199, "OOC"), (200, "Unlabeled")]


# ---- actions and system lines downstream of the parser -------------------

LONG_IC = "The lantern swung in the wind as the ferry left the harbour. " * 4


def _chunks(path: Path, labelled_ic: set[str]) -> tuple[list, int]:
    """Chunk one Log the way ingest does, with every message whose raw
    text is in `labelled_ic` carrying an IC Label. Returns the chunks
    and how many messages were skipped as Unlabeled."""
    import chunker
    import labels

    messages = list(parser.parse_log(path))
    by_hash = {
        labels.msg_hash(m): {"label": labels.LABEL_IC}
        for m in messages
        if m["raw"] in labelled_ic
    }
    skipped = [0]
    chunks = chunker.chunk_messages(
        messages,
        character=ME,
        partner=PARTNER,
        labels_by_hash=by_hash,
        label_settings=labels.LabelsSettings(threshold_chars=THRESHOLD),
        include_ooc=True,
        skipped_unlabeled=skipped,
    )
    return chunks, skipped[0]


def test_an_action_keeps_its_speaker_in_the_window(window) -> None:
    client, log = window
    write_log(log, [action(PARTNER, "tips his hat. " + LONG_IC, at=1700000000)])

    (msg,) = _messages(client)

    assert msg["type_name"] == "action"
    assert msg["speaker"] == "Antiquill"
    assert msg["text"].startswith("Antiquill tips his hat. ")


def test_an_action_keeps_its_speaker_in_the_index(tmp_path: Path) -> None:
    body = "tips his hat. " + LONG_IC
    path = write_log(tmp_path / "log", [action(PARTNER, body, at=1700000000)])

    chunks, _ = _chunks(path, labelled_ic={body})

    assert [c["speakers"] for c in chunks] == [["Antiquill"]]
    assert "Antiquill tips his hat." in chunks[0]["text"]


def test_ads_and_rolls_are_system_lines_the_chunker_leaves_out(
    tmp_path: Path,
) -> None:
    ad_text = "Seeking a slow-burn mystery set aboard a sky ship. " * 5
    roll_text = "rolls 1d20 for the lock: 17. " * 8
    path = write_log(tmp_path / "log", [
        chat(ME, LONG_IC, at=1700000000),
        ad("Aina Sato", ad_text, at=1700000060),
        roll(PARTNER, roll_text, at=1700000120),
    ])

    chunks, skipped = _chunks(path, labelled_ic={LONG_IC})

    # Long enough to need a Label, yet neither is waiting for one nor
    # indexed: the chunker knows them as system lines.
    assert skipped == 0
    assert [c["msg_count"] for c in chunks] == [1]
    assert "sky ship" not in chunks[0]["text"]
    assert "1d20" not in chunks[0]["text"]


def test_messages_either_side_of_midnight_land_on_their_own_days(
    tmp_path: Path,
) -> None:
    late = "Late: " + LONG_IC
    early = "Early: " + LONG_IC
    path = write_log(tmp_path / "log", [
        chat(ME, late, at=utc(2024, 3, 9, 23, 59, 59)),
        chat(PARTNER, early, at=utc(2024, 3, 10, 0, 0, 0)),
    ])

    chunks, _ = _chunks(path, labelled_ic={late, early})

    assert [c["date"] for c in chunks] == ["2024-03-09", "2024-03-10"]


# ---- system lines and Labels (spec #5) ------------------------------------
#
# A Label is a verdict on a message a person wrote. Ads, rolls and status
# lines never get one, so they are never Unlabeled and never offered to a
# model. Today the resolver does not know about system lines, so the
# window counts them as Unlabeled and the model is handed them.


def _system_lines_only(log: Path) -> None:
    write_log(log, [
        ad("Aina Sato", "Seeking a slow-burn mystery set aboard a sky ship. " * 5,
           at=1700000000),
        roll(PARTNER, "rolls 1d20 for the lock: 17. " * 8, at=1700000060),
        event(PARTNER, "is now looking for a scene, any genre, any length. " * 5,
              at=1700000120),
    ])


@pytest.mark.xfail(
    strict=True,
    reason="system lines are counted as Unlabeled; the resolver must exclude them (#5)",
)
def test_system_lines_never_count_as_unlabeled(window) -> None:
    client, log = window
    _system_lines_only(log)

    res = client.get("/labels/stats", params={"char": ME, "partner": PARTNER})

    assert res.status_code == 200, res.text
    assert res.json()["unlabeled"] == 0


@pytest.mark.xfail(
    strict=True,
    reason="system lines are offered to the model for a Label; they must not be (#5)",
)
async def test_system_lines_are_never_offered_to_the_model(window) -> None:
    from mcp_helpers import call_tool, mcp_client

    _, log = window
    _system_lines_only(log)

    async with mcp_client("logs") as session:
        _, body = await call_tool(
            session, "get_messages_to_classify", character=ME, partner=PARTNER
        )

    assert body["messages"] == []
