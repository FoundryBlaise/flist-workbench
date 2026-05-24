import os
from pathlib import Path

import pytest

import documents


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    return tmp_path


@pytest.fixture
def conn(isolated_data_dir: Path):
    c = documents.connect()
    yield c
    c.close()


def test_scratch_exists_on_fresh_db(conn) -> None:
    docs = documents.list_documents(conn)
    assert len(docs) == 1
    assert docs[0].scratch is True
    assert docs[0].name == "Scratch"
    # Scratch ships with the seed BBCode in its first revision so a
    # first-launch user lands on something that exercises the renderer
    # instead of a blank pane.
    assert docs[0].latest_revision_id is not None
    assert docs[0].latest_char_count == len(documents.SCRATCH_SEED)


def test_create_and_list(conn) -> None:
    doc = documents.create_document(conn, "Lady Amber Blaise", bbcode="[b]hi[/b]")
    assert doc.name == "Lady Amber Blaise"
    assert doc.scratch is False
    assert doc.latest_char_count == len("[b]hi[/b]")
    listed = documents.list_documents(conn)
    # Scratch is pinned to the top by the scratch DESC order; new doc
    # comes after.
    assert listed[0].scratch is True
    assert listed[1].id == doc.id


def test_rename_and_delete(conn) -> None:
    doc = documents.create_document(conn, "Draft")
    renamed = documents.rename_document(conn, doc.id, "Final")
    assert renamed.name == "Final"
    documents.delete_document(conn, doc.id)
    assert all(d.id != doc.id for d in documents.list_documents(conn))


def test_scratch_is_protected(conn) -> None:
    scratch = next(d for d in documents.list_documents(conn) if d.scratch)
    with pytest.raises(documents.DocumentError):
        documents.rename_document(conn, scratch.id, "Something else")
    with pytest.raises(documents.DocumentError):
        documents.delete_document(conn, scratch.id)


def test_save_revision_increments_history(conn) -> None:
    doc = documents.create_document(conn, "Profile", bbcode="r1")
    documents.save_revision(conn, doc.id, "r2")
    documents.save_revision(conn, doc.id, "r3 longer body")
    revs = documents.list_revisions(conn, doc.id)
    # Three revisions: the one from create_document, then r2, then r3.
    assert [r.bbcode for r in revs] == ["r3 longer body", "r2", "r1"]
    assert revs[0].char_count == len("r3 longer body")


def test_duplicate_copies_current_content(conn) -> None:
    src = documents.create_document(conn, "Original", bbcode="[i]body[/i]")
    documents.save_draft(conn, src.id, "edited but not saved")
    dup = documents.duplicate_document(conn, src.id, "Copy")
    assert dup.id != src.id
    # Duplicate captures the live state (draft beats latest revision),
    # which is the natural read of "duplicate this document".
    current = documents.current_content(conn, dup.id)
    assert current.bbcode == "edited but not saved"


def test_draft_round_trip_and_clears_on_save(conn) -> None:
    doc = documents.create_document(conn, "WIP")
    documents.save_draft(conn, doc.id, "draft body")
    current = documents.current_content(conn, doc.id)
    assert current.bbcode == "draft body"
    listed = next(d for d in documents.list_documents(conn) if d.id == doc.id)
    assert listed.has_draft is True

    # Explicit save promotes the draft to a real revision and clears
    # the draft slot — restoring "current content" then resolves to
    # the freshly-saved revision.
    documents.save_revision(conn, doc.id, "saved body")
    after = documents.current_content(conn, doc.id)
    assert after.bbcode == "saved body"
    listed = next(d for d in documents.list_documents(conn) if d.id == doc.id)
    assert listed.has_draft is False


def test_get_document_404(conn) -> None:
    with pytest.raises(documents.DocumentError):
        documents.get_document(conn, 99999)


def test_user_data_dir_respects_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "custom"))
    assert documents.user_data_dir() == tmp_path / "custom"
