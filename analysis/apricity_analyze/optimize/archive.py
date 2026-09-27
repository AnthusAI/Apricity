"""MAP-Elites archive (spec section 3b): cells `role x register x source_family`
(`genome.Genome.cell()`), each keeping its top `capacity` genomes by composite `J`. Deterministic
given a fixed insertion order (the caller sorts candidates by genome hash before inserting, per
the spec's reproducibility rule -- see `scripts/optimize.py`)."""

from __future__ import annotations

import dataclasses


@dataclasses.dataclass
class Entry:
    genome: object          # genome.Genome
    J: float
    composite: object       # objective.Composite
    terms: object            # surrogate.SurrogateTerms


class Archive:
    def __init__(self, capacity: int = 2):
        self.capacity = capacity
        self.cells: dict[tuple, list[Entry]] = {}

    def insert(self, genome, J: float, composite, terms) -> bool:
        """Insert; keep at most `capacity` per cell, best `J` first. Returns whether it made the
        cut (for the caller's bookkeeping/logging)."""
        cell = genome.cell()
        bucket = self.cells.setdefault(cell, [])
        bucket.append(Entry(genome=genome, J=J, composite=composite, terms=terms))
        bucket.sort(key=lambda e: -e.J)
        del bucket[self.capacity:]
        return any(e.genome is genome for e in bucket)

    def all_entries(self) -> list[Entry]:
        out = []
        for bucket in self.cells.values():
            out.extend(bucket)
        return out

    def elites(self) -> list[Entry]:
        """One representative (the best) per cell."""
        return [bucket[0] for bucket in self.cells.values() if bucket]

    def top_n(self, n: int, *, max_per_source: int | None = None, min_per_role: bool = False,
              key_fn=None, max_per_key: int | None = None) -> list[Entry]:
        """Best `n` entries overall (spec 3b's L1 selection): ranked by `J`, at most
        `max_per_source` per source sample (kept for backward compatibility), and (when
        `min_per_role`) at least one per non-empty role before filling the rest by rank.

        Round 3 (per review): `key_fn`/`max_per_key` generalize the dedup key beyond just
        `genome.source` -- e.g. `key_fn=lambda e: (e.genome.source, e.genome.entry, e.genome.role)`
        diversifies by (source, entry window, role), not source alone. This was needed because
        deduping on source alone, even with the cap raised 2 -> 3, still collapsed the L1 pool to
        a handful of candidates: the top of the ranking was dominated by a few (source, window)
        combinations scoring near-identically, so a source-only cap discarded almost everything
        else regardless of how high it raised the cap (apricitus-a9ad5b round 2's report). When
        both `max_per_source` and `key_fn`/`max_per_key` are given, an entry must clear both caps."""
        ranked = sorted(self.all_entries(), key=lambda e: (-e.J, e.genome.key()))
        kept: list[Entry] = []
        seen_source: dict[str, int] = {}
        seen_key: dict = {}
        key_fn = key_fn or (lambda e: e.genome.source)

        def _take(e: Entry) -> bool:
            if max_per_source is not None and seen_source.get(e.genome.source, 0) >= max_per_source:
                return False
            if max_per_key is not None and seen_key.get(key_fn(e), 0) >= max_per_key:
                return False
            return True

        def _record(e: Entry) -> None:
            seen_source[e.genome.source] = seen_source.get(e.genome.source, 0) + 1
            seen_key[key_fn(e)] = seen_key.get(key_fn(e), 0) + 1

        if min_per_role:
            roles_present = {e.genome.role for e in ranked}
            for role in sorted(roles_present):
                for e in ranked:
                    if e.genome.role == role and e not in kept and _take(e):
                        kept.append(e)
                        _record(e)
                        break
                if len(kept) >= n:
                    break

        for e in ranked:
            if len(kept) >= n:
                break
            if e in kept or not _take(e):
                continue
            kept.append(e)
            _record(e)
        return kept[:n]
