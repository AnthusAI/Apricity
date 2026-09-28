---
name: write-big-beat-score
description: "Create or refine Apricity Big Beat `.apr` scores: break-driven, sample-chopped, high-impact electronic grooves with hooks, builds, and dramatic edits. Use alongside write-score for Big Beat, Chemical Brothers-, Fatboy Slim-, Propellerheads-, or breakbeat-rave-adjacent requests."
---

# Writing Big Beat scores

Use this alongside `write-score`: it supplies Apricity syntax, palette search, audition, and render/measurement workflow. Read `docs/language.md` before writing a score.

Big Beat is sample music with a physical, rock-sized sense of impact: a loud break, one memorable hook, conspicuous edits, and motion between sections. It is not simply fast house, generic breakbeat, or a dense collage. Decide whether the brief wants playful/funky, psychedelic/menacing, or cinematic/industrial before casting sounds.

## Set the engine

Start around 100–128 BPM. The centre is a break-derived groove: a heavy downbeat, a decisive backbeat, and syncopated kicks or fills that make the bar feel like it is being pulled forward. Use straight sixteenths for tight sampled drums; add modest swing only when it helps the source's feel.

Build a four- or eight-bar rhythm sketch before adding a hook. A Big Beat groove needs contrast between strong hits and space; do not fill every sixteenth. If the library has a suitable drum loop, slice it by beats or transients and resequence a few hits so the break has a recognisable identity rather than repeating untouched. Otherwise, layer only the minimum kit parts needed to create a break-like contour.

## Cast one unmistakable hook

Choose a primary source that already has character: a guitar or keyboard riff, a vocal phrase, a brass stab, a noisy recording, or a whole-band fragment. Search by timbre with CLAP and audition swaps in the existing groove. Prefer a source that can survive repetition and can be cut into one or two contrasting phrases.

Treat samples as playable material:

- Use saved `loop-N` clips for the central riff when it already lands on the bar.
- Slice a break or phrase with `kit … = slice … by beats`, `by transients`, or `by phrases`, then rearrange only a handful of slices into a call-and-response.
- Use `shot-N` clips for punctuation, not sustained harmony. Add `release` when a stab needs to ring through a transition.
- A repeated spoken fragment works when it is a hook; a long archival recording under unrelated instruments usually becomes a collage. Keep a single sonic world per section.

The main loop can carry chromatic notes. Choose the key and progression from its actual loud notes, test with `apricity explain`, and simplify the harmony rather than forcing it to follow a chord chart. A one-chord vamp is valid when the hook is the harmonic event.

## Arrange for impact

Give a finished piece a clear 16-, 24-, or 32-bar arc: establish the break and hook, pull one away, build tension through edits or filtering, then return with a changed density. Make the changes unmistakable on four- or eight-bar boundaries.

Useful Big Beat transitions are short and concrete: mute the kick for half or one bar, stutter a phrase, turn a break into sparse slices, reverse a held sound into a downbeat, or close and snap-open a low-pass filter. Avoid EDM risers by default; the drama should sound like a record being cut up and thrown back in.

Keep the hook legible. If several layers compete, remove or automate one instead of making every sound louder. The final section may add one new counter-hook, but it should still feel like the same record.

## Mix for weight and cut

Make the drum transients and bass relationship the priority. Keep the kick's low end intact, high-pass non-bass hooks, and use modest bus compression to glue rather than flatten the break. A dry snare or clap with a short room often reads bigger than a long wash.

Use distortion, filtering, delay, and narrow EQ cuts as purposeful colours. Brass, old recordings, and bright sampled guitars can accumulate harsh energy around 2–5 kHz; high-cut or notch a problem after the render identifies it. Do not use extra layers or extreme limiting to manufacture impact.

## Listening questions

After each short render, ask whether the break has a memorable contour, whether the hook is recognisable after two repetitions, and whether the section changes feel like edits with intent. Measure with `apricity check` and `apricity steer`, but do not trade a great break or hook for a marginal objective gain: the listener decides whether it hits.
