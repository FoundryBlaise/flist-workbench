"""The same cases as `renderer/src/lib/bbcode/validate.test.ts`.

Both implementations mirror F-list's parser, and every case below was
run through the live one in the browser —
`FList.TagParser.enableWarnings(); parseEverything(htmlentities(s))` on
f-list.net — and matched. Two implementations of the same rules will
drift; identical cases on both sides is what makes the drift show up
as a failing test instead of a refused upload.
"""

from __future__ import annotations

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
