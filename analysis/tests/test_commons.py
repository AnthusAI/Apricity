from apricity_analyze import commons
import http.client
import urllib.error
from email.message import Message


def page(title="File:Solarity.ogg", pageid=123, mime="application/ogg", license_name="CC BY-SA 4.0", author="MJ-PIA"):
    return {
        "pageid": pageid,
        "title": title,
        "imageinfo": [{
            "url": f"https://upload.wikimedia.org/{title.replace(' ', '_')}",
            "mime": mime,
            "size": 42,
            "sha1": "0123456789abcdef",
            "extmetadata": {
                "ObjectName": {"value": "Solarity"},
                "Artist": {"value": author},
                "LicenseShortName": {"value": license_name},
                "LicenseUrl": {"value": "https://creativecommons.org/licenses/by-sa/4.0/"},
                "UsageTerms": {"value": license_name},
            },
        }],
        "revisions": [{"revid": 456, "timestamp": "2026-01-02T03:04:05Z", "slots": {"main": {"content": "{{Cc-by-sa-4.0}}"}}}],
    }


def test_category_membership_deduplicates_pages_but_keeps_all_categories():
    memberships = commons.merge_memberships([
        ("Category:Audio files of electronic music", [{"pageid": 123, "title": "File:Solarity.ogg"}]),
        ("Category:Techno music samples", [{"pageid": 123, "title": "File:Solarity.ogg"}, {"pageid": 124, "title": "File:Acid.ogg"}]),
    ])
    assert list(memberships) == [123, 124]
    assert memberships[123]["categories"] == ["Category:Audio files of electronic music", "Category:Techno music samples"]
    assert memberships[124]["categories"] == ["Category:Techno music samples"]


def test_supported_cc_license_requires_creator_and_keeps_raw_revision_metadata():
    decision = commons.qualify_page(page(), ["Category:Techno music samples"])
    assert decision.eligible
    assert decision.record["license"] == "cc-by-sa-4.0"
    assert decision.record["license_url"] == "https://creativecommons.org/licenses/by-sa/4.0/"
    assert decision.record["author"] == "MJ-PIA"
    assert "Solarity" in decision.record["attribution"]
    assert "MJ-PIA" in decision.record["attribution"]
    assert decision.record["source_page"] in decision.record["attribution"]
    assert decision.record["license_url"] in decision.record["attribution"]
    snapshot = decision.record["source_metadata"]
    assert snapshot["pageid"] == 123
    assert snapshot["revision_id"] == 456
    assert snapshot["raw_wikitext"] == "{{Cc-by-sa-4.0}}"
    assert snapshot["extmetadata"]["LicenseShortName"]["value"] == "CC BY-SA 4.0"


def test_generated_attribution_keeps_title_author_and_explicit_credit():
    candidate = page()
    candidate["imageinfo"][0]["extmetadata"]["Credit"] = {"value": "Original track credit: studio archive"}
    decision = commons.qualify_page(candidate, ["Category:Techno music samples"])

    line = decision.record["attribution"]
    assert "Solarity" in line
    assert "MJ-PIA" in line
    assert "studio archive" in line
    assert decision.record["source_page"] in line
    assert decision.record["license_url"] in line
    assert "re-pitched in Apricity" in line


def test_missing_required_author_or_unknown_license_is_excluded_with_reason():
    no_author = commons.qualify_page(page(author=""), [])
    unsupported = commons.qualify_page(page(license_name="GFDL"), [])
    assert not no_author.eligible and "author" in no_author.reason.lower()
    assert not unsupported.eligible and "unsupported" in unsupported.reason.lower()
    conflict = page()
    conflict["imageinfo"][0]["extmetadata"]["LicenseShortName"]["value"] = "GFDL"
    assert not commons.qualify_page(conflict, []).eligible


def test_video_container_is_excluded_even_when_it_has_an_audio_track():
    video = page(title="File:Demo.webm", mime="video/webm")
    decision = commons.qualify_page(video, [])
    assert not decision.eligible
    assert "video" in decision.reason.lower()


