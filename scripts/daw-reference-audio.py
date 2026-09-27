#!/usr/bin/env python3
"""Write the tiny synthetic WAVs that the DAW reference sets point to.

The reference sets under crates/apricity-daw/tests/fixtures/reference/ never carry audio.
This script regenerates, byte for byte, the audio they were saved against:

  click-tone.wav        4 bars of 4/4 at 120 BPM (8 s), 48 kHz, 16-bit, stereo:
                        a 1 kHz click on every beat (louder on the downbeat) over a
                        440 Hz sine at -18 dBFS, so tempo, warp markers, transpose and
                        detune can be checked by ear and by analysis.
  clash/click-tone.wav  The same file name in a subfolder, different content (330 Hz,
                        clicks on the off-beats), to see how the DAW collects two
                        samples whose names clash.

Deterministic: no randomness, no timestamps; the SHA-256 of each file is printed.

Usage: python3 scripts/daw-reference-audio.py [--out renders/daw-reference]
(renders/ is git-ignored; never commit the output.)
"""

import argparse
import hashlib
import math
import struct
import wave
from pathlib import Path

RATE = 48_000
BPM = 120.0
BARS = 4
BEATS_PER_BAR = 4
CLICK_HZ = 1_000.0
CLICK_S = 0.012


def render(tone_hz: float, offbeat_clicks: bool) -> bytes:
    beats = BARS * BEATS_PER_BAR
    spb = 60.0 / BPM
    n = int(round(beats * spb * RATE))
    tone_amp = 10 ** (-18 / 20)
    frames = bytearray()
    click_len = int(CLICK_S * RATE)
    for i in range(n):
        t = i / RATE
        x = tone_amp * math.sin(2 * math.pi * tone_hz * t)
        pos = t / spb + (0.5 if offbeat_clicks else 0.0)
        beat = int(math.floor(pos))
        since = int(round((pos - beat) * spb * RATE))
        if since < click_len:
            amp = 0.7 if beat % BEATS_PER_BAR == 0 else 0.35
            env = 1.0 - since / click_len
            x += amp * env * math.sin(2 * math.pi * CLICK_HZ * since / RATE)
        s = max(-32768, min(32767, int(round(x * 32767))))
        frames += struct.pack("<hh", s, s)
    return bytes(frames)


def write(path: Path, pcm: bytes) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="renders/daw-reference", help="output folder (git-ignored)")
    out = Path(ap.parse_args().out)
    for rel, hz, off in (("click-tone.wav", 440.0, False), ("clash/click-tone.wav", 330.0, True)):
        digest = write(out / rel, render(hz, off))
        print(f"{digest}  {out / rel}")


if __name__ == "__main__":
    main()
