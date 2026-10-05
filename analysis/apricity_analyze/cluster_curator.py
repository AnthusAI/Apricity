"""Private curator preview and publication façade for cluster drafts.

This is intentionally transport-free.  An HTTP/native adapter must construct
``actor`` from verified server identity, never from browser JSON, and must not
mount these operations below the public ``/semantic/clusters`` route.
"""
from __future__ import annotations

import copy
from typing import Any, Callable, Mapping

from .cluster_corpus import build_cluster_snapshot
from .cluster_exploration import ClusterExploration, ExplorationStorageUnavailable
from .cluster_publication import ClusterPublicationRegistry, PublicationError


class CuratorPreviewError(Exception):
    """A sanitized error for a private transport adapter."""


class CuratorClusterService:
    """Project a current, curator-only draft preview and delegate mutations.

    The service deliberately shares the canonical corpus/catalog/visibility
    checks with public exploration, but it never invokes the public registry
    lookup and it emits no vectors, map coordinates, publication audit, or
    worker lease data.  A draft therefore stays invisible to public readers.
    """

    def __init__(self, registry: ClusterPublicationRegistry, corpus: Callable[[], object],
                 catalog: Callable[[], object], *, visibility: Callable[..., object]):
        if not isinstance(registry, ClusterPublicationRegistry):
            raise TypeError("registry must be a ClusterPublicationRegistry")
        if not all(callable(value) for value in (corpus, catalog, visibility)):
            raise TypeError("current providers and visibility are required")
        self.registry, self.corpus_provider, self.catalog_provider = registry, corpus, catalog
        self.visibility = visibility

    def _current_digest(self) -> str:
        envelope, catalog = self.corpus_provider(), self.catalog_provider()
        if not isinstance(envelope, Mapping) or not isinstance(catalog, Mapping):
            raise CuratorPreviewError("current cluster data is unavailable")
        records = envelope.get("records")
        space, fingerprint = envelope.get("embeddingSpace"), envelope.get("processingFingerprint")
        if not isinstance(records, list) or not isinstance(space, str) or not space or not isinstance(fingerprint, str) or not fingerprint:
            raise CuratorPreviewError("current cluster data is unavailable")
        try:
            snapshot = build_cluster_snapshot(records, dict(catalog), embedding_space=space,
                                              processing_fingerprint=fingerprint, visibility=self.visibility)
            digest = snapshot.get("corpusDigest")
        except Exception as error:
            raise CuratorPreviewError("current cluster data is unavailable") from error
        if not isinstance(digest, str):
            raise CuratorPreviewError("current cluster data is unavailable")
        return digest

    def control(self, actor: object, run_id: object) -> dict[str, Any]:
        """Ensure and return the revisioned private control record."""
        control = self.registry.initialize(actor, run_id)
        pointer = self.registry.pointer_revision(actor)
        return {"runId": control["runId"], "runRevision": control["runRevision"],
                "overrides": copy.deepcopy(control["overrides"]), "review": copy.deepcopy(control["review"]),
                "pointerRevision": pointer if pointer else None}

    def preview(self, actor: object, run_id: object) -> dict[str, Any]:
        """Return playable, current cards for draft representatives only.

        This is enough evidence for a curator to listen and review without
        leaking an entire draft corpus or its display geometry.
        """
        control = self.control(actor, run_id)
        manifest = self.registry.draft_manifest(actor, run_id)
        # Reuse exactly the current-canonical card construction used by the
        # public boundary, but never call its published lookup.
        explorer = ClusterExploration(self.registry, self.corpus_provider, self.catalog_provider,
                                      visibility=self.visibility, ratings=lambda: {}, enabled=True)
        try:
            _envelope, catalog, snapshot = explorer._current(manifest)
        except ExplorationStorageUnavailable as error:
            raise CuratorPreviewError("current cluster data is unavailable") from error
        samples, clips = explorer._catalog_rows(catalog)
        current_cards: dict[str, dict[str, Any]] = {}
        for region in snapshot["regions"]:
            for alias in region["aliases"]:
                card = explorer._card(alias, samples, clips)
                if card is not None:
                    current_cards[card["semanticId"]] = card
        clusters = []
        for cluster in manifest["clusters"]:
            cluster_id = cluster["clusterId"]
            suggested = cluster.get("suggestedLabel")
            label = suggested.get("label") if isinstance(suggested, Mapping) and isinstance(suggested.get("label"), str) else None
            override = control["overrides"].get(cluster_id)
            curated = override.get("label") if isinstance(override, Mapping) and isinstance(override.get("label"), str) else None
            representatives = []
            seen: set[str] = set()
            for representative in cluster.get("representatives", []):
                semantic_id = representative.get("semanticId") if isinstance(representative, Mapping) else None
                if isinstance(semantic_id, str) and semantic_id in current_cards and semantic_id not in seen:
                    representatives.append(copy.deepcopy(current_cards[semantic_id])); seen.add(semantic_id)
            clusters.append({"clusterId": cluster_id, "suggestedLabel": label, "curatedLabel": curated,
                             "representatives": representatives})
        return {"runId": manifest["runId"], "preset": manifest["preset"], "state": "draft",
                "runRevision": control["runRevision"], "pointerRevision": control["pointerRevision"],
                "review": copy.deepcopy(control["review"]), "clusters": clusters}

    def override(self, actor: object, run_id: object, cluster_id: object, label: object, *, expected_run_revision: object) -> dict[str, Any]:
        return self.registry.override(actor, run_id, cluster_id, label, expected_run_revision=expected_run_revision)

    def review(self, actor: object, run_id: object, reviewed_semantic_ids: object, notes: object, *, expected_run_revision: object) -> dict[str, Any]:
        return self.registry.review(actor, run_id, reviewed_semantic_ids, notes, expected_run_revision=expected_run_revision)

    def publish(self, actor: object, run_id: object, *, expected_run_revision: object,
                expected_pointer_revision: object) -> dict[str, Any]:
        # The registry receives its current-digest provider at startup.  Do
        # not replace that shared callable per request: doing so would create a
        # publication race between concurrent curator requests.
        return self.registry.publish(actor, run_id, expected_run_revision=expected_run_revision,
                                     expected_pointer_revision=expected_pointer_revision)
