"""Loads a `scripts/*.py` file whose name isn't a valid Python identifier (it has a hyphen), so
its `main(argv)` can be called directly instead of re-implementing it. Only used for scripts that
predate `lab` and haven't been folded into an `apricity_analyze` module -- prefer a normal import
(`from scripts import optimize`) when the name has no hyphen."""

from __future__ import annotations

import importlib.util
import pathlib
import types

_CACHE: dict[str, types.ModuleType] = {}


def load_script(repo_root: pathlib.Path, name: str) -> types.ModuleType:
    """`name` without `.py`, e.g. `"fit-features"` for `scripts/fit-features.py`."""
    if name in _CACHE:
        return _CACHE[name]
    path = repo_root / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _CACHE[name] = module
    return module
