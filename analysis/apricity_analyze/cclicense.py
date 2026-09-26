"""Which licenses Apricity can sample from. Mirrors web/src/data/licenses.ts.

Sampling means slicing, warping and re-pitching, so no-derivatives (ND) is out, and non-commercial
(NC) would tie every score to non-commercial use. Allowed: public domain, CC0, CC BY, CC BY-SA."""
from __future__ import annotations

import re

NAMES = {"public-domain": "Public domain", "cc0-1.0": "CC0 1.0", "cc-by-3.0": "CC BY 3.0", "cc-by-4.0": "CC BY 4.0",
         "cc-by-sa-3.0": "CC BY-SA 3.0", "cc-by-sa-4.0": "CC BY-SA 4.0"}


def classify(url: str | None) -> tuple[str | None, str]:
    """(license code or None, plain reason). Code is None when Apricity can't use it."""
    u = (url or "").lower().strip()
    if not u:
        return None, "no license stated"
    if "publicdomain/zero" in u:
        return "cc0-1.0", "CC0"
    if "publicdomain/mark" in u:
        return "public-domain", "public domain"
    m = re.search(r"creativecommons\.org/licenses/([a-z-]+)/(\d\.\d)", u)
    if not m:
        return None, "unrecognized license"
    kind, ver = m.groups()
    if "nd" in kind.split("-"):
        return None, f"CC {kind.upper()}: no derivatives"
    if "nc" in kind.split("-"):
        return None, f"CC {kind.upper()}: non-commercial"
    if kind in ("by", "by-sa") and ver in ("3.0", "4.0"):
        return f"cc-{kind}-{ver}", f"CC {kind.upper()} {ver}"
    return None, f"CC {kind.upper()} {ver}: version not supported"
