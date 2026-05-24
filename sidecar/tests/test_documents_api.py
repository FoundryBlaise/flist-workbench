from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    # Import after env override so the module-level db_path resolves to
    # the tmp dir.
    from server import app

    return TestClient(app)


def test_scratch_appears_on_first_list(client: TestClient) -> None:
    res = client.get("/documents")
    assert res.status_code == 200
    docs = res.json()["documents"]
    assert any(d["scratch"] for d in docs)


def test_crud_roundtrip(client: TestClient) -> None:
    # Create
    created = client.post(
        "/documents", json={"name": "My Profile", "bbcode": "[b]hi[/b]"}
    ).json()
    doc_id = created["id"]
    assert created["name"] == "My Profile"
    assert created["latest_char_count"] == len("[b]hi[/b]")

    # Get
    fetched = client.get(f"/documents/{doc_id}").json()
    assert fetched["document"]["id"] == doc_id
    assert fetched["current"]["bbcode"] == "[b]hi[/b]"

    # Save a new revision
    saved = client.post(
        f"/documents/{doc_id}/revisions", json={"bbcode": "[b]hi v2[/b]", "inlines": {}}
    )
    assert saved.status_code == 201
    rev = saved.json()
    assert rev["bbcode"] == "[b]hi v2[/b]"

    # List revisions: newest first, no body
    revs = client.get(f"/documents/{doc_id}/revisions").json()["revisions"]
    assert len(revs) == 2
    assert revs[0]["char_count"] == len("[b]hi v2[/b]")
    assert "bbcode" not in revs[0]

    # Fetch one revision body
    body = client.get(f"/documents/{doc_id}/revisions/{revs[1]['id']}").json()
    assert body["bbcode"] == "[b]hi[/b]"

    # Rename
    renamed = client.patch(f"/documents/{doc_id}", json={"name": "Final Cut"}).json()
    assert renamed["name"] == "Final Cut"

    # Delete
    assert client.delete(f"/documents/{doc_id}").status_code == 204
    assert client.get(f"/documents/{doc_id}").status_code == 404


def test_draft_round_trip(client: TestClient) -> None:
    doc = client.post("/documents", json={"name": "Drafty"}).json()
    doc_id = doc["id"]
    # Save a draft, then re-open the doc: current returns draft body.
    r = client.put(
        f"/documents/{doc_id}/draft",
        json={"bbcode": "in-flight edits", "inlines": {}},
    )
    assert r.status_code == 204
    state = client.get(f"/documents/{doc_id}").json()
    assert state["current"]["bbcode"] == "in-flight edits"
    assert state["document"]["has_draft"] is True

    # Explicit save promotes draft -> revision and clears the draft.
    client.post(
        f"/documents/{doc_id}/revisions",
        json={"bbcode": "in-flight edits", "inlines": {}},
    )
    after = client.get(f"/documents/{doc_id}").json()
    assert after["document"]["has_draft"] is False


def test_duplicate(client: TestClient) -> None:
    src = client.post("/documents", json={"name": "Source", "bbcode": "[b]body[/b]"}).json()
    dup = client.post(
        f"/documents/{src['id']}/duplicate", json={"name": "Copy of Source"}
    ).json()
    assert dup["id"] != src["id"]
    state = client.get(f"/documents/{dup['id']}").json()
    assert state["current"]["bbcode"] == "[b]body[/b]"


def test_scratch_cannot_be_renamed_or_deleted(client: TestClient) -> None:
    scratch_id = next(d["id"] for d in client.get("/documents").json()["documents"] if d["scratch"])
    bad_rename = client.patch(f"/documents/{scratch_id}", json={"name": "Nope"})
    assert bad_rename.status_code == 400
    bad_delete = client.delete(f"/documents/{scratch_id}")
    assert bad_delete.status_code == 400
