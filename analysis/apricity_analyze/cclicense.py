"""Which licenses Apricity can sample from. Mirrors web/src/data/licenses.ts.

Sampling means slicing, warping and re-pitching, so no-derivatives (ND) is out, and non-commercial
(NC) would tie every score to non-commercial use. Allowed: public domain, CC0, CC BY, CC BY-SA."""
from __future__ import annotations

import re

NAMES = {"public-domain": "Public domain", "cc0-1.0": "CC0 1.0", "cc-by-3.0": "CC BY 3.0", "cc-by-4.0": "CC BY 4.0",
         "cc-by-sa-3.0": "CC BY-SA 3.0", "cc-by-sa-4.0": "CC BY-SA 4.0",
         "public-domain-statement": "Public domain (stated, not a CC/PDM URL)"}


def classify(url: str | None) -> tuple[str | None, str]:
    """(license code or None, plain reason). Code is None when Apricity can't use it.

    `"public-domain-statement"` (round 3, Kanbus apricitus-a9ad5b review): a free-text `rights`
    field that plainly states public domain, not a `creativecommons.org`/`publicdomain.zero`
    *URL* -- e.g. `sources.json`'s real entries for `loc/`, `citizen-dj/` and `marine-band/`:
      "Public domain (composition pre-1923; recording is a work of the U.S. Government)."
      "Public domain (Edison recordings 1890-1929; assets transferred to the National Park Service)."
      "No known U.S. copyright or other restrictions per the Library of Congress (AFC 1939/001);
       privacy and publicity rights may apply."
    Before this, `classify()` only recognized CC/PDM *URLs*, so every one of the above came back
    "unrecognized license" -- confirmed by inspection: this is why `region_candidates()`'s
    `_license_ok` rejected every non-ccMixter sample even after widening its directory scan
    (apricitus-a9ad5b round 2's report). Matched case-insensitively on the statement *starting*
    with "public domain" (so a caveat like the LoC one above, or "no known copyright", is not
    swept in by this rule alone) or containing "work of the u.s. government" anywhere (a federal
    government work is public domain by statute, 17 U.S.C. Sec. 105, regardless of where the
    phrase sits in the sentence). Every other free-text statement -- including "no known
    copyright... privacy and publicity rights may apply", which hedges -- still falls through to
    "unrecognized license" below, unchanged."""
    raw = (url or "").strip()
    u = raw.lower()
    if not u:
        return None, "no license stated"
    if "publicdomain/zero" in u:
        return "cc0-1.0", "CC0"
    if "publicdomain/mark" in u:
        return "public-domain", "public domain"
    if u.startswith("public domain") or "work of the u.s. government" in u:
        return "public-domain-statement", "public domain (stated)"
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


def seconds(duration: str | None) -> float | None:
    """"3:46" or "1:35:48" -> seconds; None when unknown."""
    parts = [int(x) for x in re.findall(r"\d+", duration or "")]
    if not parts or len(parts) > 3:
        return None
    total = 0
    for x in parts:
        total = total * 60 + x
    return float(total)
