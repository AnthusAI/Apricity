// Syntax highlighting for Apricity score text, as static HTML (the Score editor uses CodeMirror
// with web/src/ui/apr-lang.ts; keep the word lists in step with it and crates/apricity-score/src/dsl.rs).

// ---- `apricity` code blocks: the same colors as the score editor.
const STATEMENTS = new Set(["apricity", "tempo", "time", "key", "samples", "bars", "clip", "kit", "chords", "track", "group", "return", "master"]);
const OPTIONS = new Set([
  "beats", "seconds", "pick", "root", "ratio", "warp", "slice", "by", "into", "transients", "phrases", "bar", "repitch", "complex", "texture",
  "as", "role", "follow", "transpose", "every", "at", "bars", "volume", "loop", "steps", "grid", "swing",
  "reverse", "filter", "lp", "hp", "lowpass", "highpass", "gate", "stutter", "half", "double", "speed",
  // mix lines and bus options
  "group", "lowcut", "highcut", "low", "high", "peak", "attack", "release", "knee", "makeup",
  "predelay", "damp", "mix", "feedback", "pingpong",
]);
const BLOCK_LINES = new Set(["eq", "comp", "limit", "reverb", "delay", "drive", "lofi", "noisegate", "width", "pan", "send", "loudness"]);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Score text (.apr) as HTML with `t-keyword`, `t-option`, `t-number`, `t-string`, `t-chord`,
 *  `t-comment` and `t-punct` spans: for static, read-only code (the docs, breakdowns). */
export function highlightApr(code: string) {
  return code
    .split("\n")
    .map((line) => {
      // A comment starts at a '#' outside quotes.
      let hash = -1;
      for (let i = 0, q = false; i < line.length; i++) {
        if (line[i] === '"') q = !q;
        else if (line[i] === "#" && !q) {
          hash = i;
          break;
        }
      }
      const body = hash >= 0 ? line.slice(0, hash) : line;
      const comment = hash >= 0 ? `<span class="t-comment">${esc(line.slice(hash))}</span>` : "";
      let first = true;
      let statement = "";
      const words = (body.match(/"[^"]*"?|\s+|[^\s"]+/g) ?? []).map((w) => {
        if (!w.trim()) return w;
        if (first) {
          first = false;
          statement = w;
          // Indented lines: a drum kit's pads, or a mix line under a track / master.
          const cls = /^[ \t]/.test(line) ? (BLOCK_LINES.has(w) ? "t-keyword" : "") : STATEMENTS.has(w) ? "t-keyword" : "";
          return `<span class="${cls}">${esc(w)}</span>`;
        }
        if (/^".*"?$/.test(w)) return `<span class="t-string">${esc(w)}</span>`;
        if (statement === "chords") return /^[|.%[\]()]+$/.test(w) ? `<span class="t-punct">${esc(w)}</span>` : `<span class="t-chord">${esc(w)}</span>`;
        if (OPTIONS.has(w)) return `<span class="t-option">${esc(w)}</span>`;
        if (/^([+-]?\d|[qQ]\d)/.test(w)) return `<span class="t-number">${esc(w)}</span>`;
        return esc(w);
      });
      return words.join("") + comment;
    })
    .join("\n");
}
