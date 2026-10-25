"""Tests for the mutation probe, driven through run_probe on a throwaway git repo.

The test runner is the one injected seam: a fake that reports pass or fail,
or blows up the way a real run can (exception, Ctrl+C).
"""
import subprocess
from pathlib import Path

import pytest

from probe import (
    BadMutationList,
    BaselineFailed,
    DirtyTree,
    Mutation,
    Outcome,
    Result,
    load_mutations,
    render_report,
    run_probe,
)

ORIGINAL = "def threshold(n):\n    return n < 200\n"


def git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=root, check=True, capture_output=True, text=True
    ).stdout


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    git(tmp_path, "init", "-q")
    git(tmp_path, "config", "user.email", "probe@example.invalid")
    git(tmp_path, "config", "user.name", "probe")
    (tmp_path / "rule.py").write_text(ORIGINAL, encoding="utf-8", newline="")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-q", "-m", "init")
    return tmp_path


def mutation(id_: str = "X01", find: str = "n < 200", replace: str = "n <= 200") -> Mutation:
    return Mutation(
        id=id_,
        suite="sidecar",
        file="rule.py",
        find=find,
        replace=replace,
        breaks="a message exactly at the threshold counts as OOC",
        tests=("tests/test_rule.py",),
    )


class Recorder:
    """Fake test runner: records what the source looked like during each run."""

    def __init__(self, root: Path, outcomes=None):
        self.root = root
        self.seen: list[str] = []
        self.outcomes = list(outcomes or [])

    def __call__(self, suite, tests):
        self.seen.append((self.root / "rule.py").read_text(encoding="utf-8"))
        if self.outcomes:
            out = self.outcomes.pop(0)
            if isinstance(out, BaseException):
                raise out
            return out
        return Outcome(returncode=0, failures=[], summary="1 passed")


def test_refuses_a_tree_with_a_modified_file(repo):
    (repo / "rule.py").write_text(ORIGINAL + "# local edit\n", encoding="utf-8")
    runner = Recorder(repo)
    with pytest.raises(DirtyTree):
        run_probe(repo, [mutation()], runner)
    assert runner.seen == []
    assert (repo / "rule.py").read_text(encoding="utf-8").endswith("# local edit\n")


def test_refuses_a_tree_with_an_untracked_file(repo):
    (repo / "stray.txt").write_text("left over", encoding="utf-8")
    runner = Recorder(repo)
    with pytest.raises(DirtyTree):
        run_probe(repo, [mutation()], runner)
    assert runner.seen == []


def test_a_failing_run_kills_the_mutation_and_the_source_comes_back(repo):
    runner = Recorder(
        repo,
        [
            Outcome(returncode=0, summary="baseline"),
            Outcome(returncode=1, failures=["tests/test_rule.py::test_edge"], summary="1 failed"),
        ],
    )
    [result] = run_probe(repo, [mutation()], runner)
    assert result.status == "killed"
    assert result.failures == ["tests/test_rule.py::test_edge"]
    assert runner.seen == [ORIGINAL, ORIGINAL.replace("n < 200", "n <= 200")]
    assert (repo / "rule.py").read_text(encoding="utf-8") == ORIGINAL
    assert git(repo, "status", "--porcelain") == ""


def test_a_passing_run_means_the_mutation_survived(repo):
    [result] = run_probe(repo, [mutation()], Recorder(repo))
    assert result.status == "survived"
    assert (repo / "rule.py").read_text(encoding="utf-8") == ORIGINAL


def test_mutations_are_applied_one_at_a_time(repo):
    runner = Recorder(repo)
    run_probe(
        repo,
        [mutation("X01"), mutation("X02", find="return n", replace="return not n")],
        runner,
    )
    assert runner.seen[1:] == [
        ORIGINAL.replace("n < 200", "n <= 200"),
        ORIGINAL.replace("return n", "return not n"),
    ]


@pytest.mark.parametrize("blowup", [RuntimeError("runner crashed"), KeyboardInterrupt()])
def test_the_source_comes_back_when_the_run_is_cut_short(repo, blowup):
    runner = Recorder(repo, [Outcome(returncode=0), blowup])
    with pytest.raises(type(blowup)):
        run_probe(repo, [mutation()], runner)
    assert runner.seen[1] != ORIGINAL
    assert (repo / "rule.py").read_text(encoding="utf-8") == ORIGINAL
    assert git(repo, "status", "--porcelain") == ""


def test_refuses_to_probe_when_the_tests_already_fail_unmutated(repo):
    runner = Recorder(repo, [Outcome(returncode=1, failures=["tests/test_rule.py::test_edge"])])
    with pytest.raises(BaselineFailed):
        run_probe(repo, [mutation()], runner)
    assert runner.seen == [ORIGINAL]


