"""The same cases as `renderer/src/lib/bbcode/validate.test.ts`.

Both implementations mirror F-list's parser, and every case below was
run through the live one in the browser —
`FList.TagParser.enableWarnings(); parseEverything(htmlentities(s))` on
f-list.net — and matched. The table of verified verdicts is one
fixture both sides read,
`renderer/src/lib/bbcode/__fixtures__/flist_verified.json`. A few tests
pad or repeat a verified case to check offsets, wording or long texts;
each says which case it builds on. Two implementations of the same
rules will drift; identical cases on both sides is what makes the drift
show up as a failing test instead of a refused upload.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import bbcode_rules


def tags(source: str) -> list[str]:
    return [w.tag for w in bbcode_rules.validate(source)]


def test_one_level_of_formatting_inside_big_is_fine() -> None:
    assert tags("[big][b]X[/b][/big]") == []
    assert tags("[big][color=cyan]X[/color][/big]") == []
    assert tags("[big][i]X[/i][/big]") == []


def test_a_second_level_inside_big_is_refused() -> None:
    # The shape everyone reaches for when they want a large, bold,
    # coloured heading — and the one F-list rejects.
    assert tags("[big][b][color=cyan]X[/color][/b][/big]") == ["color"]
    assert tags("[big][color=cyan][b]X[/b][/color][/big]") == ["b"]


def test_the_same_heading_passes_with_the_colour_outside() -> None:
    assert tags("[color=cyan][big][b]X[/b][/big][/color]") == []


def test_ordinary_nesting_is_left_alone() -> None:
    assert tags("[b][color=cyan]X[/color][/b]") == []
    assert tags("[color=gray][sub]Y[/sub][/color]") == []
    assert tags("[center][b][i]X[/i][/b][/center]") == []


def test_sub_and_sup_take_only_bold_italic_underline() -> None:
    assert tags("[sub][b]Y[/b][/sub]") == []
    assert tags("[sub][color=gray]Y[/color][/sub]") == ["color"]
    assert tags("[sup][s]Y[/s][/sup]") == ["s"]


def test_url_icon_and_noparse_take_nothing() -> None:
    assert tags("[url=https://example.com][b]X[/b][/url]") == ["b"]
    assert tags("[icon][b]Name[/b][/icon]") == ["b"]
    # Inside noparse everything is literal, so nothing is judged.
    assert tags("[noparse][big][b][color=red]X[/color][/b][/big][/noparse]") == []


def test_it_says_which_tag_and_where() -> None:
    (w,) = bbcode_rules.validate("hello [big][b][color=cyan]X[/color][/b][/big]")
    assert w.tag == "color"
    assert w.start == len("hello [big][b]")
    assert "The [color] tag is not allowed here" in w.message


def test_tags_f_list_does_not_know_are_ignored() -> None:
    assert tags("[big][blink]X[/blink][/big]") == []


def test_plain_text_has_nothing_wrong_with_it() -> None:
    assert bbcode_rules.validate("Just a description, no markup at all.") == []


def test_the_explanation_names_the_fix() -> None:
    text = bbcode_rules.explain(
        bbcode_rules.validate("[big][b][color=cyan]X[/color][/b][/big]")
    )
    assert "not allowed here" in text
    assert "[color=cyan][big][b]" in text, "say what to write instead"
    assert bbcode_rules.explain([]) == ""


# ---- Tags F-list will show as plain text --------------------------------
#
# The second class of F-list parser warnings: a tag that does not end in
# its own closer is printed, with everything inside it, as literal text.
# The verified cases live in a fixture the renderer's tests read too;
# its "about" gives the letters and says how a case gets in.

VERIFIED_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "renderer/src/lib/bbcode/__fixtures__/flist_verified.json"
)
VERIFIED = json.loads(VERIFIED_FIXTURE.read_text(encoding="utf-8"))["cases"]

_KIND = {"B": "bad-nesting", "O": "not-closed", "N": "not-allowed"}


def verdicts(source: str) -> list[tuple[str, str]]:
    return [(w.kind, w.tag) for w in bbcode_rules.validate(source)]


def expect(listed: list[str]) -> list[tuple[str, str]]:
    """['B b', 'O color'] -> [('bad-nesting', 'b'), ('not-closed', 'color')]."""
    return [(_KIND[part.split()[0]], part.split()[1]) for part in listed]


def test_an_unclosed_tag_is_reported() -> None:
    assert verdicts("[b]x") == expect(["O b"])


@pytest.mark.parametrize(
    ("source", "listed"),
    [(case["source"], case["warnings"]) for case in VERIFIED],
)
def test_f_list_verdicts(source: str, listed: list[str]) -> None:
    assert verdicts(source) == expect(listed)


def test_structural_warnings_carry_f_lists_text_and_the_opening_tag() -> None:
    crossed, unclosed = bbcode_rules.validate("[color=green][b]x[/color][/b]")
    assert crossed.start == len("[color=green]")
    assert crossed.message == (
        "Bad BBCode in [b] tag, somewhere around/after 'x[/color][/b]...'."
    )
    assert unclosed.start == 0
    assert unclosed.message == (
        "Open [color] tag is not properly closed (with [/color])."
    )


def test_offsets_count_brackets_f_list_escapes() -> None:
    # Builds on "[b]x", padded with brackets F-list escapes to text.
    (w,) = bbcode_rules.validate("[x] [] [blink] [b]x")
    assert w.start == len("[x] [] [blink] ")


def test_a_long_or_deeply_nested_text_is_checked_whole() -> None:
    # Repeats "[b]ok[/b] [i]ok[/i]" and "[b]x"; a description can be
    # long, and a write guard must not run out of stack on one.
    assert bbcode_rules.validate("[b]ok[/b] [i]ok[/i] " * 5000) == []
    assert verdicts("[b]" * 2000 + "x") == [("not-closed", "b")] * 2000


def test_the_explanation_for_an_unclosed_tag_says_to_close_it() -> None:
    # Builds on "[b]x", after plain text.
    text = bbcode_rules.explain(bbcode_rules.validate("Intro. [b]x"))
    assert "Open [b] tag is not properly closed (with [/b])." in text
    assert "as plain text" in text, "F-list takes it; it shows it raw"
    assert "character 7" in text, "say roughly where"
    assert "close it with [/b]" in text.lower()
    assert "[big]" not in text, "the nesting hint does not apply"


def test_the_explanation_for_crossed_tags_says_reverse_order() -> None:
    text = bbcode_rules.explain(
        bbcode_rules.validate("[color=green][b]x[/color][/b]")
    )
    assert "Bad BBCode in [b] tag" in text
    assert "reverse order" in text
    assert "[big]" not in text


def test_the_explanation_covers_both_classes_when_both_occur() -> None:
    text = bbcode_rules.explain(
        bbcode_rules.validate(
            "[big][b][color=cyan]X[/color][/b][/big] [color=green][b]x[/color][/b]"
        )
    )
    assert "reverse order" in text
    assert "[color=cyan][big][b]" in text


def test_spoiler_is_not_an_f_list_tag() -> None:
    # F-list's tag table has no [spoiler]: it stays literal text, with
    # no warning and no nesting check.
    assert verdicts("[spoiler]x") == []
    assert verdicts("[big][b][spoiler]x[/spoiler][/b][/big]") == []
