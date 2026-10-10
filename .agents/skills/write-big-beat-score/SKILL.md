---
name: write-big-beat-score
description: "Create or refine Apricity Big Beat `.apr` scores: break-driven, sample-chopped, high-impact electronic grooves with hooks, builds, and dramatic edits. Use alongside write-score for Big Beat, Chemical Brothers-, Fatboy Slim-, Propellerheads-, or breakbeat-rave-adjacent requests."
---

# Writing Big Beat scores

Use this alongside `write-score`: it supplies Apricity syntax, palette search, audition, and render/measurement workflow. Read `docs/language.md` before writing a score.

Big Beat is sample music with a physical, rock-sized sense of impact: a loud break, one memorable hook, conspicuous edits, and motion between sections. It is not simply fast house, generic breakbeat, or a dense collage. Decide whether the brief wants playful/funky, psychedelic/menacing, or cinematic/industrial before casting sounds.

## Make a score-specific plan

Before writing `.apr`, name the hook source, tempo, and one drum identity in a sentence. Choose a different identity when making another Big Beat score in the same session: for example a loose live break, a stomping halftime rock break, a tight dance-punk sixteenth pattern, or a sparse break that blooms into toms and cymbals. Do not reuse the last score's kick/snare placement, hat grid, sample-entry order, and breakdown device together.

Map the first 16 bars before adding tracks. At minimum, specify the function of each four-bar phrase: which phrase introduces the hook, which is the fullest groove, which removes or recasts an element, and which lands the return. The answer need not be a conventional build/drop; a riff can arrive late, a break can start full and go empty, or the drums can be the hook. The plan prevents every score from becoming intro cuts → whole loop → filtered breakdown → same loop again.

### Anti-template rules

To prevent formulaic arrangements:
1. **Never copy drum patterns across sections unchanged:** If a four-bar phrase repeats the same kick/snare contour as the previous phrase, you must change at least two of: hat density (e.g. eighths to driving sixteenths), cymbal voice (hat to ride or open hat offbeats), snare embellishments (adding ghost notes or rim clicks), or tom activity.
2. **Mandatory phrase turnarounds:** Place an explicit turnaround fill or edit in the final beats of bar 4, 8, 12, and 16 (e.g. tom cascades, snare rolls, or a half-bar dropout).
3. **No static velocities:** Drum tracks must use velocity dynamics (`@35-45` for ghost notes, `@85-100` for backbeats, `[snare@75 snare@95]` for flams and rolls) rather than flat volume.
4. **Contrast before the drop:** In the bar or two before a drop or return (bar 12 or 14), drop the kick or filter the break to create negative space. Do not build tension by simply stacking more layers.

## Set the engine

Start around 100–128 BPM. The centre is a break-derived groove: a heavy downbeat, a decisive backbeat, and syncopated kicks or fills that make the bar feel like it is being pulled forward. Use straight sixteenths for tight sampled drums; add modest swing only when it helps the source's feel.

Choose one rhythm family before placing a sample, and name it in the score comment:

- **Stomping halftime:** wide kick spaces, one emphatic snare on beat 3, toms or crashes as the forward motion.
  - *Kick archetype:* `x . . . . . . . . . x . . . . .`
  - *Snare archetype:* `. . . . . . . . x _ _ _ . . . .`
- **Rolling break:** uneven kicks around a 2-and-4 snare, with ghost notes and changing hat figures.
  - *Kick archetype:* `x . . . . . x . . . x . . x . . | x . . . x . . . . . x . x . . .`
  - *Snare archetype:* `. . . . snare _ _ _ . . . . snare _ _ _ | . . ghost@42 . snare _ _ _ . ghost@38 . snare _ ghost@40 .`
- **Dance-punk drive:** straight, dense hats or ride against a sparse rock kick/snare backbone.
  - *Kick archetype:* `x . . . x . . . x . . . x . . .` with syncopated skip kicks before beat 3 or 4.
  - *Hats/Ride archetype:* continuous sixteenths `x x@60 x x@60` or eighth-note ride bell accents.
- **Stop-start funk:** a short clustered break followed by silence or a held hook; the gaps are part of the groove.
  - *Kick/Snare archetype:* high-density 2-bar funk pattern followed by an abrupt 2-beat or 1-bar mute.
- **Tom-led tribal break:** low tom and floor-tom figures are the primary rhythm, with snare as an answer rather than a metronome.
  - *Tom archetype:* low and floor toms driving sixteenth syncopation, rimshot or snare on 4 only.

### Drum-first audition gate

Build and audition a four- or eight-bar **drum-only** sketch before adding the hook.
1. Render with `.agents/skills/write-score/scripts/audition.sh <sketch.apr>`.
2. Inspect the mix report: ensure the kick transient hits cleanly, snare backbeat cuts through (−10 to −6 dB relative to master), and hats/cymbals are balanced (−18 to −24 dB).
3. Keep the chosen contour only if it has an unmistakably danceable, physical groove on its own without melodic help.

When a real drum kit is available (e.g. `salamander-drumkit`), write it as a drummer rather than falling back to one kick/snare/hat template. Start with a kick/snare contour that belongs to this score, then write the hats, ghost notes, rim answers, and fills around it. Change at least two of kick placement, snare answer, hat density, cymbal voice, or tom activity between the main groove and the next section. Use tom or snare fills to hand off between four- or eight-bar phrases. Bring in open hats, ride, crashes, and cymbal chokes only where they make a section land. The chopped sample remains the Big Beat basis; the kit gives the record its evolving physical force.