@pytest.mark.parametrize("find", ["n > 200", "n"])
def test_an_anchor_that_does_not_match_exactly_once_is_reported_stale(repo, find):
    runner = Recorder(repo)
    [result] = run_probe(repo, [mutation(find=find)], runner)
    assert result.status == "stale"
    assert runner.seen == [ORIGINAL]  # the baseline only
    assert (repo / "rule.py").read_text(encoding="utf-8") == ORIGINAL


LIST = """
[groups]
rules = ["tests/test_rule.py", "tests/test_more_*.py"]

[[mutation]]
id = "X01"
suite = "sidecar"
file = "rule.py"
breaks = "a message exactly at the threshold counts as OOC"
tests = ["@rules", "tests/test_other.py"]
spec = 5
audit = "survived"
find = '''
    return n < 200
'''
replace = '''
    return n <= 200
'''
"""


def test_a_mutation_list_loads_with_its_groups_and_globs_expanded(repo):
    (repo / "tests").mkdir()
    for name in ("test_rule.py", "test_more_a.py", "test_more_b.py", "test_other.py"):
        (repo / "tests" / name).write_text("", encoding="utf-8")
    (repo / "list.toml").write_text(LIST, encoding="utf-8")

    [m] = load_mutations(repo / "list.toml", repo)

    assert m == Mutation(
        id="X01",
        suite="sidecar",
        file="rule.py",
        find="    return n < 200\n",
        replace="    return n <= 200\n",
        breaks="a message exactly at the threshold counts as OOC",
        tests=(
            "tests/test_rule.py",
            "tests/test_more_a.py",
            "tests/test_more_b.py",
            "tests/test_other.py",
        ),
        spec=5,
        audit="survived",
    )


def test_a_mutation_may_delete_its_find_text_outright(repo):
    (repo / "tests").mkdir()
    for name in ("test_rule.py", "test_more_a.py", "test_other.py"):
        (repo / "tests" / name).write_text("", encoding="utf-8")
    deleting = LIST.replace("replace = '''\n    return n <= 200\n'''", "replace = ''")
    (repo / "list.toml").write_text(deleting, encoding="utf-8")
    [m] = load_mutations(repo / "list.toml", repo)
    assert m.replace == ""


@pytest.mark.parametrize(
    "broken, complaint",
    [
        (LIST.replace('suite = "sidecar"', 'suite = "backend"'), "suite"),
        (LIST.replace('breaks = "a message exactly at the threshold counts as OOC"\n', ""), "breaks"),
        (LIST.replace('"@rules", ', '"@nope", '), "@nope"),
        (LIST.replace('"tests/test_other.py"', '"tests/test_gone.py"'), "test_gone"),
        (LIST + "[[mutation]]" + LIST.split("[[mutation]]")[1], "X01"),
    ],
)
def test_a_malformed_mutation_list_is_refused_with_the_reason(repo, broken, complaint):
    (repo / "tests").mkdir()
    for name in ("test_rule.py", "test_more_a.py", "test_other.py"):
        (repo / "tests" / name).write_text("", encoding="utf-8")
    (repo / "list.toml").write_text(broken, encoding="utf-8")
    with pytest.raises(BadMutationList, match=complaint):
        load_mutations(repo / "list.toml", repo)


def test_the_report_counts_kills_per_area_and_names_the_spec_for_each_survivor(repo):
    caught = mutation("L04")
    missed = Mutation(**{**mutation("L10").__dict__, "spec": 5, "audit": "survived"})
    report = render_report(
        [
            Result(caught, "killed", ["tests/test_rule.py::test_edge"], "1 failed"),
            Result(missed, "survived", [], "3 passed"),
        ]
    )
    assert "| L | 1 of 2 |" in report
    assert "tests/test_rule.py::test_edge" in report
    survivors = report.split("## Survivors")[1]
    assert "L10" in survivors and "#5" in survivors
    assert "L04" not in survivors


def test_stops_when_something_else_changes_the_tree_mid_run(repo):
    class Meddler(Recorder):
        def __call__(self, suite, tests):
            out = super().__call__(suite, tests)
            if len(self.seen) == 2:
                (self.root / "other.txt").write_text("another run's edit", encoding="utf-8")
            return out

    runner = Meddler(repo)
    with pytest.raises(DirtyTree):
        run_probe(
            repo,
            [mutation("X01"), mutation("X02", find="return n", replace="return not n")],
            runner,
        )
    assert len(runner.seen) == 2
    assert (repo / "rule.py").read_text(encoding="utf-8") == ORIGINAL
