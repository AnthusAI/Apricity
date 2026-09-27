#!/usr/bin/env python3
"""Deterministic tiny test WAVs for the DAW sidecar fixtures (.asd / .alc).

Audio never goes in git. The reference sidecars in crates/apricity-daw/tests/fixtures/ point at these
files, so tests regenerate them byte for byte instead. Stdlib only; same bytes on every run.

    python3 scripts/daw-fixture-audio.py --out /tmp/daw-fx            # write the WAVs, print sha256
    python3 scripts/daw-fixture-audio.py --out /tmp/daw-fx --truth    # also print every click (seconds, beat)
    python3 scripts/daw-fixture-audio.py --out /tmp/daw-fx --check    # compare with fixtures/audio.sha256

All files: 44.1 kHz, 16-bit, mono. Beats are numbered the Apricity way (and the way the DAW's BeatTime
counts): beat 0 is the first downbeat (1.1.1), a pickup before it is negative. Downbeats are accented.
"""

import argparse
import hashlib
import math
import random
import struct
import sys
import wave
from pathlib import Path

RATE = 44100
LEAD = 0.25  # seconds of silence before the first click, so no event sits on sample 0
TAIL = 0.25
SEED = 0x9FB5FE  # the spike epic's id: fixed, so free-time.wav never changes
CHECK_FILE = Path(__file__).resolve().parent.parent / "crates/apricity-daw/tests/fixtures/audio.sha256"


def click(buf, at, accent):
    """A 25 ms decaying sine burst at `at` seconds: 2 kHz and louder on a downbeat, 1 kHz otherwise."""
    freq, amp = (2000.0, 0.8) if accent else (1000.0, 0.45)
    start = round(at * RATE)
    for i in range(round(0.025 * RATE)):
        if start + i < len(buf):
            t = i / RATE
            buf[start + i] += amp * math.exp(-t / 0.005) * math.sin(2 * math.pi * freq * t)


def tone(buf, start, end, freq, amp):
    """A sine from `start` to `end` seconds with 10 ms raised-cosine fades."""
    a, b = round(start * RATE), round(end * RATE)
    fade = round(0.01 * RATE)
    for i in range(a, min(b, len(buf))):
        g = 1.0
        if i - a < fade:
            g = 0.5 - 0.5 * math.cos(math.pi * (i - a) / fade)
        elif b - i < fade:
            g = 0.5 - 0.5 * math.cos(math.pi * (b - i) / fade)
        buf[i] += amp * g * math.sin(2 * math.pi * freq * (i - a) / RATE)


def steady_120():
    """One pickup beat, then 4 bars of 4/4 at 120 BPM: beats -1 .. 15 (the click at 16 ends bar 4)."""
    spb = 60.0 / 120.0
    clicks = [(LEAD + (b + 1) * spb, b) for b in range(-1, 17)]
    return clicks, LEAD + 18 * spb + TAIL, None


def tempo_change():
    """100 BPM up to beat 6.5 (mid bar 2), then 120 BPM; beats 0 .. 16."""
    def at(beat):
        if beat <= 6.5:
            return LEAD + beat * 0.6
        return LEAD + 6.5 * 0.6 + (beat - 6.5) * 0.5
    clicks = [(at(b), b) for b in range(0, 17)]
    return clicks, at(16) + TAIL, None


def detuned():
    """A sustained A4 pitched 30 cents flat (about 432.5 Hz) under soft clicks at 120 BPM, 4 bars."""
    spb = 0.5
    clicks = [(LEAD + b * spb, b) for b in range(0, 17)]
    freq = 440.0 * 2 ** (-30 / 1200)
    return clicks, LEAD + 16 * spb + TAIL, (LEAD, LEAD + 16 * spb, freq)


def free_time():
    """Clicks at seeded random gaps of 0.2 to 0.9 s for about 8 s: no beat grid (beat is None)."""
    rng = random.Random(SEED)
    t, clicks = LEAD, []
    while t < 8.0:
        clicks.append((round(t, 6), None))
        t += 0.2 + 0.7 * rng.random()
    return clicks, t + TAIL, None


FILES = {
    "steady-120.wav": steady_120,
    "tempo-change.wav": tempo_change,
    "detuned.wav": detuned,
    "free-time.wav": free_time,
}


def render(make):
    clicks, length, held = make()
    buf = [0.0] * round(length * RATE)
    if held:
        tone(buf, held[0], held[1], held[2], 0.3)
    for at, beat in clicks:
        click(buf, at, beat is not None and beat % 4 == 0)
    frames = b"".join(struct.pack("<h", max(-32767, min(32767, round(x * 32767)))) for x in buf)
    return clicks, frames


def write_wav(path, frames):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(frames)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", required=True, help="folder to write the WAVs into (created if missing)")
    ap.add_argument("--truth", action="store_true", help="print each click as seconds and beat")
    ap.add_argument("--check", action="store_true", help=f"compare sha256 with {CHECK_FILE}")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    sums = {}
    for name, make in FILES.items():
        clicks, frames = render(make)
        write_wav(out / name, frames)
        data = (out / name).read_bytes()
        sums[name] = hashlib.sha256(data).hexdigest()
        print(f"{sums[name]}  {name}  ({len(data)} bytes)")
        if args.truth:
            for at, beat in clicks:
                print(f"    {at:9.6f} s  beat {'-' if beat is None else beat}")
    if args.check:
        if not CHECK_FILE.exists():
            sys.exit(f"no {CHECK_FILE} yet (it arrives with the apricity-daw crate)")
        want = {}
        for line in CHECK_FILE.read_text().splitlines():
            if line.strip():
                digest, name = line.split()[:2]
                want[name] = digest
        bad = [n for n in FILES if want.get(n) != sums[n]]
        if bad:
            sys.exit("sha256 differs for: " + ", ".join(bad))
        print("all match", CHECK_FILE)


if __name__ == "__main__":
    main()
