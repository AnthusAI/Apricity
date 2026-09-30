import hashlib
import json

import numpy as np
import pytest

from apricity_analyze import clap
from apricity_analyze.semantic_records import load_catalog, materialize_sidecar


SHA = "a" * 64
FINGERPRINT = "processing-v1"


def unit(index=0):
    vector = np.zeros(512, dtype=np.float32)
    vector[index] = 1
    return vector


def grid(manifest):
    values = {key: manifest["rhythm"].get(key) for key in ("bpm", "meter", "beats", "downbeats")}
    return hashlib.sha256(json.dumps(values, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def canonical_catalog(*, clips=None, aliases=None, tags=None, analysis=None):
    return {
        "samples": [{"id": "smp_A", "recordingId": "rec_R1", "path": "library/a.wav", "aliases": aliases or [],
                     "title": "Current sample", "tags": ["drum"] if tags is None else tags, "audio": {"key": "audio/current.wav", "sha256": SHA}, "duration": 8}],
        "clips": clips if clips is not None else [{"id": "clp_A", "sampleId": "smp_A", "name": "Renamed clip", "kind": "loop", "start": 0, "end": 4}],
        "recordings": [{"id": "rec_R1", "title": "Recording"}],
        "analyses": {"smp_A": analysis} if analysis is not None else {},
    }


def write_v2(tmp_path, *, clip_ref="id:clp_A", clip_bounds=(0, 4), windows=True, sha=SHA, vector=None, manifest=None):
    audio_path = tmp_path / "library" / "a.wav"
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    audio_path.write_bytes(b"audio")
    manifest_path = audio_path.with_name("a.wav.apricity.json")
    manifest = manifest or {"source": {"sha256": sha}, "duration": 8, "rhythm": {"bpm": 120, "meter": [4, 4], "beats": list(range(9)), "downbeats": [0, 1, 2, 3, 4]}}
    manifest_path.write_text(json.dumps(manifest))
    clips = [{**({"id": clip_ref[3:]} if clip_ref.startswith("id:") else {"source_ref": clip_ref}), "name": "stale name", "start": clip_bounds[0], "end": clip_bounds[1]}]
    window_list = [clap.Window(0, 4, 0, 4)] if windows else []
    clap.write_sidecar_v2(clap.sidecar_path_for(manifest_path), sha256=sha, clips=clips,
                          clip_embeddings=np.array([vector if vector is not None else unit()]), windows=window_list,
                          window_embeddings=np.array([unit(1)] if windows else []).reshape((len(window_list), 512)),
                          processing_fingerprint=FINGERPRINT, window_grid_fingerprint=grid(manifest))
    return manifest_path, manifest


def materialize(path, catalog):
    return materialize_sidecar(path, load_catalog(catalog), "2026-09-30T12:00:00Z",
                               expected_processing_fingerprint=FINGERPRINT, samples_root=path.parents[1])


def test_materializes_current_metadata_and_preserves_rename_revision(tmp_path):
    path, manifest = write_v2(tmp_path)
    result = materialize(path, canonical_catalog(analysis=manifest))

    assert result["excluded"] == []
    assert result["coverage"] == {"records": 2, "excluded": 0}
    saved, window = result["records"]
    assert saved["identity"]["clipId"] == "clp_A"
    assert saved["display"] == {"samplePath": "library/a.wav", "sampleTitle": "Current sample", "clipName": "Renamed clip", "clipKind": "loop", "tags": ["drum"]}
    assert saved["playback"] == {"fileKey": "audio/current.wav", "start": 0.0, "end": 4.0}
    assert saved["metadataUpdatedAt"] == "2026-09-30T12:00:00Z"
    assert saved["revision"] == hashlib.sha256(json.dumps([saved["identity"]["semanticId"], ""], separators=(",", ":")).encode()).hexdigest()
    assert window["revision"] == hashlib.sha256(json.dumps([window["identity"]["semanticId"], grid(manifest)], separators=(",", ":")).encode()).hexdigest()


@pytest.mark.parametrize("catalog, reason", [
    (canonical_catalog(clips=[]), "missing_clip_mapping"),
    (canonical_catalog(clips=[{"id": "clp_A", "sampleId": "smp_A", "name": "x", "start": 0, "end": 4, "retired": True}]), "retired_clip"),
    (canonical_catalog(clips=[{"id": "clp_A", "sampleId": "smp_A", "name": "x", "start": 0, "end": 3}]), "clip_boundary_mismatch"),
])
def test_saved_regions_exclude_missing_retired_or_changed_canonical_clips(tmp_path, catalog, reason):
    path, manifest = write_v2(tmp_path)
    catalog["analyses"] = {"smp_A": manifest}
    result = materialize(path, catalog)
    assert reason in {entry["reason"] for entry in result["excluded"]}
    assert all(record["identity"]["kind"] == "window" for record in result["records"])


def test_alias_source_bounds_must_select_one_live_clip_and_parent_path_must_be_unique(tmp_path):
    path, manifest = write_v2(tmp_path, clip_ref="alias:old")
    clips = [{"id": "one", "sampleId": "smp_A", "source_ref": "alias:old", "name": "one", "start": 0, "end": 4}, {"id": "two", "sampleId": "smp_A", "source_ref": "alias:old", "name": "two", "start": 0, "end": 4}]
    result = materialize(path, canonical_catalog(clips=clips, analysis=manifest))
    assert "ambiguous_clip_mapping" in {entry["reason"] for entry in result["excluded"]}

    duplicated = canonical_catalog(analysis=manifest)
    duplicated["samples"].append({**duplicated["samples"][0], "id": "smp_B"})
    result = materialize(path, duplicated)
    assert result["records"] == []
    assert {entry["reason"] for entry in result["excluded"]} == {"ambiguous_sample_mapping"}

    missing_parent = canonical_catalog(analysis=manifest)
    missing_parent["recordings"] = []
    result = materialize(path, missing_parent)
    assert {entry["reason"] for entry in result["excluded"]} == {"missing_recording_mapping"}


def test_rejects_legacy_provenance_invalid_vectors_duration_and_stale_grid(tmp_path):
    path, manifest = write_v2(tmp_path)
    # The real writer rejects invalid vectors; make the v2 sidecar malformed after its valid write.
    with np.load(clap.sidecar_path_for(path), allow_pickle=False) as z:
        payload = {key: z[key] for key in z.files}
    payload["clip_embeddings"] = np.zeros((1, 512), dtype=np.float32)
    np.savez_compressed(clap.sidecar_path_for(path), **payload)
    stale_analysis = {**manifest, "rhythm": {**manifest["rhythm"], "bpm": 121}}
    result = materialize(path, canonical_catalog(analysis=stale_analysis))
    assert {entry["reason"] for entry in result["excluded"]} >= {"invalid_vector", "stale_window_grid"}

    np.savez_compressed(clap.sidecar_path_for(path), sha256=np.array(SHA))
    result = materialize(path, canonical_catalog(analysis=manifest))
    assert result["records"] == []
    assert {entry["reason"] for entry in result["excluded"]} == {"legacy_sidecar"}


def test_excludes_sidecars_whose_audio_hash_is_not_the_current_canonical_audio(tmp_path):
    path, manifest = write_v2(tmp_path, sha="b" * 64)
    result = materialize(path, canonical_catalog(analysis=manifest))
    assert result["records"] == []
    assert {entry["reason"] for entry in result["excluded"]} == {"stale_provenance"}


def test_exact_root_mapping_rejects_same_basename_elsewhere_and_requires_root(tmp_path):
    path, manifest = write_v2(tmp_path)
    wrong = canonical_catalog(analysis=manifest)
    wrong["samples"][0]["path"] = "other/a.wav"
    (tmp_path / "other").mkdir()
    (tmp_path / "other" / "a.wav").write_bytes(b"other")
    assert {entry["reason"] for entry in materialize(path, wrong)["excluded"]} == {"missing_sample_mapping"}
    result = materialize_sidecar(path, load_catalog(canonical_catalog(analysis=manifest)), "2026-09-30T12:00:00Z",
                                 expected_processing_fingerprint=FINGERPRINT)
    assert {entry["reason"] for entry in result["excluded"]} == {"samples_root_required"}


def test_nullable_metadata_and_optional_clip_kind_are_normalized_but_invalid_metadata_is_reported(tmp_path):
    path, manifest = write_v2(tmp_path)
    catalog = canonical_catalog(analysis=manifest)
    catalog["samples"][0]["aliases"] = None
    catalog["samples"][0]["tags"] = None
    catalog["clips"][0].pop("kind")
    saved = materialize(path, catalog)["records"][0]
    assert saved["display"] == {"samplePath": "library/a.wav", "sampleTitle": "Current sample", "clipName": "Renamed clip", "tags": []}
    catalog["samples"][0]["tags"] = "not-tags"
    assert "invalid_metadata" in {entry["reason"] for entry in materialize(path, catalog)["excluded"]}


def test_display_metadata_preserves_schema_permitted_empty_strings_and_normalizes_null_title(tmp_path):
    path, manifest = write_v2(tmp_path)
    catalog = canonical_catalog(analysis=manifest, aliases=None, tags=None)
    catalog["samples"][0].update({"title": None, "tags": None})
    catalog["clips"][0].update({"name": "", "kind": ""})
    saved = materialize(path, catalog)["records"][0]
    assert saved["display"] == {
        "samplePath": "library/a.wav", "sampleTitle": "", "clipName": "", "clipKind": "", "tags": [],
    }
    catalog["samples"][0].pop("title")
    assert materialize(path, catalog)["records"][0]["display"] == saved["display"]


@pytest.mark.parametrize("field, value", [
    ("title", 7),
    ("tags", ["drum", 7]),
    ("aliases", ["library/a.wav", 7]),
])
def test_invalid_display_metadata_types_are_excluded_before_record_contracts(field, value, tmp_path):
    path, manifest = write_v2(tmp_path)
    catalog = canonical_catalog(analysis=manifest)
    catalog["samples"][0][field] = value
    result = materialize(path, catalog)
    assert result["records"] == []
    assert {entry["reason"] for entry in result["excluded"]} == {"invalid_metadata"}


def test_invalid_canonical_bounds_are_excluded_without_rounding_crash(tmp_path):
    path, manifest = write_v2(tmp_path)
    catalog = canonical_catalog(analysis=manifest)
    catalog["clips"][0]["start"] = "bad"
    result = materialize(path, catalog)
    assert "invalid_canonical_bounds" in {entry["reason"] for entry in result["excluded"]}
    assert all(row["identity"]["kind"] == "window" for row in result["records"])


def test_unknown_source_refs_are_rejected(tmp_path):
    path, manifest = write_v2(tmp_path, clip_ref="alias:unknown")
    result = materialize(path, canonical_catalog(analysis=manifest))
    assert "missing_clip_mapping" in {entry["reason"] for entry in result["excluded"]}


def test_each_corrupt_region_is_excluded_and_windows_must_be_in_current_grid(tmp_path):
    path, manifest = write_v2(tmp_path)
    sidecar = clap.sidecar_path_for(path)
    with np.load(sidecar, allow_pickle=False) as z:
        payload = {key: z[key] for key in z.files}
    payload["clip_fingerprints"] = np.array(["corrupt"])
    payload["window_start_s"] = np.array([1.0])
    payload["window_end_s"] = np.array([2.0])
    payload["window_fingerprints"] = np.array([clap._region_fingerprint("window", "window:0", 1.0, 2.0, SHA, FINGERPRINT, grid(manifest))])
    np.savez_compressed(sidecar, **payload)
    result = materialize(path, canonical_catalog(analysis=manifest))
    reasons = {entry["reason"] for entry in result["excluded"]}
    assert {"corrupt_region_fingerprint", "window_outside_current_grid"} <= reasons
    assert result["records"] == []


def test_missing_region_fingerprints_are_explicitly_excluded(tmp_path):
    path, manifest = write_v2(tmp_path)
    sidecar = clap.sidecar_path_for(path)
    with np.load(sidecar, allow_pickle=False) as z:
        payload = {key: z[key] for key in z.files if key not in {"clip_fingerprints", "window_fingerprints"}}
    np.savez_compressed(sidecar, **payload)
    reasons = {entry["reason"] for entry in materialize(path, canonical_catalog(analysis=manifest))["excluded"]}
    assert {"missing_clip_fingerprint", "missing_window_fingerprint"} <= reasons


def test_real_before_after_rename_keeps_identity_and_revision_and_refreshes_name(tmp_path):
    path, manifest = write_v2(tmp_path)
    before = materialize(path, canonical_catalog(analysis=manifest))["records"][0]
    renamed = canonical_catalog(analysis=manifest)
    renamed["clips"][0]["name"] = "Actually renamed"
    after = materialize(path, renamed)["records"][0]
    assert (before["identity"]["semanticId"], before["revision"]) == (after["identity"]["semanticId"], after["revision"])
    assert after["display"]["clipName"] == "Actually renamed"