def test_commons_paths_are_stable_and_unique_by_page_id():
    a = commons.catalog_record(page(), ["Category:Techno music samples"])
    b = commons.catalog_record(page(title="File:Another name.ogg", pageid=124), ["Category:Techno music samples"])
    assert a["path"].startswith("wikimedia-commons/123/")
    assert a["path"] != b["path"]


def test_license_normalization_covers_existing_apricity_codes():
    cases = [
        ("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/", "cc0-1.0"),
        ("CC BY 3.0", "https://creativecommons.org/licenses/by/3.0/", "cc-by-3.0"),
        ("CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/", "cc-by-4.0"),
        ("CC BY-SA 3.0", "https://creativecommons.org/licenses/by-sa/3.0/", "cc-by-sa-3.0"),
        ("Public domain", "", "public-domain"),
    ]
    for name, url, expected in cases:
        assert commons.normalize_license(name, url, "") == (expected, url or None)


def test_complete_supported_license_metadata_is_eligible():
    cases = [
        ("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/", "cc0-1.0", ""),
        ("CC BY 3.0", "https://creativecommons.org/licenses/by/3.0/", "cc-by-3.0", "MJ-PIA"),
        ("CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/", "cc-by-4.0", "MJ-PIA"),
        ("CC BY-SA 3.0", "https://creativecommons.org/licenses/by-sa/3.0/", "cc-by-sa-3.0", "MJ-PIA"),
        ("CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/", "cc-by-sa-4.0", "MJ-PIA"),
        ("Public domain", "", "public-domain", ""),
    ]
    for label, url, expected_code, author in cases:
        candidate = page(license_name=label, author=author)
        candidate["imageinfo"][0]["extmetadata"]["LicenseUrl"]["value"] = url
        if expected_code == "public-domain":
            candidate["revisions"][0]["slots"]["main"]["content"] = "{{PD-self}}"
        decision = commons.qualify_page(candidate, ["Category:Test"])
        assert decision.eligible, (label, decision.reason)
        assert decision.record["license"] == expected_code
        if expected_code == "public-domain":
            assert decision.record["license_url"] == "https://commons.wikimedia.org/wiki/Template:PD-self"

    pd = page(license_name="Public domain", author="")
    pd_url = "https://commons.wikimedia.org/wiki/Commons:Licensing"
    pd["imageinfo"][0]["extmetadata"]["LicenseUrl"]["value"] = pd_url
    decision = commons.qualify_page(pd, ["Category:Test"])
    assert decision.eligible
    assert decision.record["license_url"] == pd_url
    assert pd_url in decision.record["attribution"]


class MemoryClient:
    def __init__(self, pages):
        self._pages = pages
        self.downloads = 0

    def discover(self, categories):
        return commons.merge_memberships([
            (category, [{"pageid": 123, "title": "File:Solarity.ogg", "ns": 6}])
            for category in categories
        ])

    def pages(self, pageids):
        return self._pages

    def download(self, url, dest, *, expected_size, expected_sha1):
        self.downloads += 1
        body = b"original audio"
        assert len(body) == expected_size
        assert commons.hashlib.sha1(body).hexdigest() == expected_sha1
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(body)
        return expected_sha1, commons.hashlib.sha256(body).hexdigest(), len(body)


def test_import_persists_one_verified_source_and_category_overlap(tmp_path):
    candidate = page()
    body = b"original audio"
    candidate["imageinfo"][0]["size"] = len(body)
    candidate["imageinfo"][0]["sha1"] = commons.hashlib.sha1(body).hexdigest()
    candidate["imageinfo"][0]["url"] = "https://upload.wikimedia.org/solar.ogg"
    categories = ["Category:Electronic", "Category:Techno"]
    client = MemoryClient([candidate])

    report = commons.import_categories(tmp_path, client=client, categories=categories)

    assert report["unique_pages"] == 1
    assert report["discovered_memberships"] == 2
    assert len(report["imported"]) == 1
    assert client.downloads == 1
    source = __import__("json").loads((tmp_path / "sources.json").read_text())["files"][0]
    assert source["source_metadata"]["categories"] == categories
    assert source["source_metadata"]["revision_id"] == 456
    assert source["sha256"] == commons.hashlib.sha256(body).hexdigest()
    assert (tmp_path / source["path"]).read_bytes() == body
    assert (tmp_path / "commons-review.json").exists()


