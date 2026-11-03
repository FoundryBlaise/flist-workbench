"""Removing model weights the settings no longer name.

fastembed downloads a model into the app's model folder the first time
it is used, and keeps it there. A reranker is over a gigabyte, so after
a switch to another model the old weights would linger for good. They
are a download cache, not user data: they go directly, not to the
Trash, and fastembed fetches them again if the user switches back.

Only folders this module can name are touched. fastembed names a
model's folder after its Hugging Face source (`models--<org>--<repo>`,
with a matching lock folder under `.locks/`) or, for the older
downloads from its own storage, after the model (`fast-<name>`). The
names come from fastembed's own catalogue, so a folder the app does
not recognise, put there by hand or by another version, stays.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any, Iterable

from rag_rerank import models_dir

log = logging.getLogger(__name__)

EMBEDDING = "embedding"
RERANKER = "reranker"

#: Suffix of a folder renamed for removal whose removal did not finish.
_REMOVING = ".removing"


def remove_unused(kind: str, keep: Iterable[str], models: Path | None = None) -> list[str]:
    """Delete the weights of every `kind` model not in `keep`.

    `keep` is every model the settings name, embedding and reranker
    alike, so a folder one of them uses is never removed. Returns the
    folder names removed. A folder that cannot be removed (Windows
    refuses while an encoder still has its files open) stays, and the
    next switch tries again.
    """
    folder = models or models_dir()
    catalogue = _catalogue()
    keep = set(keep)
    kept = {
        name for _, m in catalogue if m["model"] in keep for name in _folder_names(m)
    }
    unused = {
        name
        for kind_, m in catalogue
        if kind_ == kind and m["model"] not in keep
        for name in _folder_names(m)
    } - kept

    removed = []
    for entry in sorted(folder.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name.endswith(_REMOVING):
            # Left over from a removal that did not finish.
            shutil.rmtree(entry, ignore_errors=True)
        elif entry.name.casefold() in unused and _remove(entry):
            removed.append(entry.name)
            _remove(folder / ".locks" / entry.name)
    return removed


def _remove(path: Path) -> bool:
    """Rename `path` out of fastembed's way, then delete it. The rename
    fails as a whole while a file inside is open, which leaves the
    weights intact rather than half deleted."""
    if not path.is_dir():
        return False
    doomed = path.with_name(path.name + _REMOVING)
    try:
        path.rename(doomed)
    except OSError as exc:
        log.info("model weights %s stay for now: %s", path.name, exc)
        return False
    shutil.rmtree(doomed, ignore_errors=True)
    return True


def _catalogue() -> list[tuple[str, dict[str, Any]]]:
    """Every model fastembed offers, with its kind."""
    # Imported lazily: fastembed pulls in onnxruntime, which only a
    # model change needs here.
    from fastembed import TextEmbedding
    from fastembed.rerank.cross_encoder import TextCrossEncoder

    return [(EMBEDDING, m) for m in TextEmbedding.list_supported_models()] + [
        (RERANKER, m) for m in TextCrossEncoder.list_supported_models()
    ]


def _folder_names(model: dict[str, Any]) -> set[str]:
    """The folder names fastembed may use for a catalogue entry,
    casefolded: the catalogue spells some orgs in lower case, and
    Windows does not tell the cases apart anyway."""
    source = model.get("sources") or {}
    names = set()
    if source.get("hf"):
        names.add("models--" + source["hf"].replace("/", "--"))
    if source.get("url"):
        short = model["model"].split("/")[-1]
        names.add(("fast-" if source.get("_deprecated_tar_struct") else "") + short)
    return {name.casefold() for name in names}
