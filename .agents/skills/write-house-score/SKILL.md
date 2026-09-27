---
name: write-house-score
description: Create or refine Apricity house and deep-house `.apr` scores, including groove, source casting, arrangement, and mix decisions specific to house music. Use alongside write-score for house, deep house, or older-Moby-style requests.
---

# Writing house scores

Use this alongside `write-score`: it supplies the shared Apricity syntax, palette search, audition loop, and render checks. Read `docs/language.md` before writing a score.

## Choose the lane

Translate the user's reference into a concrete direction before choosing clips.

| Style | Tempo | Feel | Starting point |
|---|---:|---|---|
| Deep house | 118–124 BPM | Straight 16ths; light swing 52–56 if it helps | Four-on-the-floor kick, sevenths, a chord every two bars, long shared reverb |
| House | 122–128 BPM | Straight | Four-on-the-floor kick, clap on 2 and 4, offbeat open hat |
| Older-Moby-adjacent | 118–124 BPM | Smooth and spacious | Slow harmony, sustained musical material, sparse drums, generous reverb |

If the source tempo is far away from the target, stretch it only after checking artefacts by ear. Do not change the genre to accommodate a clip.

## Cast the palette

Prioritize material that already belongs in the record: sustained organ, piano, strings, or choir for harmony; soulful vocal phrases or field recordings for character; a round bass; and soft percussion. March brass is usually a better fit for ragtime, swing, marching-band hip-hop, or chopped breaks than house.

Ratings indicate a listener's taste, not genre fit. Shortlist by timbre first, then use the general skill's neighbour search and swap audition to compare candidates in the scene.

## Build the groove and arrangement

Begin with a four- to eight-bar sketch: kick, one light percussion part, one sustained harmonic part, and a simple bass on chord roots. Leave 16th hats, answering phrases, and active bass movement until the core groove feels good.

For a finished house record, use a clear 40-bar arc unless the brief calls for another form: intro, groove, lift, breakdown, then drop. Bring elements in on four- or eight-bar boundaries. Give the drop a bar or two of breath, and use automation—especially filter sweeps and volume lanes—to make the change audible without duplicating tracks.

Use seventh chords and slow movement as a first hypothesis, then let `apricity explain` and an audition decide whether the clips actually fit. Keep loops and phrases on `transpose auto` unless the score's analysis gives a reason not to.

## Mix for warmth and space

Favor long sounds, slow harmony, sparse drums, and a shared reverb return over a loud, crowded main-room mix. Old recordings can turn brittle: high-cut brass and band material around 5–6 kHz and gently dip the 2.5 kHz area before adding compression. A round bass may measure quiet in LUFS, so check its peak as well.

Make one or two changes per listen. Keep an edit only when it improves the checker without introducing a guard violation, then let the listener decide whether the groove and emotional temperature are right.