def test_import_dry_run_writes_review_without_audio_or_catalog(tmp_path):
    client = MemoryClient([page()])
    report = commons.import_categories(tmp_path, client=client, dry_run=True, categories=["Category:Techno"])
    assert len(report["imported"]) == 1
    assert client.downloads == 0
    assert not (tmp_path / "sources.json").exists()
    assert (tmp_path / "commons-review.json").exists()


def test_category_members_page_with_direct_files_and_continuation():
    class PagedClient(commons.CommonsClient):
        def __init__(self):
            super().__init__(delay=0)
            self.calls = []

        def api(self, params):
            self.calls.append(params)
            if "cmcontinue" not in params:
                return {
                    "query": {"categorymembers": [{"pageid": 1, "title": "File:A.ogg", "ns": 6}]},
                    "continue": {"cmcontinue": "next", "continue": "-||"},
                }
            return {"query": {"categorymembers": [{"pageid": 2, "title": "File:B.ogg", "ns": 6}]}}

    client = PagedClient()
    members = client.category_members("Category:Test")

    assert [member["pageid"] for member in members] == [1, 2]
    assert all(call["cmtype"] == "file" for call in client.calls)
    assert client.calls[1]["cmcontinue"] == "next"
    assert "rvlimit" not in client.calls[0]


def test_page_metadata_batches_ids_without_single_page_revision_options():
    class BatchClient(commons.CommonsClient):
        def api(self, params):
            self.params = params
            return {"query": {"pages": []}}

    client = BatchClient(delay=0)
    client.pages([1, 2, 3])

    assert client.params["pageids"] == "1|2|3"
    assert "extmetadata" in client.params["iiprop"]
    assert "iiextmetadatafilter" not in client.params
    assert client.params["rvprop"] == "ids|timestamp|content"
    assert "rvlimit" not in client.params


def test_import_fetches_expensive_metadata_in_small_batches(tmp_path):
    class BatchClient:
        def __init__(self):
            self.calls = []

        def discover(self, categories):
            category = next(iter(categories))
            return {
                i: {"pageid": i, "title": f"File:{i}.ogg", "categories": [category]}
                for i in range(22)
            }

        def pages(self, pageids):
            self.calls.append(pageids)
            return [page(title=f"File:{i}.ogg", pageid=i) for i in pageids]

    client = BatchClient()
    report = commons.import_categories(tmp_path, client=client, dry_run=True, categories=["Category:Test"])

    assert [len(call) for call in client.calls] == [10, 10, 2]
    assert len(report["imported"]) == 22


def test_client_waits_for_configured_interval_between_requests(monkeypatch):
    now = [10.0]
    sleeps = []

    def sleep(duration):
        sleeps.append(duration)
        now[0] += duration

    monkeypatch.setattr(commons.time, "monotonic", lambda: now[0])
    client = commons.CommonsClient(delay=1.0, sleeper=sleep)
    client._throttle()
    now[0] += 0.3
    client._throttle()

    assert len(sleeps) == 1 and abs(sleeps[0] - 0.7) < 1e-9


def test_rerun_skips_download_when_checksum_matches(tmp_path):
    candidate = page()
    body = b"original audio"
    candidate["imageinfo"][0]["size"] = len(body)
    candidate["imageinfo"][0]["sha1"] = commons.hashlib.sha1(body).hexdigest()
    client = MemoryClient([candidate])
    kwargs = {"client": client, "categories": ["Category:Techno"]}

    commons.import_categories(tmp_path, **kwargs)
    second = commons.import_categories(tmp_path, **kwargs)

    assert client.downloads == 1
    assert len(second["imported"]) == 1
    assert len(__import__("json").loads((tmp_path / "sources.json").read_text())["files"]) == 1


