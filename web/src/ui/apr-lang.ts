// Syntax highlighting for the Apricity text language (.apr) in CodeMirror.

import { StreamLanguage, type StringStream } from "@codemirror/language";

// Keep in step with crates/apricity-score/src/dsl.rs (STATEMENTS, CLIP/TRACK options, TRACK/BUS/MASTER_LINES).
const STATEMENTS = new Set(["apricity", "tempo", "time", "key", "samples", "bars", "clip", "kit", "chords", "track", "group", "return", "master"]);
const OPTIONS = new Set([
  // clips and kits
  "beats", "seconds", "pick", "root", "ratio", "warp", "slice", "by", "into", "transients", "phrases", "bar", "repitch", "complex", "texture",
  // tracks
  "as", "role", "follow", "transpose", "every", "at", "bars", "volume", "loop", "steps", "grid", "swing",
  "reverse", "filter", "lp", "hp", "lowpass", "highpass", "gate", "stutter", "half", "double", "speed",
  // mix lines and bus options
  "group", "lowcut", "highcut", "low", "high", "peak", "attack", "release", "knee", "makeup",
  "predelay", "damp", "mix", "feedback", "pingpong",
]);
// Indented lines under a track, a bus or `master`.
const BLOCK_LINES = new Set(["eq", "comp", "limit", "reverb", "delay", "drive", "lofi", "noisegate", "width", "pan", "send", "loudness"]);

interface State {
  statement: string | null;
  indented: boolean;
}

export const aprLanguage = StreamLanguage.define<State>({
  name: "apr",
  startState: () => ({ statement: null, indented: false }),
  token(stream: StringStream, state: State) {
    if (stream.sol()) {
      state.statement = null;
      state.indented = /^[ \t]/.test(stream.string);
    }
    if (stream.eatSpace()) return null;
    if (stream.match("#")) {
      stream.skipToEnd();
      return "comment";
    }
    // A quoted step pattern: one argument, `#` inside is not a comment.
    if (stream.match(/^"[^"]*"?/)) return "string";
    if (stream.match(/^[|[\]()=]/)) return "punctuation";
    if (stream.match(/^[.%](?=\s|$)/)) return "punctuation";
    const word = stream.match(/^[^\s#[\]()|"]+/) as RegExpMatchArray | null;
    if (!word) {
      stream.next();
      return null;
    }
    const w = word[0];
    if (state.statement === null) {
      state.statement = w;
      // Indented lines are a drum kit's pads (`kick = …`) or a mix line (`eq …`), not statements.
      if (state.indented) return BLOCK_LINES.has(w) ? "keyword" : "variableName";
      return STATEMENTS.has(w) ? "keyword" : "invalid";
    }
    if (state.statement === "chords") return /\*/.test(w) ? "number" : "typeName";
    if (OPTIONS.has(w)) return "propertyName";
    if (/^([+-]?\d|[qQ]\d)/.test(w)) return "number";
    if (/[/.]/.test(w)) return "string";
    return "variableName";
  },
  languageData: { commentTokens: { line: "#" } },
});
