import numpy as np

from apricity_analyze import analyze


def test_rhythm_falls_back_to_essentia_for_unsupported_file_loader(monkeypatch, tmp_path):
    class FileLoader:
        def __call__(self, _path):
            raise RuntimeError("container is not readable by libsndfile")

    monkeypatch.setattr(analyze, "_beat_tracker", FileLoader())

    import essentia.standard as es
    from beat_this.inference import Audio2Beats

    signal = np.zeros((44_100, 2), dtype=np.float32)
    monkeypatch.setattr(es, "AudioLoader", lambda **_: lambda: (signal, 44_100, 2, None, None))
    monkeypatch.setattr(
        Audio2Beats,
        "__call__",
        lambda _self, _signal, _sr: (np.arange(0.0, 2.5, 0.5), np.array([0.0, 2.0])),
    )

    result = analyze.rhythm(tmp_path / "ogg-flac.oga")

    assert result["bpm"] == 120.0
    assert result["meter"] == 4
    assert result["warp_markers"]
