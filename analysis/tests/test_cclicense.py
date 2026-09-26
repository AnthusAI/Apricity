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
