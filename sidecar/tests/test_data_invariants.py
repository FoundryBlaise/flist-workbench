"""The two product rules every data-touching test is held to.

A Log is never changed, and nothing the user owns disappears except
into the Trash or a Backup. `tests/data_invariants.py` checks both after
each test that points the app at a temp data directory; these tests
run a small inner pytest session against it, so what they observe is
exactly what a test author sees: a pass, or an error naming the file.
"""

from __future__ import annotations

import textwrap

import pytest

# Every inner session gets this conftest (the real plugin, as the
# suite's own conftest loads it) and a `home` fixture: one F-Chat Log,
# one image in the pool and one Backup, under the temp data directory.
CONFTEST = "from data_invariants import *\n"

# A stand-in for the app's own code. The real app is the sidecar's
# source tree; the inner conftest makes this file count as app code
# for the length of the inner session.
APP_CONFTEST = textwrap.dedent(
    """
    from pathlib import Path

    import data_invariants as invariants
    from data_invariants import *

    _APP = Path(__file__).parent / "fakeapp.py"


    def pytest_sessionstart(session):
        invariants.APP_ROOTS.append(_APP)


    def pytest_sessionfinish(session):
        invariants.APP_ROOTS.remove(_APP)
    """
)

FAKEAPP = textwrap.dedent(
    """
    import shutil
    from pathlib import Path


    def save(path: Path, data: bytes) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path


    def hard_delete(path: Path) -> None:
        path.unlink()


    def hard_delete_folder(path: Path) -> None:
        shutil.rmtree(path)


    def move(path: Path, to: Path) -> None:
        to.parent.mkdir(parents=True, exist_ok=True)
        path.replace(to)
    """
)

PRELUDE = textwrap.dedent(
    """
    import zipfile
    from pathlib import Path
    from types import SimpleNamespace

    import pytest

    from fchat_logs import chat, write_log


    @pytest.fixture
    def home(tmp_path, monkeypatch):
        fchat = tmp_path / "fchat"
        data = tmp_path / "wb"
        monkeypatch.setenv("FCHAT_DATA_DIR", str(fchat))
        monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(data))
        log = write_log(
            fchat / "Azure Viper" / "logs" / "Antiquill",
            [chat("Antiquill", "Evening.", at=1700000000)],
        )
        char = data / "characters" / "Azure Viper"
        image = char / "images" / "123.png"
        image.parent.mkdir(parents=True)
        image.write_bytes(b"the bytes of picture 123")
        backup = char / "backups" / "2026-10-25T120000Z.zip"
        backup.parent.mkdir()
        with zipfile.ZipFile(backup, "w") as z:
            z.writestr("character.json", "{}")
        return SimpleNamespace(fchat=fchat, data=data, char=char, log=log,
                               image=image, backup=backup)
    """
)


def run(pytester: pytest.Pytester, body: str, *, app: bool = False) -> pytest.RunResult:
    if app:
        pytester.makeconftest(APP_CONFTEST)
        pytester.makepyfile(fakeapp=FAKEAPP)
    else:
        pytester.makeconftest(CONFTEST)
    pytester.makepyfile(test_inner=PRELUDE + textwrap.dedent(body))
    return pytester.runpytest_inprocess("-p", "no:cacheprovider")


# ---- a Log is never changed ----------------------------------------------


def test_a_deleted_log_fails_the_test(pytester: pytest.Pytester) -> None:
    result = run(
        pytester,
        """
        def test_it(home):
            home.log.unlink()
        """,
    )
    result.assert_outcomes(passed=1, errors=1)
    result.stdout.fnmatch_lines(["*log_unchanged*", "*removed*Azure Viper/logs/Antiquill*"])


def test_a_touched_log_fails_the_test(pytester: pytest.Pytester) -> None:
    result = run(
        pytester,
        """
        def test_it(home):
            with open(home.log, "ab") as f:
                f.write(b"x")
        """,
    )
    result.assert_outcomes(passed=1, errors=1)
    result.stdout.fnmatch_lines(["*log_unchanged*", "*modified*Azure Viper/logs/Antiquill*"])


def test_an_added_log_fails_the_test(pytester: pytest.Pytester) -> None:
    result = run(
        pytester,
        """
        def test_it(home):
            (home.fchat / "Azure Viper" / "logs" / "Aina Sato").write_bytes(b"x")
        """,
    )
    result.assert_outcomes(passed=1, errors=1)
    result.stdout.fnmatch_lines(["*log_unchanged*", "*added*Azure Viper/logs/Aina Sato*"])


