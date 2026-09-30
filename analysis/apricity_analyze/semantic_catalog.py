"""Export canonical native-library records without guessing identifiers or file refs."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


TABLES = (("Sample", "samples"), ("Clip", "clips"), ("Recording", "recordings"))


def _read_rows(root: Path, table: str, excluded: list[dict[str, str]]) -> list[dict[str, Any]]:
    rows = []
    directory = root / table
    if not directory.is_dir():
        excluded.append({"kind": table.lower(), "reason": "missing_native_table"})
        return rows
    try:
        native_root, directory = root.resolve(strict=True), directory.resolve(strict=True)
        directory.relative_to(native_root)
    except (OSError, ValueError):
        excluded.append({"kind": table.lower(), "reason": "unsafe_native_table"})
        return rows
    ids: set[str] = set()
    for source in sorted(directory.glob("*.json")):
        try:
            source.resolve(strict=True).relative_to(directory)
        except (OSError, ValueError):
            excluded.append({"kind": table.lower(), "reason": "unsafe_native_table_row", "source": source.name})
            continue
        try:
            value = json.loads(source.read_text())
        except (OSError, json.JSONDecodeError):
            excluded.append({"kind": table.lower(), "reason": "invalid_native_json", "source": source.name})
            continue
        if not isinstance(value, dict) or not isinstance(value.get("id"), str) or not value["id"]:
            excluded.append({"kind": table.lower(), "reason": "missing_native_id", "source": source.name})
            continue
        if value["id"] in ids:
            excluded.append({"kind": table.lower(), "reason": "duplicate_native_id", "source": source.name})
            continue
        ids.add(value["id"])
        rows.append(value)
    return rows


def _analysis(root: Path, sample: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    ref = sample.get("analysis")
    if not isinstance(ref, dict) or not isinstance(ref.get("key"), str) or not isinstance(ref.get("sha256"), str):
        return None, "missing_analysis_file_ref"
    key = Path(ref["key"])
    if key.is_absolute() or ".." in key.parts:
        return None, "unsafe_analysis_file_ref"
    try:
        path = (root / "files" / key).resolve(strict=True)
        path.relative_to((root / "files").resolve(strict=True))
    except FileNotFoundError:
        return None, "missing_analysis_file"
    except (OSError, ValueError):
        return None, "unsafe_analysis_file_ref"
    try:
        raw = path.read_bytes()
    except OSError:
        return None, "unreadable_analysis_file"
    if hashlib.sha256(raw).hexdigest() != ref["sha256"]:
        return None, "analysis_sha256_mismatch"
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return None, "invalid_analysis_json"
    return value if isinstance(value, dict) else None, None if isinstance(value, dict) else "invalid_analysis_json"


def export_catalog(library: str | Path) -> dict[str, Any]:
    """Read only native root tables and safe analysis FileRefs into ``load_catalog`` shape."""
    root, excluded = Path(library), []
    if not root.is_dir():
        return {"catalog": {"samples": [], "clips": [], "recordings": [], "analyses": {}},
                "excluded": [{"kind": "library", "reason": "missing_library_root"}]}
    values = {name: _read_rows(root, table, excluded) for table, name in TABLES}
    analyses = {}
    for sample in values["samples"]:
        manifest, reason = _analysis(root, sample)
        if reason:
            excluded.append({"kind": "analysis", "sampleId": sample["id"], "reason": reason})
        else:
            analyses[sample["id"]] = manifest
    return {"catalog": {**values, "analyses": analyses}, "excluded": excluded}