Before the final render, compare the drum-only stems for the intro, main groove, and return. If they reduce to the same kick/snare/hat contour with a different level or fill, rewrite one section rather than claiming an arrangement change.

## Cast one unmistakable hook

Choose a primary source that already has character: a guitar or keyboard riff, a vocal phrase, a brass stab, a noisy recording, or a whole-band fragment. Search by timbre with CLAP and audition swaps in the existing groove. Prefer a source that can survive repetition and can be cut into one or two contrasting phrases.

Treat samples as playable material:

- Use saved `loop-N` clips for the central riff when it already lands on the bar.
- Slice a break or phrase with `kit … = slice … into N`, `by beats`, `by transients`, or `by phrases`, then rearrange only a handful of slices into a call-and-response.
- Use `shot-N` clips for punctuation, not sustained harmony. Add `release` when a stab needs to ring through a transition.
- **Counterpoint stabs & vocal shouts:** Juxtapose the main instrumental loop with a contrasting spoken vocal clip or brass shout (classic Fatboy Slim/Chemical Brothers dynamic). Keep spoken fragments short and rhythmic.

### Tease, then reveal a recognizable phrase

When a source is iconic enough that pitch-shifting or continuous looping makes it feel wrong, use a **tease-and-reveal** phrase instead:
1. **Bars 1–2 (Micro-chops):** Trigger 1 or 2 isolated slices on rhythmic offbeats (`track riff.1 steps "x . . . . . . . x . . . . . . ."`) against a sparse drum break.
2. **Bars 3–4 (Phrase fragment):** Reveal a 2-beat or 1-bar slice (`track riff.3 steps ". . . . . . x . . . . . . . . ."`).
3. **Bar 5 (Full reveal):** Drop into the complete untransposed loop or phrase on the downbeat with the full break (`track riffloop loop bars 5-12`).

The main loop can carry chromatic notes. Choose the key and progression from its actual loud notes, test with `apricity explain`, and simplify the harmony rather than forcing it to follow a chord chart. A one-chord vamp (e.g. `chords i*16` or `chords I7*16`) is valid and often preferable when the hook is the harmonic event.

## Low end and basslock

Big Beat requires massive, uncluttered low end:
- **High-pass all melodic samples:** Apply `eq lowcut 150` to `200Hz` on every vocal, guitar, synth, or found-sound track. Melodic low end will muddy the kick and bass.
- **Lock the bassline to the kick:** When using a dedicated bass track or synth line, design its rhythm to either lock in unison with the kick downbeats or dance in the kick's rests.
- **Sub anchoring:** Keep bass notes centered and mono. Use `follow` to keep root movement cohesive with any chord changes.

## Arrange for impact

Give a finished piece a clear 16-, 24-, or 32-bar arc: establish the break and hook, pull one away, build tension through edits or filtering, then return with a changed density. Make the changes unmistakable on four- or eight-bar boundaries.

### The 16-Bar Big Beat Arc

| Phrase | Bars | Musical Function | Drum Role | Hook & Counterpoint |
|---|---|---|---|---|
| **Intro / Tease** | 1–4 | Introduce groove & tease source | Sparse break: kick/snare backbone, light hats | Stutter chops on offbeats |
| **Main Groove** | 5–8 | The drop: full impact | Full break: ghost notes, open hats, crash on 1 | Full hook loop + bassline |
| **Breakdown / Edit** | 9–12 | Dynamic contrast & tension | Kick dropout or tom-led groove; hat roll | Filter sweep (`filter lp 1800`), chops only |
| **The Return** | 13–16 | Peak energy & release | Driving ride or dense hats, crash accents, big turnaround fill | Full hook + vocal shout / counter-stab |

Useful Big Beat transitions are short and concrete: mute the kick for half or one bar, stutter a phrase, turn a break into sparse slices, reverse a held sound into a downbeat (`reverse`), switch from hats to ride, answer with a tom fill, or close and snap-open a low-pass filter (`automate filter 9=1800 12=1800 13=8k`). Choose one or two that express this record's hook; do not stack generic EDM build risers. The drama should sound like a record being physically chopped and slammed back on the turntable.

## Mix for weight and cut

Make the drum transients and bass relationship the priority. Keep the kick's low end intact, high-pass non-bass hooks, and use modest bus compression to glue rather than flatten the break (`comp 4:1 -20dB attack 20ms release 120ms mix 50%`). A dry snare or clap with a short room often reads bigger than a long wash.

Use distortion, filtering, delay, and narrow EQ cuts as purposeful colours. Brass, old recordings, and bright sampled guitars can accumulate harsh energy around 2–5 kHz; high-cut or notch a problem after the render identifies it. Master target should be punchy around −12 to −14 LUFS with a −1 dB ceiling.

## Audition and Lab workflow

1. **Audition locally:** Run `.agents/skills/write-score/scripts/audition.sh <score.apr>`. Check the mix report for balance.
2. **Measure objectively:** Run `scripts/lab measure <score.apr> --bars 1-16`. Target `objective_v2 > 100` with zero guard violations (roughness, detune, or chord coverage).
3. **Publish to the Cloud Lab:** When running a lab session, publish the candidate cycle to the cloud deployment:
   ```bash
   scripts/lab cycle --target cloud publish --lab <lab_id> <score.apr>
   ```
   This makes the score audible directly in the web app at `/labs` and `/listen` for blind listening and rating.
4. **Listening questions:** After each short render, ask whether the break has a memorable contour, whether the hook is recognisable after two repetitions, and whether the section changes feel like edits with intent. The listener decides whether it hits.
