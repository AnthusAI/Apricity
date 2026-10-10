import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("ratings.py")
SPEC = importlib.util.spec_from_file_location("score_ratings", SCRIPT)
ratings = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ratings)


def put(folder: Path, record: dict) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{record['id']}.json").write_text(json.dumps(record))


class RatingsSearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.library = Path(self.temp.name)
        put(self.library / "Rating", {"id": "r1", "targetType": "clip", "targetId": "c1", "stars": 5, "ratedAt": "2026-09-28T00:00:00Z"})
        put(self.library / "Rating", {"id": "r2", "targetType": "clip", "targetId": "c2", "stars": 4, "ratedAt": "2026-09-27T00:00:00Z"})
        put(self.library / "Rating", {"id": "r3", "targetType": "clip", "targetId": "missing", "stars": 3, "ratedAt": "2026-09-28T00:00:00Z"})
        put(self.library / "Clip", {"id": "c1", "name": "loop-1", "sampleId": "s1", "start": 1.0, "end": 5.0, "tags": ["groovy"], "createdAt": "2026-09-01T00:00:00Z"})
        put(self.library / "Clip", {"id": "c2", "name": "break-2", "sampleId": "s2", "start": 0.0, "end": 2.5, "tags": ["drums"], "createdAt": "2026-09-20T00:00:00Z"})
        put(self.library / "Sample", {"id": "s1", "path": "house/Blue.wav", "title": "Blue House", "bpm": 124, "key": "Am"})
        put(self.library / "Sample", {"id": "s2", "path": "breaks/Red.wav", "title": "Red Break", "bpm": 98, "key": "Dm"})

    def tearDown(self):
        self.temp.cleanup()

    def test_default_order_keeps_highest_rated_first_and_reports_missing_records(self):
        rows = ratings.find_rated(self.library)
        self.assertEqual([row["what"] for row in rows], ["house/Blue.wav  loop-1", "breaks/Red.wav  break-2", "clip missing"])
        self.assertEqual(rows[-1]["detail"], "(no longer in the library)")

    def test_recent_order_and_search_and_minimum_rating(self):
        recent = ratings.find_rated(self.library, minimum=4, sort="recent")
        self.assertEqual([row["what"] for row in recent], ["breaks/Red.wav  break-2", "house/Blue.wav  loop-1"])
        recently_rated = ratings.find_rated(self.library, minimum=4, sort="rated")
        self.assertEqual([row["what"] for row in recently_rated], ["house/Blue.wav  loop-1", "breaks/Red.wav  break-2"])
        rows = ratings.find_rated(self.library, minimum=4, query="red drums", sort="recent")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["what"], "breaks/Red.wav  break-2")
        self.assertEqual(rows[0]["ratedAt"], "2026-09-27T00:00:00Z")

    def test_reads_only_clip_records_referenced_by_ratings(self):
        original = ratings.read_record
        read_paths = []

        def tracking_read(folder, record_id):
            read_paths.append((folder.name, record_id))
            return original(folder, record_id)

        with patch.object(ratings, "read_record", side_effect=tracking_read):
            ratings.find_rated(self.library)
        clip_reads = [record_id for model, record_id in read_paths if model == "Clip"]
        self.assertCountEqual(clip_reads, ["c1", "c2", "missing"])


if __name__ == "__main__":
    unittest.main()
