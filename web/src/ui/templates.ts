// What a new score starts as, by kind. A kind changes nothing in the language: a beat is a score about drums, chords a
// score about a progression, a melody a score about one line over chords.

import type { ScoreKind } from "../data/catalog";

const SONG = `# A new Apricity score. Every edit recompiles; press play (or Space) to hear it.
tempo 100
key F mixolydian
samples ../samples

clip groove = marine-band/stems/Thunderer/drums.wav  pick 2bars  warp beats
clip horns  = marine-band/stems/Thunderer/other.wav  pick 1bar

chords I7 IV7 I7 . | IV7 . I7 . | V7 IV7 I7 V7

track groove  transpose 0
track horns   follow
`;

const BEAT = `# A new beat: one-shots on a kit, played as sixteenth-note steps.
tempo 96
key C major   # required by the language; unused, since drums are unpitched
samples ../samples
bars 2

clip kick  = salamander-drumkit/OH/kick_OH_F_1.wav         warp repitch
clip snare = salamander-drumkit/OH/snare_OH_F_1.wav        warp repitch
clip ghost = salamander-drumkit/OH/snare_OH_Ghost_1.wav    warp repitch
clip hat   = salamander-drumkit/OH/hihatClosed_OH_F_1.wav  warp repitch

kit drums
  kick  = kick
  snare = snare
  ghost = ghost
  hat   = hat

track drums      steps "kick . . . snare . . ghost | . . kick . snare . . . | kick . . . snare . . ghost | . . kick . snare . kick ."  swing 56  volume -3
track drums.hat  steps "x . x . x . x . | x . x . x . x . | x . x . x . x . | x . x . x . x ."  swing 56  volume -9
`;

const CHORDS = `# A new chord progression. Pick chords on the harp; each string is a clip with a job: follow moves
# it with the chord root, a role (root, third, fifth…) asks the solver to put its center on that chord tone.
tempo 100
key F mixolydian   # dominant sevenths count as in-key
samples ../samples

clip tuba  = marine-band/stems/WashingtonPost/bass.wav   pick 1bar
clip horns = marine-band/stems/WashingtonPost/other.wav  pick 1bar
clip bugle = citizen-dj/loc-jukebox-popular/Army-bugle-calls_jukebox-118367_001_00-00-56.wav  pick 1bar

chords I7 . IV7 . | I7 . V7 IV7

track tuba   follow
track horns  role third  volume -2
track bugle  role fifth  volume -6
`;

const MELODY = `# A new melody: one line over the chords. (Note-by-note melodies are coming; for now a clip follows the chords.)
tempo 92
key Bb major
samples ../samples

clip lead = marine-band/stems/Thunderer/other.wav  pick 1bar

chords I . vi . | IV . V .

track lead  follow
`;

export const TEMPLATES: Record<ScoreKind, string> = { song: SONG, beat: BEAT, chords: CHORDS, melody: MELODY };

/** Labels for each kind, as tabs and buttons say them. */
export const KIND_LABEL: Record<ScoreKind, { one: string; many: string }> = {
  song: { one: "score", many: "scores" },
  beat: { one: "beat", many: "beats" },
  chords: { one: "chords", many: "chords" },
  melody: { one: "melody", many: "melodies" },
};
