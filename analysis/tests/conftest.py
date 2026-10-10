"""`lab`'s commands import `scripts` (a namespace package, e.g. `from scripts import optimize`) to
reuse `scripts/optimize.py`/`scripts/explore.py`'s own `main(argv)` without re-implementing them.
That only resolves when the repo root is on `sys.path`, which pytest doesn't add on its own when
run from `analysis/` (only `analysis/` itself, via rootdir insertion)."""

import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
