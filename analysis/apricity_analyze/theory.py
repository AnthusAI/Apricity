"""Pitch classes, key profiles and key ranking over 12-bin chroma (C first)."""

from __future__ import annotations

import numpy as np

PITCH_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]

# Key profiles (tonic first). Krumhansl-Kessler probe-tone ratings and Temperley's
# Kostka-Payne corpus profile; the latter tends to suit tonal band/classical music.
PROFILES: dict[str, dict[str, np.ndarray]] = {
    "krumhansl": {
        "major": np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]),
        "minor": np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]),
    },
    "temperley": {
        "major": np.array([0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400]),
        "minor": np.array([0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330]),
    },
}


def camelot(tonic: int, mode: str) -> str:
    """Camelot wheel code: C major = 8B, A minor = 8A; a fifth up is +1."""
    major_pc = tonic if mode == "major" else (tonic + 3) % 12
    n = ((7 * major_pc) % 12 + 7) % 12 + 1
    return f"{n}{'B' if mode == 'major' else 'A'}"


def rank_keys(pcp: np.ndarray, profile: str = "temperley") -> list[dict]:
    """All 24 keys ranked by Pearson correlation of `pcp` with the rotated profile."""
    pcp = np.asarray(pcp, dtype=float)
    out = []
    if not np.any(pcp > 0):
        return out
    for mode in ("major", "minor"):
        prof = PROFILES[profile][mode]
        for tonic in range(12):
            r = float(np.corrcoef(pcp, np.roll(prof, tonic))[0, 1])
            out.append({"tonic": PITCH_NAMES[tonic], "mode": mode, "strength": round(r, 4),
                        "camelot": camelot(tonic, mode), "profile": profile})
    out.sort(key=lambda k: -k["strength"])
    return out
