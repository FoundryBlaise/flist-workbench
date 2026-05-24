from pathlib import Path

import pytest

from flist import ProfileNotFound, parse_profile

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> str:
    # newline="" preserves the bare \r line breaks F-list ships, so the
    # test reflects the live HTTP response and exercises normalisation.
    with open(FIXTURES / name, "r", encoding="utf-8", newline="") as f:
        return f.read()


def test_parse_real_profile() -> None:
    profile = parse_profile(load("profile_azure_viper.html"), requested_name="Azure Viper")

    assert profile.name == "Azure Viper"
    assert profile.avatar_url == "https://static.f-list.net/images/avatar/azure viper.png"
    # Statbox should at least capture the visible labels.
    assert profile.stats["Gender"] == "Female"
    assert profile.stats["Orientation"] == "Gay"
    assert "Language Preference" in profile.stats
    # The BBCode source must be recovered and HTML entities decoded.
    assert profile.bbcode, "expected BBCode source to be extracted"
    assert "[hr]" in profile.bbcode
    assert "[center]" in profile.bbcode
    assert "[indent][b]Name:[/b]" in profile.bbcode
    # & diams; should decode to the literal lozenge character.
    assert "♦" in profile.bbcode
    # No leftover <br /> from F-list's display layer.
    assert "<br" not in profile.bbcode.lower()
    # F-list uses bare \r line breaks in source; normalised to \n.
    assert "\r" not in profile.bbcode
    assert "\n" in profile.bbcode


def test_inlines_manifest_extracted() -> None:
    profile = parse_profile(load("profile_azure_viper.html"), requested_name="Azure Viper")
    # The profile must expose FList.Inlines.inlines as a dict keyed by
    # the numeric id used in [img=ID] tags. Each entry must carry the
    # hash + extension fields the client uses to build the CDN url.
    assert profile.inlines, "expected inlines manifest to be extracted"
    sample_id, sample = next(iter(profile.inlines.items()))
    assert sample_id.isdigit()
    assert "hash" in sample and len(sample["hash"]) == 40
    assert "extension" in sample
    assert "nsfw" in sample


def test_missing_character_raises() -> None:
    html = (
        "<html><head><title>F-list - System message</title></head>"
        "<body>No such character exists.</body></html>"
    )
    with pytest.raises(ProfileNotFound):
        parse_profile(html, requested_name="Not Real")
