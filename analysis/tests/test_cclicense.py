import pytest

from apricity_analyze import cclicense


@pytest.mark.parametrize("url,code", [
    ("http://creativecommons.org/publicdomain/zero/1.0/", "cc0-1.0"),
    ("https://creativecommons.org/publicdomain/mark/1.0/", "public-domain"),
    ("http://creativecommons.org/licenses/by/3.0/", "cc-by-3.0"),
    ("https://creativecommons.org/licenses/by/4.0/legalcode", "cc-by-4.0"),
    ("http://creativecommons.org/licenses/by-sa/3.0/", "cc-by-sa-3.0"),
])
def test_licenses_we_can_sample_from(url, code):
    assert cclicense.classify(url)[0] == code


@pytest.mark.parametrize("url,why", [
    ("http://creativecommons.org/licenses/by-nc/3.0/", "non-commercial"),
    ("http://creativecommons.org/licenses/by-nd/4.0/", "no derivatives"),
    ("http://creativecommons.org/licenses/by-nc-sa/3.0/", "non-commercial"),
    ("http://creativecommons.org/licenses/by-nc-nd/4.0/", "no derivatives"),
    ("http://creativecommons.org/licenses/by/2.0/", "version"),
    ("", "no license"),
    ("http://example.com/terms", "unrecognized"),
])
def test_licenses_we_refuse_say_why(url, why):
    code, reason = cclicense.classify(url)
    assert code is None and why in reason


# Round 3 (Kanbus apricitus-a9ad5b review): free-text `rights` statements, taken verbatim from
# samples/sources.json's real loc/, citizen-dj/ and marine-band/ entries (confirmed by inspection
# during the review), not URLs -- `classify()` only recognized CC/PDM URLs before this.
@pytest.mark.parametrize("rights,code", [
    ("Public domain (composition pre-1923; recording is a work of the U.S. Government).", "public-domain-statement"),  # marine-band
    ("Public domain (Edison recordings 1890-1929; assets transferred to the National Park Service).", "public-domain-statement"),  # citizen-dj
    ("Public domain (published before 1923; Music Modernization Act).", "public-domain-statement"),  # citizen-dj
    ("Public domain (published 1923-1925; 100 years since publication, Music Modernization Act).", "public-domain-statement"),  # loc
    ("PUBLIC DOMAIN (case-insensitive match)", "public-domain-statement"),
    ("Recorded in 1975; a work of the U.S. Government per federal statute.", "public-domain-statement"),  # mid-sentence match
])
def test_free_text_public_domain_statements_are_recognized(rights, code):
    assert cclicense.classify(rights)[0] == code


@pytest.mark.parametrize("rights", [
    # loc: hedged ("may apply"), does not plainly state public domain -- stays rejected
    "No known U.S. copyright or other restrictions per the Library of Congress (AFC 1939/001); privacy and publicity rights may apply.",
    # citizen-dj: "free to use" is not "public domain" and doesn't name the U.S. Government
    "Free to use and reuse per the Library of Congress (Citizen DJ selection).",
])
def test_free_text_that_only_hedges_or_says_free_to_use_still_unrecognized(rights):
    code, reason = cclicense.classify(rights)
    assert code is None and "unrecognized" in reason


def test_source_json_folders_now_pass_the_license_filter():
    """End-to-end: every real `loc/`, `citizen-dj/` and `marine-band/` rights string this repo's
    `samples/sources.json` actually carries (as of the apricitus-a9ad5b round-2 report) now
    resolves through the same path `explore.candidates._license_ok` uses, confirming the
    directory-widening from round 2 can actually reach non-ccMixter families now that this
    module recognizes their license statements."""
    import json
    import pathlib

    sources = pathlib.Path(__file__).resolve().parents[2] / "samples" / "sources.json"
    if not sources.exists():
        pytest.skip("samples/sources.json not present in this checkout")
    entries = json.loads(sources.read_text()).get("files", [])
    by_folder = {}
    for e in entries:
        folder = e["path"].split("/", 1)[0]
        if folder in ("loc", "citizen-dj", "marine-band"):
            by_folder.setdefault(folder, []).append(e)
    assert by_folder, "expected at least one loc/citizen-dj/marine-band entry in sources.json"
    for folder, folder_entries in by_folder.items():
        ok_count = sum(1 for e in folder_entries if cclicense.classify(e.get("rights"))[0] is not None)
        assert ok_count > 0, f"{folder}: no entry passes the license filter even after the round-3 fix"


@pytest.mark.parametrize("text,secs", [("3:46", 226.0), ("1:35:48", 5748.0), ("0:37", 37.0), ("", None), (None, None)])
def test_durations_read_as_seconds(text, secs):
    assert cclicense.seconds(text) == secs


def test_the_analyzer_refuses_long_recordings(tmp_path, capsys):
    import numpy as np
    import soundfile as sf

    from apricity_analyze import cli

    f = tmp_path / "set.wav"
    sf.write(str(f), np.zeros(8000 * 60 * 12, dtype="float32"), 8000)
    assert cli.main(["--no-notes", str(f)]) == 1
    assert "TOO LONG" in capsys.readouterr().err and not (tmp_path / "set.wav.apricity.json").exists()
