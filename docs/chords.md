# Chords and keys

Everything you can write for a `key` or a chord, in either score format.

## Notes

A note is a letter `A`–`G` (either case) followed by any number of flats (`b` or `♭`) or sharps
(`#` or `♯`): `C`, `F#`, `Bb`, `E♭`, `Cb` (= B), `Abb` (= G).

Apricitus works with **pitch classes** — the 12 notes regardless of octave — so enharmonic spellings are
the same note (`F#` = `Gb`). When Apricitus prints notes it spells them with flats (`Db`, `Eb`, `Gb`,
`Ab`, `Bb`), which is what brass-band keys usually want.

## Keys

A key is a note, then a mode:

| Write | Mode |
|---|---|
| `C`, `C major`, `C maj`, `C ionian` | major |
| `Cm`, `C minor`, `C min`, `C aeolian` | natural minor |
| `C harmonic minor` (or `harmonic_minor`, `harm`) | harmonic minor |
| `C melodic minor` (or `melodic_minor`, `mel`) | melodic minor (ascending) |
| `C dorian` | dorian |
| `C phrygian` | phrygian |
| `C lydian` | lydian |
| `C mixolydian` (or `mixo`) | mixolydian |
| `C locrian` | locrian |

The key does two jobs:

1. **Roman numerals are built on its scale.** In `A♭ minor`, `VI` is F♭ major (Apricitus prints it as E).
2. **It defines "in key" for the harmony solver.** Notes outside the scale count as clashes. For a
   blues, `mixolydian` is usually the right choice: its flat seventh (E♭ in F) is in-key.

Each key also has a **Camelot code** (shown in the library): C major is 8B, A minor 8A, and moving
one step round the wheel is a fifth up or down — the classic DJ guide to keys that mix well. Modes
use the code of their major or minor counterpart (D dorian reads as D minor, 7A).

## Roman numerals

A roman numeral names a chord by its place in the key: `I` is built on the first note of the scale,
`IV` on the fourth, and so on. They make progressions portable — `I7 IV7 V7` is a blues in any key.

**The numeral chooses the root; its case chooses major or minor.**

| | Root | Quality |
|---|---|---|
| `IV` | the key's 4th degree | major (uppercase) |
| `iv` | the key's 4th degree | minor (lowercase) |

So in A♭ minor, `iv` is D♭ minor (D♭ F♭ A♭) and `IV` is D♭ major (D♭ F A♭). Either is allowed in
any key — `V` in a minor key gives the major dominant that minor-key music usually uses.

Degrees follow the key's own scale, so in minor keys `III`, `VI` and `VII` sit a half step lower than
in major. Numerals are `I II III IV V VI VII` / `i ii iii iv v vi vii`; mixed case (`Iv`) is an error.

**Accidentals** in front move the root: `bVI` (a half step below the 6th degree — A♭ in C major),
`#iv`, `bVII`. They're counted from the key's scale.

**After the numeral**, a suffix sets the chord type:

| Suffix | Uppercase numeral | Lowercase numeral |
|---|---|---|
| *(none)* | major triad | minor triad |
| `7` | dominant 7th (`V7`) | minor 7th (`ii7`) |
| `maj7`, `Maj7`, `M7`, `Δ`, `Δ7` | major 7th (`Imaj7`) | minor-major 7th |
| `o`, `°`, `dim` | diminished triad | diminished triad (`vii°`) |
| `o7`, `°7`, `dim7` | diminished 7th | diminished 7th (`viio7`) |
| `ø`, `ø7` | half-diminished 7th | half-diminished 7th (`viiø7`) |
| `7b5`, `7♭5` | *(not supported — see below)* | half-diminished 7th |
| `+`, `aug` | augmented triad | augmented triad |
| `sus4`, `sus` | suspended 4th | suspended 4th |
| `sus2` | suspended 2nd | suspended 2nd |

**Secondary chords**: `V/V` means "the V chord of the key whose tonic is this key's V". In C, `V/V`
is D major and `V7/ii` is A7. The part after `/` is read in the score's key; the part before it is
read in the major key built on that chord's root.

## Chord symbols

Anything that doesn't start like a roman numeral is read as a chord symbol: a [note](#notes), then a
suffix.

| Suffix | Chord | Example |
|---|---|---|
| *(none)* | major | `Eb` |
| `m`, `min`, `-` | minor | `Dbm`, `C-` |
| `7` | dominant 7th | `Bb7` |
| `m7`, `min7`, `-7` | minor 7th | `Fm7` |
| `maj7`, `Maj7`, `M7`, `Δ` | major 7th | `Abmaj7` |
| `mMaj7`, `mmaj7` | minor-major 7th | `CmMaj7` |
| `m7b5`, `ø` | half-diminished 7th | `Bm7b5` |
| `dim`, `o`, `°` | diminished triad | `F#dim` |
| `dim7`, `o7`, `°7` | diminished 7th | `Bdim7` |
| `aug`, `+` | augmented | `Caug` |
| `sus4`, `sus`, `sus2` | suspended | `Gsus4` |

Chord symbols ignore the key (`Dbm` is always D♭ minor), but the key still decides what counts as a
clash.

## Chord tones and roles

Each chord has a **root**, **third**, **fifth** and, for sevenths, a **seventh**. A track's `role`
asks the harmony solver to land the clip's root on one of them. For suspended chords the "third" is
the suspended note (the 2nd or 4th).

## Not supported (yet)

- **Inversions and figured bass** (`I6`, `V65`, `I64`) — write the root-position chord. The bass note
  isn't controlled separately.
- **Slash chords** like `C/G` — the `/` is only for secondary chords (`V/V`).
- **Extensions and alterations**: 6, 9, 11, 13, add9, 7♯9, 7♭5 (dominant with a flat fifth) and so on.
  Use the nearest seventh chord.
- **Key changes** within a score — one key per score (roman numerals can still borrow: `bVII`, `V/V`).
