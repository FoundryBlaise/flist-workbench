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

`remove_stale` is the one entry point: the settings service calls it
after a model switch, and the sidecar at start, so weights a removal
could not take (an encoder still had them open, the app was closed
first) go then.
"""

from __future__ import annotations

import logging
import shutil
from collections.abc import Iterable
from enum import Enum
from pathlib import Path
from typing import Any

import rag as rag_settings
import rag_embed_local
import rag_rerank
from rag_rerank import models_dir

log = logging.getLogger(__name__)


class Kind(Enum):
    """Which setting names a model: the embedding model or the reranker."""

    EMBEDDING = "embedding"
    RERANKER = "reranker"

#: Suffix of a folder renamed for removal whose removal did not finish.
_REMOVING = ".removing"


def remove_stale(kinds: Iterable[Kind] = tuple(Kind)) -> None:
    """Delete the weights of the models of `kinds` the settings no
    longer name.

    Embedding weights wait while a job holds the Index: an ingest
    embeds every batch with the model it started with, and would
    download it again if it went now. They go when that job ends.
    """
    from services import index, jobs

    kinds = set(kinds)
    if Kind.RERANKER in kinds:
        _remove_stale_now(Kind.RERANKER)
    if Kind.EMBEDDING in kinds:
        jobs.registry().when_free(index.INDEX, lambda: _remove_stale_now(Kind.EMBEDDING))


def _remove_stale_now(kind: Kind) -> list[str]:
    current = rag_settings.load_settings()
    reranker_on = not rag_rerank.is_disabled(current.rerank_model)
    # Turning the reranker off is not a switch to another model: its
    # weights stay, so turning it back on needs no download.
    if kind is Kind.RERANKER and not reranker_on:
        return []
    keep = [current.embed_model, *([current.rerank_model] if reranker_on else [])]
    # Windows cannot delete files an ONNX session holds open, so the
    # cached encoder goes first; the next search loads it again.
    (rag_embed_local if kind is Kind.EMBEDDING else rag_rerank).reset_cache()
    return remove_unused(kind, keep)


def remove_unused(kind: Kind, keep: Iterable[str], models: Path | None = None) -> list[str]:
    """Delete the weights of every `kind` model not in `keep`.

    `keep` is every model the settings name, embedding and reranker
    alike, so a folder one of them uses is never removed. Returns the
    folder names removed. A folder that cannot be removed (Windows
    refuses while an encoder still has its files open) stays, and the
    next switch tries again.
    """
    folder = models or models_dir()
    if not folder.is_dir():
        return []
    catalogue = _catalogue()
    keep = set(keep)
    kept = {
        name for _, m in catalogue if m["model"] in keep for name in _folder_names(m)
    }
    unused = {
        name
        for model_kind, m in catalogue
        if model_kind is kind and m["model"] not in keep
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


def _catalogue() -> list[tuple[Kind, dict[str, Any]]]:
    """Every model fastembed offers, with its kind."""
    # Imported lazily: fastembed pulls in onnxruntime, which only a
    # model change needs here.
    from fastembed import TextEmbedding
    from fastembed.rerank.cross_encoder import TextCrossEncoder

    return [(Kind.EMBEDDING, m) for m in TextEmbedding.list_supported_models()] + [
        (Kind.RERANKER, m) for m in TextCrossEncoder.list_supported_models()
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