def test_commons_rename_replaces_old_catalog_path_by_page_identity(tmp_path):
    candidate = page()
    body = b"original audio"
    candidate["imageinfo"][0]["size"] = len(body)
    candidate["imageinfo"][0]["sha1"] = commons.hashlib.sha1(body).hexdigest()
    client = MemoryClient([candidate])
    kwargs = {"client": client, "categories": ["Category:Techno"]}
    commons.import_categories(tmp_path, **kwargs)

    renamed = page(title="File:Solarity renamed.ogg")
    renamed["imageinfo"][0]["size"] = len(body)
    renamed["imageinfo"][0]["sha1"] = commons.hashlib.sha1(body).hexdigest()
    client._pages = [renamed]
    commons.import_categories(tmp_path, **kwargs)

    files = __import__("json").loads((tmp_path / "sources.json").read_text())["files"]
    assert len(files) == 1
    assert files[0]["path"].endswith("Solarity renamed.ogg")
    assert files[0]["source_metadata"]["pageid"] == 123


def test_download_verifies_checksum_and_removes_partial_file(tmp_path):
    class Response:
        def __init__(self, body):
            self.body = body
            self.position = 0

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def read(self, size=-1):
            if self.position >= len(self.body):
                return b""
            chunk = self.body[self.position : self.position + size]
            self.position += len(chunk)
            return chunk

    body = b"audio bytes"
    client = commons.CommonsClient(delay=0, opener=lambda *_args, **_kwargs: Response(body))
    dest = tmp_path / "nested" / "audio.ogg"
    sha1, sha256, size = client.download(
        "https://example.test/audio.ogg", dest,
        expected_size=len(body), expected_sha1=commons.hashlib.sha1(body).hexdigest(),
    )
    assert dest.read_bytes() == body
    assert (sha1, sha256, size) == (
        commons.hashlib.sha1(body).hexdigest(), commons.hashlib.sha256(body).hexdigest(), len(body)
    )

    bad_dest = tmp_path / "nested" / "bad.ogg"
    try:
        client.download("https://example.test/bad.ogg", bad_dest, expected_size=None, expected_sha1="bad")
    except ValueError as error:
        assert "sha1 mismatch" in str(error)
    else:
        raise AssertionError("bad checksum was accepted")
    assert not bad_dest.exists()
    assert not bad_dest.with_suffix(".ogg.part").exists()


def test_download_retries_interrupted_stream_and_uses_backoff(tmp_path):
    body = b"audio bytes"
    attempts = 0
    sleeps = []

    class Response:
        def __init__(self, fail):
            self.fail = fail
            self.reads = 0

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def read(self, size=-1):
            self.reads += 1
            if self.fail and self.reads == 1:
                raise http.client.IncompleteRead(b"partial")
            return body if self.reads == 1 else b""

    def opener(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        return Response(fail=attempts == 1)

    client = commons.CommonsClient(delay=0, opener=opener, sleeper=sleeps.append)
    dest = tmp_path / "audio.ogg"
    client.download("https://example.test/audio.ogg", dest, expected_size=len(body), expected_sha1=commons.hashlib.sha1(body).hexdigest())

    assert attempts == 2
    assert sleeps == [2]
    assert dest.read_bytes() == body


def test_keyboard_interrupt_cleans_partial_audio_for_resume(tmp_path):
    class Interrupted:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def read(self, _size=-1):
            raise KeyboardInterrupt()

    dest = tmp_path / "audio.ogg"
    client = commons.CommonsClient(delay=0, opener=lambda *_a, **_k: Interrupted())
    try:
        client.download("https://example.test/audio.ogg", dest, expected_size=None, expected_sha1=None)
    except KeyboardInterrupt:
        pass
    else:
        raise AssertionError("keyboard interrupt was swallowed")
    assert not dest.exists()
    assert not dest.with_suffix(".ogg.part").exists()


def test_open_honors_retry_after_header():
    sleeps = []
    headers = Message()
    headers["Retry-After"] = "3"
    attempts = 0

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    def opener(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise urllib.error.HTTPError("https://example.test", 503, "busy", headers, None)
        return Response()

    client = commons.CommonsClient(delay=0, opener=opener, sleeper=sleeps.append)
    client.open("https://example.test")

    assert attempts == 2
    assert sleeps == [3.0]