def test_a_log_the_test_writes_as_f_chat_passes(pytester: pytest.Pytester) -> None:
    # `write_log` plays F-Chat: a test may arrange a Log in its body, or
    # have F-Chat append to one, without breaking the rule.
    result = run(
        pytester,
        """
        def test_it(home):
            write_log(home.fchat / "Azure Viper" / "logs" / "Aina Sato",
                      [chat("Aina Sato", "Hello.", at=1700000000)])
            write_log(home.log, [chat("Antiquill", "Evening.", at=1700000000),
                                 chat("Antiquill", "Again.", at=1700000060)])
        """,
    )
    result.assert_outcomes(passed=1)


def test_the_app_changing_a_log_after_f_chat_wrote_it_fails(
    pytester: pytest.Pytester,
) -> None:
    result = run(
        pytester,
        """
        def test_it(home):
            log = write_log(home.fchat / "Azure Viper" / "logs" / "Aina Sato",
                            [chat("Aina Sato", "Hello.", at=1700000000)])
            log.write_bytes(b"x")
        """,
    )
    result.assert_outcomes(passed=1, errors=1)
    result.stdout.fnmatch_lines(["*log_unchanged*", "*modified*Azure Viper/logs/Aina Sato*"])


def test_reading_a_log_passes(pytester: pytest.Pytester) -> None:
    result = run(
        pytester,
        """
        def test_it(home):
            assert home.log.read_bytes()
        """,
    )
    result.assert_outcomes(passed=1)


# ---- nothing vanishes except into the Trash or a Backup --------------------


def test_a_hard_deleted_image_fails_the_test(pytester: pytest.Pytester) -> None:
    result = run(
        pytester,
        """
        def test_it(home):
            home.image.unlink()
        """,
    )
    result.assert_outcomes(passed=1, errors=1)
    result.stdout.fnmatch_lines(["*Azure Viper/images/123.png*"])


def test_a_hard_deleted_backup_fails_the_test(pytester: pytest.Pytester) -> None:
    result = run(
        pytester,
        """
        def test_it(home):
            home.backup.unlink()
        """,
    )
    result.assert_outcomes(passed=1, errors=1)
    result.stdout.fnmatch_lines(["*Azure Viper/backups/2026-10-25T120000Z.zip*"])


def test_a_trashed_image_passes(pytester: pytest.Pytester) -> None:
    result = run(
        pytester,
        """
        def test_it(home):
            trash = home.char / "trash"
            trash.mkdir()
            home.image.replace(trash / home.image.name)
        """,
    )
    result.assert_outcomes(passed=1)


def test_a_trashed_backup_passes(pytester: pytest.Pytester) -> None:
    result = run(
        pytester,
        """
        def test_it(home):
            trash = home.char / "trash"
            trash.mkdir()
            home.backup.replace(trash / home.backup.name)
        """,
    )
    result.assert_outcomes(passed=1)


def test_a_file_kept_inside_a_backup_passes(pytester: pytest.Pytester) -> None:
    result = run(
        pytester,
        """
        def test_it(home):
            with zipfile.ZipFile(home.char / "backups" / "2026-10-25T130000Z.zip", "w") as z:
                z.writestr("images/123.png", home.image.read_bytes())
            home.image.unlink()
        """,
    )
    result.assert_outcomes(passed=1)


def test_a_backup_with_other_bytes_does_not_count(pytester: pytest.Pytester) -> None:
    result = run(
        pytester,
        """
        def test_it(home):
            with zipfile.ZipFile(home.char / "backups" / "2026-10-25T130000Z.zip", "w") as z:
                z.writestr("images/123.png", b"some other picture")
            home.image.unlink()
        """,
    )
    result.assert_outcomes(passed=1, errors=1)


# ---- where it applies ----------------------------------------------------


def test_a_test_without_a_temp_data_directory_is_not_checked(
    pytester: pytest.Pytester,
) -> None:
    result = run(
        pytester,
        """
        def test_it(tmp_path):
            image = tmp_path / "characters" / "Azure Viper" / "images" / "123.png"
            image.parent.mkdir(parents=True)
            image.write_bytes(b"x")
            image.unlink()
        """,
    )
    result.assert_outcomes(passed=1)


