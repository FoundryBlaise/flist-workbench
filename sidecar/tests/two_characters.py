"""Two of the user's own characters and a partner known under two names.

The scenario every character- and alias-scoped test builds on, so that
Label identity (ADR 0004) and alias resolution are tested against the
same Logs over REST and over MCP:

* Azure Viper and Lady Amber Blaise, both the user's own, talk to each
  other. Each keeps her own Log of that conversation, and both Logs hold
  the same line (`SHARED_LINE`): one message, two Logs.
* Azure Viper also talks to Antiquill, who used to be called Quill
  Ashgrove. F-Chat started a new Log at the rename; for Azure Viper the
  two names are linked as aliases with Antiquill as the primary.
* Lady Amber Blaise has a conversation with Antiquill too, under the
  same partner name but without any alias link of her own.

Every long line is above the default 200-character threshold, so it is
Unlabeled until someone gives it a Label. Three lines mention the
lighthouse: both of Azure Viper's lines with Antiquill (one per name)
and Lady Amber Blaise's line with Antiquill, so a search scoped to one
conversation can be told apart from one that leaks across characters.

Use it by importing the fixture into a test module:

    from two_characters import two_characters  # noqa: F401
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fchat_logs import action, chat, utc, write_log

AZURE = "Azure Viper"
AMBER = "Lady Amber Blaise"
PARTNER = "Antiquill"
OLD_NAME = "Quill Ashgrove"

#: The one line both own characters' Logs hold.
SHARED_LINE = (
    "Amber set the letter on the table between them and smoothed it flat. "
    "\"It came this morning, sealed with the harbour master's wax, and it "
    "names both of us. I think we should read it together.\" She waited "
    "for Azure to sit before breaking the seal."
)
SHARED_REPLY = "mhm"

#: Azure Viper with Antiquill, under the current name.
PARTNER_LINE = (
    "Antiquill leaned on the railing and pointed past the breakwater. "
    "\"The lighthouse has been dark for three nights now. Nobody in town "
    "will say why, and the keeper has not come down for supplies since.\" "
    "He did not look away from the water."
)
#: Azure Viper with Antiquill, back when he was Quill Ashgrove.
OLD_NAME_LINE = (
    "Quill pulled the map from his coat and traced the coast road with "
    "one finger. \"If we leave at dawn we reach the lighthouse by noon, "
    "and nobody on the cliff path will think to ask what we carry.\" He "
    "folded the map again and waited."
)
#: Lady Amber Blaise with Antiquill: same partner name, other character.
AMBER_PARTNER_LINE = (
    "Antiquill bowed to Amber and offered her the folded note. \"The "
    "lighthouse keeper asked me to give you this, my lady, and to say "
    "that he will wait for an answer until the tide turns tonight.\" The "
    "seal on it was still warm."
)

SEARCH_TERM = "lighthouse"


@dataclass
class TwoCharacters:
    """The scenario on disk, plus a REST client over it. MCP tests open
    their own session with `mcp_helpers.mcp_client`; both see the same
    Logs and the same Label store."""

    fchat_dir: Path
    client: TestClient

    def messages(self, character: str, partner: str) -> list[dict]:
        """The conversation as the log viewer gets it."""
        res = self.client.get(
            "/logs/messages", params={"char": character, "partner": partner}
        )
        assert res.status_code == 200, res.text
        return res.json()["messages"]

    def message(self, character: str, partner: str, text: str) -> dict:
        """The one message in a conversation whose text is `text`."""
        found = [m for m in self.messages(character, partner) if m["text"] == text]
        assert len(found) == 1, f"{text[:30]!r} in {character}/{partner}: {found}"
        return found[0]

    def hash_of(self, character: str, partner: str, text: str) -> str:
        return self.message(character, partner, text)["hash"]

    def label_by_hand(
        self, character: str, partner: str, text: str, label: str
    ) -> None:
        """A manual Label, as the log viewer's right-click sets it."""
        msg = self.message(character, partner, text)
        res = self.client.post(
            "/labels/override",
            json={
                "character": character,
                "partner": partner,
                "hash": msg["hash"],
                "ts": msg["ts"],
                "speaker": msg["speaker"],
                "label": label,
            },
        )
        assert res.status_code == 200, res.text

    def link_alias(self) -> None:
        res = self.client.post(
            "/aliases",
            json={"character": AZURE, "name": OLD_NAME, "primary_name": PARTNER},
        )
        assert res.status_code == 201, res.text

    def unlink_alias(self) -> None:
        res = self.client.delete("/aliases", params={"char": AZURE, "name": OLD_NAME})
        assert res.status_code == 200, res.text


def write_logs(fchat_dir: Path) -> None:
    """The scenario's Logs, without the alias link."""
    shared = [
        chat(AMBER, SHARED_LINE, at=utc(2024, 5, 4, 20, 15)),
        chat(AZURE, SHARED_REPLY, at=utc(2024, 5, 4, 20, 16)),
    ]
    write_log(fchat_dir / AZURE / "logs" / AMBER, shared)
    write_log(fchat_dir / AMBER / "logs" / AZURE, shared)

    write_log(
        fchat_dir / AZURE / "logs" / OLD_NAME,
        [
            chat(OLD_NAME, OLD_NAME_LINE, at=utc(2024, 3, 1, 21, 0)),
            action(AZURE, "nods.", at=utc(2024, 3, 1, 21, 2)),
        ],
    )
    write_log(
        fchat_dir / AZURE / "logs" / PARTNER,
        [
            chat(PARTNER, PARTNER_LINE, at=utc(2024, 4, 12, 19, 30)),
            action(AZURE, "follows his gaze.", at=utc(2024, 4, 12, 19, 31)),
        ],
    )
    write_log(
        fchat_dir / AMBER / "logs" / PARTNER,
        [chat(PARTNER, AMBER_PARTNER_LINE, at=utc(2024, 4, 20, 18, 0))],
    )


@pytest.fixture
def two_characters(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TwoCharacters:
    """The scenario with Quill Ashgrove already linked to Antiquill for
    Azure Viper, on a fresh F-Chat folder and a fresh data folder."""
    fchat_dir = tmp_path / "fchat"
    monkeypatch.setenv("FCHAT_DATA_DIR", str(fchat_dir))
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    write_logs(fchat_dir)

    # No module reloads: logs and paths read the env vars per call, and
    # a reload rebinds globals other test modules captured at import.
    from server import app

    scenario = TwoCharacters(fchat_dir=fchat_dir, client=TestClient(app))
    scenario.link_alias()
    return scenario

