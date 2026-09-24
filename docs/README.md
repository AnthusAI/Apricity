# Apricity documentation

Apricity is a mashup machine: it makes music out of recordings. You describe a piece — tempo, key, a chord progression, which
clips play when — and Apricity warps every clip onto one beat grid and transposes each one so that,
together, they sound the chords you asked for.

| Page | Read it when… |
|---|---|
| [Concepts](concepts.md) | you want the mental model: clips, beats, regions, the harmony solver, how a score becomes sound |
| [The Apricity language](language.md) | you're writing a `.apr` score (the compact text format) |
| [YAML scores](yaml.md) | you'd rather write (or generate) scores as YAML/JSON |
| [Chords and keys](chords.md) | you want to know every chord and key you can write |
| [Tools](tools.md) | you're running the analyzer, stems, the `apricity` command or the web app |
| [Glossary](glossary.md) | a word means something specific here and you want the exact meaning |

A first score, in the text language:

```apr
tempo 100
key F mixolydian
samples ../samples

clip tuba  = marine-band/stems/WashingtonPost/bass.wav   pick 1bar
clip horns = marine-band/stems/WashingtonPost/other.wav  pick 1bar

chords I7 IV7 I7 . | IV7 . I7 . | V7 IV7 I7 V7

track tuba   follow
track horns  follow  bars 5-12  gain -2
```

The same score as YAML is in [YAML scores](yaml.md#the-same-score-both-ways). Both formats compile to
exactly the same thing; `apricity fmt` converts between them.
