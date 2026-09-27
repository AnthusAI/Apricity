---
name: write-mushroom-jazz-score
description: "Create or refine Apricity mushroom-jazz `.apr` scores: warm, downtempo, dancefloor-friendly blends of jazz, hip-hop, house, soul, and dub. Use alongside write-score for Mushroom Jazz or Mark Farina-adjacent requests."
---

# Writing mushroom-jazz scores

Use this alongside `write-score`: it supplies the shared Apricity syntax, sample search, audition loop, and render checks. Read `docs/language.md` before writing a score.

Mushroom jazz is a mood and a DJ-set flow, not a rigid recipe: jazzy and organic but still hip-hop-rooted, unhurried but moving forward, warm rather than sleepy. Let the user's brief set the emotional direction—sunlit, smoky, playful, late-night, or dubby.

## Set the pocket

Start around 84–102 BPM: slow enough for a laid-back head-nod, fast enough to feel dancefloor-friendly. A straight beat with a slightly behind-the-beat feel is the default; introduce gentle swing only when the drum source supports it.

Build a compact pocket first: a rounded kick, a dry or restrained snare/clap, a loose hat or shaker, and a bass line with space between phrases. Favor a hip-hop break or understated house pulse over a full four-on-the-floor pattern. The groove should roll continuously rather than announce a big drop.

## Cast organic, soulful material

Look for mellow piano, Rhodes-like keys, guitar, vibraphone, flute, upright or rounded electric bass, muted brass, warm strings, and short soulful vocal fragments. Field recordings and spoken snippets can create scene-setting texture when they do not compete with the rhythm.

Use jazz harmony as color, not density: seventh, ninth, suspended, and minor chords work well when the sampled material supports them. Keep chord movement patient and test it with `apricity explain`; a sampled loop with strong chromatic notes may need a simpler progression, a different source, or an EQ notch rather than extra chords.

The genre blends sources rather than forcing every sound to be "jazz." A small hip-hop drum loop, a dubwise echo, and one soulful harmonic layer often say more than a busy arrangement.

## Arrange like a continuous mix

Make transitions feel inevitable. Begin with an atmosphere, a harmonic fragment, or filtered drums; establish the full pocket gradually; then trade one focal texture for another without a hard reset. Eight- or sixteen-bar scenes work well, but preserve a common rhythmic or bass thread while changing sections.

Use automation for gentle handoffs: fade a loop, roll a low-pass or high-pass filter, briefly open space around a vocal phrase, or let a delayed chord trail into the next scene. Avoid EDM-style risers and impact drops unless the user explicitly asks for them.

## Mix warm and close

Keep drums present, bass soft-edged, and the harmonic layer clear enough to feel human. Favor a mostly dry, intimate mix with one or two deliberate spaces: a short room for drums, a dub delay on a transition, or a small amount of plate/room around keys or vocal phrases. High-pass transitional effects can help a part leave without cluttering the next one.

Protect the midrange. Old-recording brass, guitar, and keys can build harshness around 2–5 kHz; high-cut or notch only after the render identifies a real problem. Do not turn every element into haze with reverb.

## Listening questions

After each short render, ask whether the beat nods instead of drags, whether the bass and kick share the pocket, and whether a new texture feels like the next record in a continuous set. Revise one idea at a time and prioritize the listener's sense of warmth, ease, and forward motion over a maximal checker score.