def test_a_file_the_app_made_and_hard_deleted_during_the_test_fails(
    pytester: pytest.Pytester,
) -> None:
    # Not in the baseline, but the user owned it the moment the app
    # wrote it: the app deleting it for good still breaks the rule.
    result = run(
        pytester,
        """
        import fakeapp

        def test_it(home):
            image = fakeapp.save(home.char / "images" / "local-1.png", b"uploaded")
            fakeapp.hard_delete(image)
        """,
        app=True,
    )
    result.assert_outcomes(passed=1, errors=1)
    result.stdout.fnmatch_lines(["*nothing_vanishes*", "*Azure Viper/images/local-1.png*"])


def test_a_folder_the_app_made_and_removed_during_the_test_fails(
    pytester: pytest.Pytester,
) -> None:
    result = run(
        pytester,
        """
        import fakeapp

        def test_it(home):
            fakeapp.save(home.char / "sets" / "a1" / "payload.json", b"a draft description")
            fakeapp.hard_delete_folder(home.char / "sets" / "a1")
        """,
        app=True,
    )
    result.assert_outcomes(passed=1, errors=1)
    result.stdout.fnmatch_lines(["*nothing_vanishes*", "*Azure Viper/sets/a1/payload.json*"])


def test_a_file_the_app_made_and_trashed_during_the_test_passes(
    pytester: pytest.Pytester,
) -> None:
    result = run(
        pytester,
        """
        import fakeapp

        def test_it(home):
            image = fakeapp.save(home.char / "images" / "local-1.png", b"uploaded")
            fakeapp.move(image, home.char / "trash" / "local-1.png")
        """,
        app=True,
    )
    result.assert_outcomes(passed=1)


def test_files_written_by_the_test_itself_are_not_the_baseline(
    pytester: pytest.Pytester,
) -> None:
    # The baseline is taken once the fixtures are set up, so a test may
    # create and remove its own scratch files; what the fixtures put
    # there is what the user is taken to own.
    result = run(
        pytester,
        """
        def test_it(home):
            scratch = home.char / "images" / "local-scratch.png"
            scratch.write_bytes(b"x")
            scratch.unlink()
        """,
    )
    result.assert_outcomes(passed=1)


# ---- opting out, and known violations --------------------------------------


def test_an_exemption_with_a_reason_skips_that_rule_only(
    pytester: pytest.Pytester,
) -> None:
    result = run(
        pytester,
        """
        @pytest.mark.invariant_exempt("nothing_vanishes", reason="a human empties the Trash")
        def test_empties_trash(home):
            home.image.unlink()

        @pytest.mark.invariant_exempt("nothing_vanishes", reason="a human empties the Trash")
        def test_still_guards_logs(home):
            home.log.unlink()
        """,
    )
    result.assert_outcomes(passed=2, errors=1)
    result.stdout.fnmatch_lines(["*test_still_guards_logs*"])


def test_an_exemption_needs_a_reason(pytester: pytest.Pytester) -> None:
    result = run(
        pytester,
        """
        @pytest.mark.invariant_exempt("nothing_vanishes")
        def test_it(home):
            pass
        """,
    )
    result.assert_outcomes(errors=1)
    result.stdout.fnmatch_lines(["*reason*"])


def test_an_unknown_rule_is_refused(pytester: pytest.Pytester) -> None:
    result = run(
        pytester,
        """
        @pytest.mark.invariant_exempt("logs_are_fine", reason="typo")
        def test_it(home):
            pass
        """,
    )
    result.assert_outcomes(errors=1)
    result.stdout.fnmatch_lines(["*logs_are_fine*"])


def test_a_known_violation_names_its_spec_and_passes(pytester: pytest.Pytester) -> None:
    result = run(
        pytester,
        """
        @pytest.mark.known_violation("nothing_vanishes", spec=2, reason="deleting a Backup is final")
        def test_it(home):
            home.backup.unlink()
        """,
    )
    result.assert_outcomes(passed=1)


def test_a_known_violation_needs_a_spec(pytester: pytest.Pytester) -> None:
    result = run(
        pytester,
        """
        @pytest.mark.known_violation("nothing_vanishes", reason="deleting a Backup is final")
        def test_it(home):
            home.backup.unlink()
        """,
    )
    result.assert_outcomes(errors=1)
    result.stdout.fnmatch_lines(["*spec*"])


def test_a_known_violation_that_no_longer_happens_says_remove_the_marker(
    pytester: pytest.Pytester,
) -> None:
    result = run(
        pytester,
        """
        @pytest.mark.known_violation("nothing_vanishes", spec=2, reason="deleting a Backup is final")
        def test_it(home):
            pass
        """,
    )
    result.assert_outcomes(passed=1, errors=1)
    result.stdout.fnmatch_lines(["*spec #2*remove the marker*"])
