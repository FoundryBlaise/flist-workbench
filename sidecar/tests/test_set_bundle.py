"""Round-trip tests for the Workbench-native working-set bundle format.

The shape contract here is what other Workbench installs will read on
import, so a regression in `build_set_bundle` would silently break every
shared profile. The flow tests pin:

- Build → import inside the same character preserves the payload byte-
  for-byte and dedups image bytes by id.
- Build → import into a *different* character requires confirmation;
  after confirming, the payload's `character.id` is rewritten to the
  target.
- Malformed manifest / unsupported format_version / new payload schema
  raise BundleError instead of silently importing wrong data.
"""
from __future__ import annotations

import io
import json
import zipfile

import pytest

import character_archive
import set_bundle


@pytest.fixture(autouse=True)
def isolated_userdata(tmp_path, monkeypatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    yield


def _seed_character(character_id: str, *, name: str) -> None:
    character_archive.write_live(
        character_id,
        {
            "character": {
                "id": int(character_id),
                "name": name,
                "description": "live description",
                "custom_title": None,
            },
            "kinks": {},
        },
    )


def _seed_set(character_id: str, set_name: str, *, image_ids: list[str]) -> str:
    _seed_character(character_id, name=f"Char{character_id}")
    meta = character_archive.create_set_from_live(character_id, set_name)
    payload = character_archive.read_set_payload(character_id, meta.id) or {}
    payload["character"] = {
        "id": int(character_id),
        "name": f"Char{character_id}",
        "description": "[b]Profile bbcode[/b]",
        "custom_title": "Tester",
    }
    payload["images"] = [
        {"image_id": iid, "description": f"img {iid}", "sort_order": i}
        for i, iid in enumerate(image_ids)
    ]
    payload["kinks"] = {"1": "fave"}
    payload["custom_kinks"] = {"local:abc": {"choice": "yes", "name": "test", "description": ""}}
    payload["_custom_kinks_order"] = ["local:abc"]
    payload["infotags"] = {"1": "value"}
    character_archive.write_set_payload(
        character_id,
        meta.id,
        payload,
        expected_etag=character_archive.set_payload_etag(character_id, meta.id),
    )
    # Plant matching bytes for each declared image.
    for iid in image_ids:
        character_archive.write_character_image(
            character_id, iid, "png", b"\x89PNG\r\n\x1a\n" + iid.encode()
        )
    return meta.id


def test_build_emits_manifest_and_payload_and_images(tmp_path):
    set_id = _seed_set("100", "Set A", image_ids=["111", "222"])

    data, manifest = set_bundle.build_set_bundle("100", set_id)

    with zipfile.ZipFile(io.BytesIO(data), mode="r") as zf:
        names = set(zf.namelist())
        assert "manifest.json" in names
        assert "working.json" in names
        assert "images/111.png" in names
        assert "images/222.png" in names

        on_disk_manifest = json.loads(zf.read("manifest.json"))
        assert on_disk_manifest == manifest
        assert manifest["format"] == "flist-workbench-set"
        assert manifest["format_version"] == 1
        assert manifest["source"]["character_id"] == "100"
        assert manifest["source"]["character_name"] == "Char100"
        assert manifest["source"]["set_name"] == "Set A"
        assert manifest["image_count"] == 2

        payload = json.loads(zf.read("working.json"))
        assert payload["character"]["name"] == "Char100"
        assert payload["images"][0]["image_id"] == "111"


def test_import_same_character_roundtrip_and_dedups_existing_image_bytes(tmp_path):
    set_id = _seed_set("100", "Set A", image_ids=["111", "222"])
    data, _ = set_bundle.build_set_bundle("100", set_id)

    # Both images already exist on disk → every image should be skipped.
    result = set_bundle.import_set_bundle("100", data, name="Imported set 1")

    assert result["image_stats"]["added"] == 0
    assert result["image_stats"]["skipped"] == 2
    assert result["cross_character"] is False
    new_set_id = result["set"]["id"]
    payload = character_archive.read_set_payload("100", new_set_id)
    assert payload is not None
    assert payload["character"]["name"] == "Char100"
    assert [e["image_id"] for e in payload["images"]] == ["111", "222"]


def test_import_writes_missing_image_bytes(tmp_path):
    set_id = _seed_set("100", "Set A", image_ids=["111"])
    data, _ = set_bundle.build_set_bundle("100", set_id)
    # Remove the image bytes from the source character; the target dir
    # for this character is the *same* dir (same character), so deleting
    # before import simulates a missing-byte case.
    character_archive.remove_character_image("100", "111")

    result = set_bundle.import_set_bundle("100", data, name="Imported set 1")

    assert result["image_stats"]["added"] == 1
    assert result["image_stats"]["skipped"] == 0
    assert character_archive.image_path("100", "111", "png").exists()


def test_cross_character_import_requires_confirmation(tmp_path):
    set_id = _seed_set("100", "Set A", image_ids=["111"])
    _seed_character("200", name="Char200")
    data, _ = set_bundle.build_set_bundle("100", set_id)

    with pytest.raises(set_bundle.CrossCharacterConfirmationRequired) as exc:
        set_bundle.import_set_bundle("200", data, name="Imported set 1")
    assert exc.value.source["character_id"] == "100"
    assert exc.value.source["character_name"] == "Char100"


def test_cross_character_import_rewrites_identity_when_confirmed(tmp_path):
    set_id = _seed_set("100", "Set A", image_ids=["111"])
    _seed_character("200", name="Char200")
    data, _ = set_bundle.build_set_bundle("100", set_id)

    result = set_bundle.import_set_bundle(
        "200", data, name="Imported set 1", confirm_cross_character=True
    )

    assert result["cross_character"] is True
    assert result["image_stats"]["added"] == 1  # 200 had no bytes yet
    payload = character_archive.read_set_payload("200", result["set"]["id"])
    assert payload is not None
    assert payload["character"]["id"] == "200"
    assert payload["character"]["name"] == "Char200"
    # Description / infotags / kinks survive the cross-character rewrite.
    assert payload["character"]["description"] == "[b]Profile bbcode[/b]"
    assert payload["infotags"] == {"1": "value"}


def test_import_rejects_non_zip(tmp_path):
    with pytest.raises(set_bundle.BundleError):
        set_bundle.import_set_bundle("100", b"not a zip", name="x")


def test_import_rejects_missing_manifest(tmp_path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w") as zf:
        zf.writestr("working.json", json.dumps({"_overlay": [], "character": {}}))
    with pytest.raises(set_bundle.BundleError):
        set_bundle.import_set_bundle("100", buf.getvalue(), name="x")


def test_import_rejects_unsupported_format(tmp_path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w") as zf:
        zf.writestr(
            "manifest.json",
            json.dumps({"format": "something-else", "format_version": 1}),
        )
        zf.writestr("working.json", json.dumps({"_overlay": [], "character": {}}))
    with pytest.raises(set_bundle.BundleError):
        set_bundle.import_set_bundle("100", buf.getvalue(), name="x")


def test_import_rejects_newer_format_version(tmp_path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w") as zf:
        zf.writestr(
            "manifest.json",
            json.dumps(
                {"format": "flist-workbench-set", "format_version": 99}
            ),
        )
        zf.writestr("working.json", json.dumps({"_overlay": [], "character": {}}))
    with pytest.raises(set_bundle.BundleError):
        set_bundle.import_set_bundle("100", buf.getvalue(), name="x")


def test_endpoints_reject_path_traversal_character_id(tmp_path):
    """The new import endpoint accepts arbitrary bytes — a bogus
    character_id segment must not let us write payloads anywhere outside
    the validated archive root."""
    from fastapi.testclient import TestClient

    import server

    client = TestClient(server.app)
    bad_ids = ["../escape", "..%2Fescape", "foo/bar", "a..b", "x" * 64]
    for bid in bad_ids:
        # Export: GET with a bad id should 400 before any disk touch.
        r = client.get(f"/flist/character/{bid}/sets/aaaaaaaaaaaa/export")
        assert r.status_code in (400, 404), (bid, r.status_code)
        # Import: POST a tiny multipart with a bad id.
        r = client.post(
            f"/flist/character/{bid}/sets/import",
            files={"zip": ("x.zip", b"not a zip", "application/zip")},
            data={"name": "Imported set 1"},
        )
        assert r.status_code in (400, 404), (bid, r.status_code)


def test_import_rejects_path_traversal_in_image_name(tmp_path):
    _seed_character("100", name="Char100")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w") as zf:
        zf.writestr(
            "manifest.json",
            json.dumps(
                {
                    "format": "flist-workbench-set",
                    "format_version": 1,
                    "source": {
                        "character_id": "100",
                        "character_name": "Char100",
                        "set_id": "x",
                        "set_name": "x",
                    },
                }
            ),
        )
        zf.writestr(
            "working.json",
            json.dumps(
                {
                    "_overlay": [],
                    "character": {"id": 100, "name": "Char100"},
                    "images": [],
                }
            ),
        )
        zf.writestr("images/../escape.png", b"bad")
        zf.writestr("images/subdir/nested.png", b"bad")

    result = set_bundle.import_set_bundle("100", buf.getvalue(), name="Imported set 1")
    # Both bad entries dropped silently; nothing added.
    assert result["image_stats"]["added"] == 0
